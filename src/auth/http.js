import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, createHmac, randomBytes, randomInt, webcrypto } from "node:crypto";

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_REQUEST_MAX_ATTEMPTS = 3;
export const DEFAULT_REQUEST_RETRY_BACKOFF_MS = 250;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const CIRCUIT_BREAKER_STALE_WINDOW_MS = CIRCUIT_BREAKER_COOLDOWN_MS * 4;
const MAX_CIRCUIT_BREAKER_BUCKETS = 64;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_DELAY_MS = 15_000;
const MAX_EXPONENTIAL_RETRY_DELAY_MS = 15_000;
const MIN_JITTER_RETRY_DELAY_MS = 100;
const RANDOM_JITTER_BUCKETS = 1000;
const MIN_RANDOM_JITTER_RATIO = 0.25;
const RATE_LIMIT_CIRCUIT_THRESHOLD = 2;
const RATE_LIMIT_CIRCUIT_COOLDOWN_MS = 60_000;
const MAX_REQUEST_BODY_BYTES = 256_000;
const MAX_RESPONSE_BODY_BYTES = 1_000_000;
const MAX_ERROR_RESPONSE_BODY_BYTES = 128_000;
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const AUTH_HTTP_SHARED_STATE_DIR_ENV = "SENTINELAYER_AUTH_HTTP_STATE_DIR";
const AUTH_HTTP_SHARED_STATE_FILENAME = "circuit-breaker-state.v1.json";
const AUTH_HTTP_SHARED_STATE_RELOAD_INTERVAL_MS = 750;
const AUTH_HTTP_SHARED_STATE_LOCK_WAIT_MS = 1_500;
const AUTH_HTTP_SHARED_STATE_LOCK_RETRY_MIN_MS = 15;
const AUTH_HTTP_SHARED_STATE_LOCK_RETRY_MAX_MS = 75;
const AUTH_HTTP_SHARED_STATE_LOCK_STALE_MS = 10_000;

const circuitBreakerStates = new Map();
const REQUEST_JITTER_STARTUP_SECRET = initializeRequestJitterStartupSecret();
const REQUEST_JITTER_SHARED_SALT = initializeSharedRequestJitterSalt();
let sharedCircuitBreakerLastLoadedEpochMs = 0;
let sharedCircuitBreakerPersistPromise = null;

function resolveCsprngSource() {
  if (
    globalThis.crypto &&
    typeof globalThis.crypto === "object" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    return globalThis.crypto;
  }
  if (webcrypto && typeof webcrypto.getRandomValues === "function") {
    return webcrypto;
  }
  return null;
}

function secureRandomBuffer(length) {
  const normalizedLength = Math.max(1, Math.floor(Number(length) || 0));
  try {
    return randomBytes(normalizedLength);
  } catch {
    const csprng = resolveCsprngSource();
    if (!csprng) {
      return null;
    }
    const bytes = new Uint8Array(normalizedLength);
    csprng.getRandomValues(bytes);
    return Buffer.from(bytes);
  }
}

function secureRandomIntInclusive(minInclusive, maxInclusive) {
  const min = Math.floor(Number(minInclusive));
  const max = Math.floor(Number(maxInclusive));
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("Invalid secure random integer bounds.");
  }
  if (max <= min) {
    return min;
  }
  const span = max - min + 1;
  try {
    return randomInt(min, max + 1);
  } catch {
    const maxUint32PlusOne = 0x1_0000_0000;
    const rejectionLimit = maxUint32PlusOne - (maxUint32PlusOne % span);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const randomChunk = secureRandomBuffer(4);
      if (!randomChunk || randomChunk.length < 4) {
        break;
      }
      const candidate = randomChunk.readUInt32BE(0);
      if (candidate < rejectionLimit) {
        return min + (candidate % span);
      }
    }
  }
  return min;
}

function initializeRequestJitterStartupSecret() {
  return secureRandomBuffer(32);
}

function initializeSharedRequestJitterSalt() {
  if (!REQUEST_JITTER_STARTUP_SECRET) {
    return null;
  }
  return createHmac("sha256", REQUEST_JITTER_STARTUP_SECRET)
    .update("shared-retry-jitter-salt")
    .digest("hex");
}

export function getSharedRequestJitterSalt(scope = "global") {
  if (!REQUEST_JITTER_SHARED_SALT) {
    throw new Error(
      "Unable to initialize retry jitter entropy. Restart CLI with CSPRNG support enabled."
    );
  }
  const normalizedScope = String(scope || "global").trim().toLowerCase() || "global";
  return createHash("sha256")
    .update(`${REQUEST_JITTER_SHARED_SALT}:${normalizedScope}`)
    .digest("hex");
}

function normalizeApiError(errorPayload = {}) {
  if (!errorPayload || typeof errorPayload !== "object" || Array.isArray(errorPayload)) {
    return {
      code: "UNKNOWN",
      message: "Unknown API error",
      requestId: null,
    };
  }
  return {
    code: String(errorPayload.code || "UNKNOWN"),
    message: String(errorPayload.message || "Unknown API error"),
    requestId: sanitizeRequestId(errorPayload.request_id ?? errorPayload.requestId ?? null),
  };
}

function sanitizeRequestId(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length > MAX_REQUEST_ID_LENGTH) {
    return null;
  }
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

export class SentinelayerApiError extends Error {
  constructor(message, { status = 500, code = "UNKNOWN", requestId = null, retryAfterMs = null } = {}) {
    super(String(message || "Sentinelayer API error"));
    this.name = "SentinelayerApiError";
    this.status = Number(status || 500);
    this.code = String(code || "UNKNOWN");
    this.requestId = sanitizeRequestId(requestId);
    this.retryAfterMs = Number.isFinite(Number(retryAfterMs)) ? Number(retryAfterMs) : null;
  }
}

function normalizePositiveInteger(rawValue, fallbackValue) {
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.floor(normalized);
}

function normalizeUnknownError(error, { timedOut = false, externalAbort = false } = {}) {
  if (error instanceof SentinelayerApiError) {
    return error;
  }
  if (error && typeof error === "object" && error.name === "AbortError") {
    if (externalAbort && !timedOut) {
      return new SentinelayerApiError("Request canceled by caller.", {
        status: 499,
        code: "CLIENT_ABORTED",
      });
    }
    return new SentinelayerApiError("Request timed out.", {
      status: 408,
      code: "TIMEOUT",
    });
  }
  return new SentinelayerApiError(
    error instanceof Error ? error.message : String(error || "Request failed"),
    {
      status: 503,
      code: "NETWORK_ERROR",
    }
  );
}

function resolveCircuitBreakerScope(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "global";
  }
}

function resolveAuthHttpSharedStateDirectory() {
  const explicitDirectory = String(process.env[AUTH_HTTP_SHARED_STATE_DIR_ENV] || "").trim();
  if (explicitDirectory) {
    return explicitDirectory;
  }
  return path.join(os.homedir(), ".sentinelayer", "auth");
}

function resolveAuthHttpSharedStateFilePath() {
  const stateDirectory = path.resolve(resolveAuthHttpSharedStateDirectory());
  return path.join(stateDirectory, AUTH_HTTP_SHARED_STATE_FILENAME);
}

function resolveAuthHttpSharedStateLockPath() {
  return `${resolveAuthHttpSharedStateFilePath()}.lock`;
}

function isUncPath(candidatePath) {
  return process.platform === "win32" && String(candidatePath || "").startsWith("\\\\");
}

function assertPrivatePathPermissions(stats, label) {
  if (process.platform === "win32") {
    return;
  }
  const mode = Number(stats?.mode || 0);
  if (Number.isFinite(mode) && (mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group/world writable.`);
  }
}

async function assertSecureSharedStateDirectory({ create = false } = {}) {
  const stateDirectory = path.resolve(resolveAuthHttpSharedStateDirectory());
  if (isUncPath(stateDirectory)) {
    throw new Error(
      `${AUTH_HTTP_SHARED_STATE_DIR_ENV} must not point to a UNC/network path.`
    );
  }
  if (create) {
    await fsp.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  }
  try {
    const stateDirectoryStats = await fsp.lstat(stateDirectory);
    if (stateDirectoryStats.isSymbolicLink()) {
      throw new Error("Auth HTTP shared-state directory must not be a symbolic link.");
    }
    if (!stateDirectoryStats.isDirectory()) {
      throw new Error("Auth HTTP shared-state path must resolve to a directory.");
    }
    assertPrivatePathPermissions(stateDirectoryStats, "Auth HTTP shared-state directory");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return stateDirectory;
    }
    throw error;
  }
  return stateDirectory;
}

async function assertSecureSharedStateFile(filePath, { allowMissing = true } = {}) {
  const resolvedFilePath = path.resolve(String(filePath || ""));
  if (isUncPath(resolvedFilePath)) {
    throw new Error("Auth HTTP shared-state files must not use UNC/network paths.");
  }
  try {
    const stateFileStats = await fsp.lstat(resolvedFilePath);
    if (stateFileStats.isSymbolicLink()) {
      throw new Error(`Auth HTTP shared-state file '${resolvedFilePath}' must not be a symbolic link.`);
    }
    if (!stateFileStats.isFile()) {
      throw new Error(`Auth HTTP shared-state file '${resolvedFilePath}' must be a regular file.`);
    }
    assertPrivatePathPermissions(stateFileStats, `Auth HTTP shared-state file '${resolvedFilePath}'`);
  } catch (error) {
    if (allowMissing && error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function normalizeCircuitBreakerSnapshotState(rawState = {}, nowEpochMs = Date.now()) {
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
    return null;
  }
  const touchedAtEpochMs = Number(rawState.touchedAtEpochMs || 0);
  if (!Number.isFinite(touchedAtEpochMs) || touchedAtEpochMs <= 0) {
    return null;
  }
  if (nowEpochMs - touchedAtEpochMs > CIRCUIT_BREAKER_STALE_WINDOW_MS) {
    return null;
  }
  const consecutiveFailures = Math.max(0, Math.floor(Number(rawState.consecutiveFailures || 0)));
  const consecutiveRateLimits = Math.max(0, Math.floor(Number(rawState.consecutiveRateLimits || 0)));
  const openedAtEpochMs = Math.max(0, Math.floor(Number(rawState.openedAtEpochMs || 0)));
  const rateLimitOpenedAtEpochMs = Math.max(
    0,
    Math.floor(Number(rawState.rateLimitOpenedAtEpochMs || 0))
  );
  const rateLimitCooldownMs = Math.max(
    RATE_LIMIT_CIRCUIT_COOLDOWN_MS,
    Math.floor(Number(rawState.rateLimitCooldownMs || RATE_LIMIT_CIRCUIT_COOLDOWN_MS))
  );
  return {
    consecutiveFailures,
    consecutiveRateLimits,
    openedAtEpochMs,
    rateLimitOpenedAtEpochMs,
    rateLimitCooldownMs,
    touchedAtEpochMs,
  };
}

function mergeCircuitBreakerState(targetState, incomingState = {}, nowEpochMs = Date.now()) {
  const normalizedIncoming = normalizeCircuitBreakerSnapshotState(incomingState, nowEpochMs);
  if (!normalizedIncoming) {
    return targetState;
  }
  targetState.consecutiveFailures = Math.max(
    Math.floor(Number(targetState.consecutiveFailures || 0)),
    normalizedIncoming.consecutiveFailures
  );
  targetState.consecutiveRateLimits = Math.max(
    Math.floor(Number(targetState.consecutiveRateLimits || 0)),
    normalizedIncoming.consecutiveRateLimits
  );
  targetState.openedAtEpochMs = Math.max(
    Math.floor(Number(targetState.openedAtEpochMs || 0)),
    normalizedIncoming.openedAtEpochMs
  );
  targetState.rateLimitOpenedAtEpochMs = Math.max(
    Math.floor(Number(targetState.rateLimitOpenedAtEpochMs || 0)),
    normalizedIncoming.rateLimitOpenedAtEpochMs
  );
  targetState.rateLimitCooldownMs = Math.max(
    RATE_LIMIT_CIRCUIT_COOLDOWN_MS,
    Math.floor(Number(targetState.rateLimitCooldownMs || RATE_LIMIT_CIRCUIT_COOLDOWN_MS)),
    normalizedIncoming.rateLimitCooldownMs
  );
  targetState.touchedAtEpochMs = Math.max(
    Math.floor(Number(targetState.touchedAtEpochMs || 0)),
    normalizedIncoming.touchedAtEpochMs
  );
  return targetState;
}

function mergeSharedCircuitBreakerSnapshot(snapshot = {}, nowEpochMs = Date.now()) {
  const scopes = snapshot && typeof snapshot === "object" ? snapshot.scopes : null;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) {
    return;
  }
  for (const [scope, rawState] of Object.entries(scopes)) {
    const normalizedScope = String(scope || "").trim();
    if (!normalizedScope) {
      continue;
    }
    const localState = getCircuitBreakerState(normalizedScope, nowEpochMs);
    mergeCircuitBreakerState(localState, rawState, nowEpochMs);
  }
  pruneCircuitBreakerStates(nowEpochMs);
}

function serializeCircuitBreakerSnapshot(nowEpochMs = Date.now()) {
  const scopes = {};
  for (const [scope, rawState] of circuitBreakerStates.entries()) {
    const normalizedScope = String(scope || "").trim();
    if (!normalizedScope) {
      continue;
    }
    const normalizedState = normalizeCircuitBreakerSnapshotState(rawState, nowEpochMs);
    if (!normalizedState) {
      continue;
    }
    scopes[normalizedScope] = normalizedState;
  }
  return {
    schemaVersion: "1.0.0",
    generatedAtEpochMs: nowEpochMs,
    scopes,
  };
}

async function readSharedCircuitBreakerSnapshot() {
  await assertSecureSharedStateDirectory({ create: false });
  const stateFilePath = resolveAuthHttpSharedStateFilePath();
  await assertSecureSharedStateFile(stateFilePath, { allowMissing: true });
  let rawSnapshot = "";
  try {
    rawSnapshot = await fsp.readFile(stateFilePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const parsed = JSON.parse(rawSnapshot);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

async function withSharedCircuitBreakerStateLock(operation) {
  const stateDirectory = await assertSecureSharedStateDirectory({ create: true });
  const lockPath = path.join(stateDirectory, `${AUTH_HTTP_SHARED_STATE_FILENAME}.lock`);
  await assertSecureSharedStateFile(lockPath, { allowMissing: true });
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const start = Date.now();
  let lockHandle = null;
  while (!lockHandle) {
    try {
      lockHandle = await fsp.open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(
        JSON.stringify({ pid: process.pid, acquiredAtEpochMs: Date.now() }, null, 2),
        "utf8"
      );
      await lockHandle.sync();
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStats = await fsp.stat(lockPath);
        const lockAgeMs = Date.now() - Number(lockStats.mtimeMs || 0);
        if (Number.isFinite(lockAgeMs) && lockAgeMs > AUTH_HTTP_SHARED_STATE_LOCK_STALE_MS) {
          await fsp.rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (!lockError || typeof lockError !== "object" || lockError.code !== "ENOENT") {
          throw lockError;
        }
      }
      if (Date.now() - start > AUTH_HTTP_SHARED_STATE_LOCK_WAIT_MS) {
        throw new Error("Timed out acquiring auth HTTP shared circuit-breaker lock.");
      }
      const delayMs =
        AUTH_HTTP_SHARED_STATE_LOCK_RETRY_MIN_MS +
        secureRandomIntInclusive(0, AUTH_HTTP_SHARED_STATE_LOCK_RETRY_MAX_MS);
      await sleep(delayMs);
    }
  }
  try {
    return await operation();
  } finally {
    try {
      await lockHandle?.close();
    } catch {
      // Best-effort close before lock cleanup.
    }
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function persistSharedCircuitBreakerSnapshot() {
  if (sharedCircuitBreakerPersistPromise) {
    return sharedCircuitBreakerPersistPromise;
  }
  sharedCircuitBreakerPersistPromise = (async () => {
    const nowEpochMs = Date.now();
    pruneCircuitBreakerStates(nowEpochMs);
    const stateDirectory = await assertSecureSharedStateDirectory({ create: true });
    const stateFilePath = path.join(stateDirectory, AUTH_HTTP_SHARED_STATE_FILENAME);
    await withSharedCircuitBreakerStateLock(async () => {
      const diskSnapshot = await readSharedCircuitBreakerSnapshot().catch(() => null);
      if (diskSnapshot) {
        mergeSharedCircuitBreakerSnapshot(diskSnapshot, nowEpochMs);
      }
      await assertSecureSharedStateFile(stateFilePath, { allowMissing: true });
      const serializedSnapshot = serializeCircuitBreakerSnapshot(nowEpochMs);
      const tempPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tempPath, JSON.stringify(serializedSnapshot, null, 2), "utf8");
      await fsp.chmod(tempPath, 0o600).catch(() => {});
      await fsp.rename(tempPath, stateFilePath);
      await fsp.chmod(stateFilePath, 0o600).catch(() => {});
    });
  })();
  try {
    await sharedCircuitBreakerPersistPromise;
  } finally {
    sharedCircuitBreakerPersistPromise = null;
  }
}

async function ensureSharedCircuitBreakerSnapshotLoaded({ force = false } = {}) {
  const nowEpochMs = Date.now();
  if (
    !force &&
    Number.isFinite(sharedCircuitBreakerLastLoadedEpochMs) &&
    nowEpochMs - sharedCircuitBreakerLastLoadedEpochMs < AUTH_HTTP_SHARED_STATE_RELOAD_INTERVAL_MS
  ) {
    return;
  }
  const snapshot = await readSharedCircuitBreakerSnapshot().catch(() => null);
  if (snapshot) {
    mergeSharedCircuitBreakerSnapshot(snapshot, nowEpochMs);
  }
  sharedCircuitBreakerLastLoadedEpochMs = nowEpochMs;
}

function createCircuitBreakerState(nowEpochMs = Date.now()) {
  return {
    consecutiveFailures: 0,
    consecutiveRateLimits: 0,
    openedAtEpochMs: 0,
    rateLimitOpenedAtEpochMs: 0,
    rateLimitCooldownMs: RATE_LIMIT_CIRCUIT_COOLDOWN_MS,
    touchedAtEpochMs: nowEpochMs,
  };
}

function getCircuitBreakerState(scope, nowEpochMs = Date.now()) {
  const normalizedScope = String(scope || "global");
  const existing = circuitBreakerStates.get(normalizedScope);
  if (existing) {
    existing.touchedAtEpochMs = nowEpochMs;
    return existing;
  }
  const created = createCircuitBreakerState(nowEpochMs);
  circuitBreakerStates.set(normalizedScope, created);
  return created;
}

function pruneCircuitBreakerStates(nowEpochMs = Date.now()) {
  for (const [scope, state] of circuitBreakerStates.entries()) {
    if (nowEpochMs - Number(state.touchedAtEpochMs || 0) > CIRCUIT_BREAKER_STALE_WINDOW_MS) {
      circuitBreakerStates.delete(scope);
    }
  }
  if (circuitBreakerStates.size <= MAX_CIRCUIT_BREAKER_BUCKETS) {
    return;
  }
  const entries = Array.from(circuitBreakerStates.entries()).sort(
    (a, b) => Number(a[1].touchedAtEpochMs || 0) - Number(b[1].touchedAtEpochMs || 0)
  );
  for (const [scope] of entries) {
    circuitBreakerStates.delete(scope);
    if (circuitBreakerStates.size <= MAX_CIRCUIT_BREAKER_BUCKETS) {
      break;
    }
  }
}

function resetCircuitBreaker(scope = null, nowEpochMs = Date.now()) {
  if (!scope) {
    circuitBreakerStates.clear();
    return;
  }
  const state = getCircuitBreakerState(scope, nowEpochMs);
  state.consecutiveFailures = 0;
  state.consecutiveRateLimits = 0;
  state.openedAtEpochMs = 0;
  state.rateLimitOpenedAtEpochMs = 0;
  state.rateLimitCooldownMs = RATE_LIMIT_CIRCUIT_COOLDOWN_MS;
  state.touchedAtEpochMs = nowEpochMs;
  pruneCircuitBreakerStates(nowEpochMs);
}

export function __resetAuthHttpCircuitBreakerForTests({ clearSharedSnapshot = true } = {}) {
  resetCircuitBreaker();
  sharedCircuitBreakerLastLoadedEpochMs = 0;
  sharedCircuitBreakerPersistPromise = null;
  if (!clearSharedSnapshot) {
    return;
  }
  try {
    fs.rmSync(resolveAuthHttpSharedStateFilePath(), { force: true });
  } catch {
    // Best-effort reset for test isolation.
  }
  try {
    fs.rmSync(resolveAuthHttpSharedStateLockPath(), { force: true });
  } catch {
    // Best-effort reset for test isolation.
  }
}

function registerCircuitFailure(scope, nowEpochMs = Date.now()) {
  const state = getCircuitBreakerState(scope, nowEpochMs);
  state.consecutiveFailures += 1;
  state.touchedAtEpochMs = nowEpochMs;
  if (
    state.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD &&
    !state.openedAtEpochMs
  ) {
    state.openedAtEpochMs = nowEpochMs;
  }
  pruneCircuitBreakerStates(nowEpochMs);
}

function registerRateLimitFailure(scope, retryAfterMs = null, nowEpochMs = Date.now()) {
  const state = getCircuitBreakerState(scope, nowEpochMs);
  state.consecutiveRateLimits = Math.max(0, Number(state.consecutiveRateLimits || 0)) + 1;
  state.touchedAtEpochMs = nowEpochMs;
  const retryAfterCooldownMs =
    Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0
      ? Math.min(Number(retryAfterMs), MAX_RETRY_AFTER_DELAY_MS)
      : 0;
  const cooldownMs = Math.max(RATE_LIMIT_CIRCUIT_COOLDOWN_MS, retryAfterCooldownMs);
  state.rateLimitCooldownMs = cooldownMs;
  if (state.consecutiveRateLimits >= RATE_LIMIT_CIRCUIT_THRESHOLD) {
    state.rateLimitOpenedAtEpochMs = nowEpochMs;
  }
  pruneCircuitBreakerStates(nowEpochMs);
}

function getRateLimitRetryAfterMs(scope, nowEpochMs = Date.now()) {
  const state = getCircuitBreakerState(scope, nowEpochMs);
  const openedAtEpochMs = Number(state.rateLimitOpenedAtEpochMs || 0);
  if (!openedAtEpochMs) {
    return 0;
  }
  const cooldownMs = Math.max(
    RATE_LIMIT_CIRCUIT_COOLDOWN_MS,
    Number(state.rateLimitCooldownMs || RATE_LIMIT_CIRCUIT_COOLDOWN_MS)
  );
  const elapsedMs = Math.max(0, nowEpochMs - openedAtEpochMs);
  return Math.max(0, cooldownMs - elapsedMs);
}

function isRateLimitCircuitOpen(scope, nowEpochMs = Date.now()) {
  const state = getCircuitBreakerState(scope, nowEpochMs);
  const openedAtEpochMs = Number(state.rateLimitOpenedAtEpochMs || 0);
  if (!openedAtEpochMs) {
    return false;
  }
  const cooldownMs = Math.max(
    RATE_LIMIT_CIRCUIT_COOLDOWN_MS,
    Number(state.rateLimitCooldownMs || RATE_LIMIT_CIRCUIT_COOLDOWN_MS)
  );
  if (nowEpochMs - openedAtEpochMs >= cooldownMs) {
    state.consecutiveRateLimits = 0;
    state.rateLimitOpenedAtEpochMs = 0;
    state.rateLimitCooldownMs = RATE_LIMIT_CIRCUIT_COOLDOWN_MS;
    state.touchedAtEpochMs = nowEpochMs;
    return false;
  }
  return true;
}

function isCircuitOpen(scope, nowEpochMs = Date.now()) {
  const state = getCircuitBreakerState(scope, nowEpochMs);
  if (!state.openedAtEpochMs) {
    return false;
  }
  const elapsedMs = nowEpochMs - state.openedAtEpochMs;
  if (elapsedMs >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    resetCircuitBreaker(scope, nowEpochMs);
    return false;
  }
  return true;
}

function shouldRetry(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return false;
  }
  if (String(error.code || "") === "CLIENT_ABORTED") {
    return false;
  }
  return RETRYABLE_STATUS_CODES.has(Number(error.status || 0));
}

function resolveMonotonicEpochMs() {
  if (
    typeof globalThis.performance === "object" &&
    Number.isFinite(Number(globalThis.performance.timeOrigin)) &&
    typeof globalThis.performance.now === "function"
  ) {
    return Number(globalThis.performance.timeOrigin) + Number(globalThis.performance.now());
  }
  return Date.now();
}

function parseRetryAfterDelayMs(rawValue, responseDateHeader = "", responseReceivedAtEpochMs = null) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_DELAY_MS);
  }

  const retryEpoch = Date.parse(normalized);
  if (!Number.isFinite(retryEpoch)) {
    return null;
  }
  const responseDateEpoch = Date.parse(String(responseDateHeader || "").trim());
  let delayMs = null;
  if (Number.isFinite(responseDateEpoch)) {
    delayMs = retryEpoch - responseDateEpoch;
  } else {
    const receivedEpoch = Number(responseReceivedAtEpochMs);
    delayMs = retryEpoch - (Number.isFinite(receivedEpoch) ? receivedEpoch : Date.now());
  }
  delayMs = Math.max(0, Number(delayMs || 0));
  return Math.min(delayMs, MAX_RETRY_AFTER_DELAY_MS);
}

function createRequestJitterSeed(url, method = "GET") {
  const entropyBuffer = secureRandomBuffer(16);
  if (!REQUEST_JITTER_STARTUP_SECRET || !entropyBuffer) {
    throw new SentinelayerApiError("Unable to initialize retry jitter entropy.", {
      status: 500,
      code: "JITTER_ENTROPY_UNAVAILABLE",
    });
  }
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  const normalizedUrl = String(url || "").trim();
  return createHmac("sha256", REQUEST_JITTER_STARTUP_SECRET)
    .update(["primary", normalizedMethod, normalizedUrl, entropyBuffer.toString("hex")].join(":"))
    .digest("hex");
}

function getRetryDelayMs(attemptIndex, retryBackoffMs, retryAfterMs = null, requestJitterSeed = "") {
  if (Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0) {
    return Math.min(Math.round(Number(retryAfterMs)), MAX_RETRY_AFTER_DELAY_MS);
  }
  const base = normalizePositiveInteger(retryBackoffMs, DEFAULT_REQUEST_RETRY_BACKOFF_MS);
  const exponentialCap = Math.min(base * (2 ** Math.max(0, attemptIndex)), MAX_EXPONENTIAL_RETRY_DELAY_MS);
  if (exponentialCap <= MIN_JITTER_RETRY_DELAY_MS) {
    return exponentialCap;
  }
  let jitterBucket = 0;
  try {
    jitterBucket = randomInt(0, RANDOM_JITTER_BUCKETS + 1);
  } catch {
    const normalizedSeed = String(requestJitterSeed || "global");
    const fallbackDigest = createHash("sha256")
      .update(`${Math.max(0, attemptIndex)}:${base}:${normalizedSeed}`)
      .digest();
    jitterBucket = fallbackDigest.readUInt16BE(0) % (RANDOM_JITTER_BUCKETS + 1);
  }
  const jitterRatio =
    MIN_RANDOM_JITTER_RATIO +
    (jitterBucket / RANDOM_JITTER_BUCKETS) * (1 - MIN_RANDOM_JITTER_RATIO);
  const jitteredDelay = Math.round(exponentialCap * jitterRatio);
  return Math.max(MIN_JITTER_RETRY_DELAY_MS, jitteredDelay);
}

function createAbortError() {
  const error = new Error("Request aborted while reading response body.");
  error.name = "AbortError";
  return error;
}

async function readResponseBodyWithLimit(
  response,
  maxBytes = MAX_RESPONSE_BODY_BYTES,
  { timeoutAtEpochMs = null, signal = null } = {}
) {
  const createBodyReadTimeoutError = () =>
    new SentinelayerApiError("Request timed out while reading response body.", {
      status: 408,
      code: "TIMEOUT",
    });

  const resolveRemainingTimeoutMs = () => {
    if (!Number.isFinite(Number(timeoutAtEpochMs))) {
      return null;
    }
    return Math.max(0, Math.floor(Number(timeoutAtEpochMs) - Date.now()));
  };

  const runWithTimeoutBudget = async (operation) => {
    const remainingMs = resolveRemainingTimeoutMs();
    if (remainingMs !== null && remainingMs <= 0) {
      throw createBodyReadTimeoutError();
    }
    const hasAbortSignal =
      signal &&
      typeof signal === "object" &&
      typeof signal.addEventListener === "function" &&
      typeof signal.removeEventListener === "function";
    if (remainingMs === null && !hasAbortSignal) {
      return operation();
    }

    let timerHandle = null;
    let onAbort = null;
    const racers = [operation()];
    if (remainingMs !== null) {
      racers.push(
        new Promise((_, reject) => {
          timerHandle = setTimeout(() => {
            reject(createBodyReadTimeoutError());
          }, remainingMs);
        })
      );
    }
    if (hasAbortSignal) {
      racers.push(
        new Promise((_, reject) => {
          onAbort = () => reject(createAbortError());
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
        })
      );
    }

    try {
      return await Promise.race(racers);
    } finally {
      if (timerHandle) {
        clearTimeout(timerHandle);
      }
      if (hasAbortSignal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  };

  const declaredLength = Number(response?.headers?.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SentinelayerApiError("API response exceeded maximum allowed size.", {
      status: 502,
      code: "RESPONSE_TOO_LARGE",
    });
  }
  if (!response?.body || typeof response.body.getReader !== "function") {
    const rawBody = await runWithTimeoutBudget(() => response.text());
    if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
      throw new SentinelayerApiError("API response exceeded maximum allowed size.", {
        status: 502,
        code: "RESPONSE_TOO_LARGE",
      });
    }
    return rawBody;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let rawBody = "";
  try {
    while (true) {
      const { done, value } = await runWithTimeoutBudget(() => reader.read());
      if (done) {
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new SentinelayerApiError("API response exceeded maximum allowed size.", {
          status: 502,
          code: "RESPONSE_TOO_LARGE",
        });
      }
      rawBody += decoder.decode(chunk, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  rawBody += decoder.decode();
  return rawBody;
}

function isPassThroughBody(body) {
  if (body === undefined || body === null) {
    return false;
  }
  if (typeof body === "string") {
    return true;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return true;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return true;
  }
  return false;
}

function assertRequestBodyWithinLimit(byteLength) {
  const normalizedBytes = Number(byteLength || 0);
  if (normalizedBytes <= MAX_REQUEST_BODY_BYTES) {
    return;
  }
  throw new SentinelayerApiError("Request body exceeded maximum allowed size.", {
    status: 413,
    code: "REQUEST_TOO_LARGE",
  });
}

function serializeRequestBody(body, requestHeaders = {}) {
  if (body === undefined) {
    return undefined;
  }
  if (isPassThroughBody(body)) {
    if (typeof body === "string") {
      assertRequestBodyWithinLimit(Buffer.byteLength(body, "utf8"));
      return body;
    }
    if (body instanceof Uint8Array) {
      assertRequestBodyWithinLimit(body.byteLength);
      return body;
    }
    if (body instanceof ArrayBuffer) {
      assertRequestBodyWithinLimit(body.byteLength);
      return body;
    }
    if (ArrayBuffer.isView(body)) {
      assertRequestBodyWithinLimit(body.byteLength);
      return body;
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      assertRequestBodyWithinLimit(Buffer.byteLength(body.toString(), "utf8"));
      return body;
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      assertRequestBodyWithinLimit(body.size);
      return body;
    }
    return body;
  }
  const contentType = String(
    requestHeaders["Content-Type"] || requestHeaders["content-type"] || ""
  )
    .trim()
    .toLowerCase();
  const expectsJson = !contentType || contentType.includes("application/json") || contentType.includes("+json");
  if (expectsJson) {
    let serializedJson = "";
    try {
      serializedJson = JSON.stringify(body);
    } catch {
      throw new SentinelayerApiError("Request body could not be JSON serialized.", {
        status: 400,
        code: "INVALID_REQUEST_BODY",
      });
    }
    assertRequestBodyWithinLimit(Buffer.byteLength(serializedJson, "utf8"));
    return serializedJson;
  }
  const serialized = String(body);
  assertRequestBodyWithinLimit(Buffer.byteLength(serialized, "utf8"));
  return serialized;
}

function composeRequestAbortSignal(controller, signal) {
  if (!signal || typeof signal !== "object") {
    return {
      activeSignal: controller.signal,
      cleanup: () => {},
    };
  }

  if (typeof AbortSignal === "function" && typeof AbortSignal.any === "function") {
    return {
      activeSignal: AbortSignal.any([controller.signal, signal]),
      cleanup: () => {},
    };
  }

  if (
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    return {
      activeSignal: controller.signal,
      cleanup: () => {},
    };
  }

  const onAbort = () => {
    controller.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    controller.abort();
  }
  return {
    activeSignal: controller.signal,
    cleanup: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function requestJson(
  url,
  {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxAttempts = DEFAULT_REQUEST_MAX_ATTEMPTS,
    retryBackoffMs = DEFAULT_REQUEST_RETRY_BACKOFF_MS,
    signal = null,
    fetchImpl = fetch,
  } = {}
) {
  const circuitScope = resolveCircuitBreakerScope(url);
  const requestJitterSeed = createRequestJitterSeed(url, method);
  await ensureSharedCircuitBreakerSnapshotLoaded();
  if (isRateLimitCircuitOpen(circuitScope)) {
    throw new SentinelayerApiError("Upstream rate limit circuit is open. Retry after cooldown.", {
      status: 429,
      code: "RATE_LIMITED",
      retryAfterMs: getRateLimitRetryAfterMs(circuitScope),
    });
  }
  if (isCircuitOpen(circuitScope)) {
    throw new SentinelayerApiError("Upstream circuit breaker is open. Retry after cooldown.", {
      status: 503,
      code: "CIRCUIT_OPEN",
    });
  }

  const attempts = normalizePositiveInteger(maxAttempts, DEFAULT_REQUEST_MAX_ATTEMPTS);
  const normalizedTimeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);

  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutAtEpochMs = Date.now() + normalizedTimeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, normalizedTimeoutMs);
    const { activeSignal, cleanup } = composeRequestAbortSignal(controller, signal);

    try {
      const requestHeaders = {
        Accept: "application/json",
        ...headers,
      };
      const hasExplicitContentType =
        requestHeaders["Content-Type"] !== undefined || requestHeaders["content-type"] !== undefined;
      if (
        body !== undefined &&
        !hasExplicitContentType &&
        !isPassThroughBody(body)
      ) {
        requestHeaders["Content-Type"] = "application/json";
      }
      const requestBody = serializeRequestBody(body, requestHeaders);
      const response = await fetchImpl(String(url), {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: activeSignal,
      });
      const responseReceivedAtEpochMs = resolveMonotonicEpochMs();

      const responseBodyLimit = response.ok ? MAX_RESPONSE_BODY_BYTES : MAX_ERROR_RESPONSE_BODY_BYTES;
      const rawBody = await readResponseBodyWithLimit(response, responseBodyLimit, {
        timeoutAtEpochMs,
        signal: activeSignal,
      });
      let json = {};
      if (rawBody.trim()) {
        try {
          json = JSON.parse(rawBody);
        } catch {
          throw new SentinelayerApiError("Invalid JSON returned by API.", {
            status: response.status,
            code: "INVALID_JSON",
          });
        }
      }

      if (!response.ok) {
        const apiError = normalizeApiError(json && typeof json === "object" ? json.error : {});
        const retryAfterMs = parseRetryAfterDelayMs(
          response.headers.get("retry-after"),
          response.headers.get("date"),
          responseReceivedAtEpochMs
        );
        throw new SentinelayerApiError(apiError.message, {
          status: response.status,
          code: apiError.code,
          requestId: apiError.requestId,
          retryAfterMs,
        });
      }

      resetCircuitBreaker(circuitScope);
      await persistSharedCircuitBreakerSnapshot().catch(() => {});
      return json;
    } catch (error) {
      const normalizedError = normalizeUnknownError(error, {
        timedOut,
        externalAbort: Boolean(signal && typeof signal === "object" && signal.aborted),
      });
      if (normalizedError.code === "CLIENT_ABORTED") {
        throw normalizedError;
      }
      const shouldRecordCircuitFailure = shouldRetry(normalizedError);
      let stateMutated = false;
      if (shouldRecordCircuitFailure) {
        registerCircuitFailure(circuitScope);
        stateMutated = true;
      }
      if (Number(normalizedError.status || 0) === 429) {
        registerRateLimitFailure(circuitScope, normalizedError.retryAfterMs);
        stateMutated = true;
        if (isRateLimitCircuitOpen(circuitScope)) {
          await persistSharedCircuitBreakerSnapshot().catch(() => {});
          throw new SentinelayerApiError(
            "Upstream rate limit circuit is open. Retry after cooldown.",
            {
              status: 429,
              code: "RATE_LIMITED",
              retryAfterMs: getRateLimitRetryAfterMs(circuitScope),
            }
          );
        }
      }
      if (stateMutated) {
        await persistSharedCircuitBreakerSnapshot().catch(() => {});
      }
      if (shouldRetry(normalizedError) && attemptIndex < attempts - 1) {
        await sleep(
          getRetryDelayMs(attemptIndex, retryBackoffMs, normalizedError.retryAfterMs, requestJitterSeed)
        );
        continue;
      }

      throw normalizedError;
    } finally {
      cleanup();
      clearTimeout(timeout);
      await sleep(0);
    }
  }

  throw new SentinelayerApiError("Request failed after retry attempts.", {
    status: 503,
    code: "MAX_RETRIES_EXHAUSTED",
  });
}
