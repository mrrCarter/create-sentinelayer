import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import open from "open";

import { loadConfig, normalizeValueForKey } from "../config/service.js";
import { getSharedRequestJitterSalt, SentinelayerApiError, requestJson } from "./http.js";
import {
  clearStoredSession,
  readStoredSession,
  readStoredSessionMetadata,
  StoredSessionError,
  writeStoredSession,
} from "./session-store.js";

const DEFAULT_API_URL = "https://api.sentinelayer.com";
/** Default maximum wall-clock wait for browser-based CLI auth approval (ms). */
export const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
/** Default lifetime for issued API tokens used by CLI sessions (days). */
export const DEFAULT_API_TOKEN_TTL_DAYS = 365;
/** Default threshold at which stored tokens are rotated before expiry (days). */
export const DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS = 7;
const DEFAULT_IDE_NAME = "sl-cli";
const DEFAULT_API_TOKEN_SCOPE = "cli_session";
const PRIVILEGED_API_TOKEN_SCOPE = "github_app_bridge";
const MIN_AUTH_POLL_INTERVAL_MS = 250;
const MAX_AUTH_POLL_ATTEMPTS = 300;
const MAX_AUTH_POLL_BACKEND_FAILURES = 4;
const MAX_AUTH_POLL_BACKEND_BACKOFF_MS = 15_000;
const AUTH_POLL_IDEMPOTENCY_WINDOW_SIZE = 8;
const MAX_TRACKED_POLL_REQUEST_IDS = 256;
const AUTH_POLL_RESUME_STATE_VERSION = 1;
const AUTH_POLL_RESUME_STATE_TTL_MS = 2 * 60 * 60 * 1000;
const AUTH_POLL_RESUME_LOCK_TIMEOUT_MS = 5_000;
const AUTH_POLL_RESUME_LOCK_STALE_MS = 60_000;
const AUTH_POLL_RESUME_LOCK_RETRY_BASE_MS = 25;
const AUTH_POLL_RESUME_LOCK_RETRY_JITTER_MS = 40;
const RETRYABLE_AUTH_POLL_CODES = new Set([
  "TIMEOUT",
  "NETWORK_ERROR",
  "MAX_RETRIES_EXHAUSTED",
  "CIRCUIT_OPEN",
]);
const AUTH_POLL_JITTER_SALT = getSharedRequestJitterSalt("auth-poll-backoff");
const ALLOW_INSECURE_LOCAL_HTTP_ENV = "SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP";
const INSECURE_LOCAL_HTTP_CONSENT_ENV = "SENTINELAYER_INSECURE_LOCAL_HTTP_CONSENT";
const INSECURE_LOCAL_HTTP_CONSENT_NAMESPACE = "sentinelayer-cli-insecure-local-http-v1";
const PRIVILEGED_SCOPE_CONFIRM_ENV = "SENTINELAYER_PRIVILEGED_SCOPE_CONFIRM";
const PRIVILEGED_SCOPE_CONFIRM_TOKEN = "I_ACKNOWLEDGE_GITHUB_APP_BRIDGE_SCOPE";
const LOCAL_HTTP_EPHEMERAL_PORT_MIN = 32_768;
const LOCAL_HTTP_PORT_ALLOWLIST = new Set([3000, 4173, 5173, 8000, 8080, 8787, 9000, 9443]);
const ALLOWED_API_TOKEN_SCOPES = new Set([
  DEFAULT_API_TOKEN_SCOPE,
  PRIVILEGED_API_TOKEN_SCOPE,
]);
const ALLOWED_API_PATH_PATTERNS = Object.freeze([
  /^\/api\/v1\/auth\/cli\/sessions\/start$/,
  /^\/api\/v1\/auth\/cli\/sessions\/poll$/,
  /^\/api\/v1\/auth\/me$/,
  /^\/api\/v1\/auth\/api-tokens$/,
  /^\/api\/v1\/auth\/api-tokens\/[A-Za-z0-9._~%-]+$/,
  /^\/api\/v1\/runtime\/runs\/[A-Za-z0-9._~%-]+\/status$/,
  /^\/api\/v1\/runtime\/runs\/[A-Za-z0-9._~%-]+\/events\/list$/,
]);
const RUNTIME_EVENTS_PATH_PATTERN = /^\/api\/v1\/runtime\/runs\/[A-Za-z0-9._~%-]+\/events\/list$/;
const RUNTIME_EVENTS_QUERY_KEY = "after_event_id";
const RUNTIME_EVENTS_QUERY_VALUE_PATTERN = /^[A-Za-z0-9._~%/-]+$/;

function isEnabledFlag(rawValue) {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isInteractiveTty() {
  return Boolean(process.stdin?.isTTY) && Boolean(process.stdout?.isTTY);
}

function hasPrivilegedScopePolicyConsent(env = process.env) {
  const rawConsentToken = String(env?.[PRIVILEGED_SCOPE_CONFIRM_ENV] || "").trim();
  return rawConsentToken === PRIVILEGED_SCOPE_CONFIRM_TOKEN;
}

function normalizeLoopbackHostname(rawHostname = "") {
  const normalized = String(rawHostname || "")
    .trim()
    .toLowerCase();
  if (normalized === "[::1]") {
    return "::1";
  }
  return normalized;
}

function isLoopbackHostname(rawHostname = "") {
  const hostname = normalizeLoopbackHostname(rawHostname);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function parseExplicitPort(urlValue) {
  const rawPort = String(urlValue?.port || "").trim();
  if (!rawPort) {
    return null;
  }
  const parsedPort = Number(rawPort);
  if (!Number.isInteger(parsedPort)) {
    return null;
  }
  return parsedPort;
}

function isAllowedInsecureLocalHttpPort(port) {
  const normalizedPort = Math.floor(Number(port));
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    return false;
  }
  if (normalizedPort >= LOCAL_HTTP_EPHEMERAL_PORT_MIN) {
    return true;
  }
  return LOCAL_HTTP_PORT_ALLOWLIST.has(normalizedPort);
}

function buildInsecureLocalHttpConsentToken(hostname) {
  const normalizedHostname = normalizeLoopbackHostname(hostname);
  return crypto
    .createHash("sha256")
    .update(`${INSECURE_LOCAL_HTTP_CONSENT_NAMESPACE}:${normalizedHostname}`)
    .digest("hex");
}

function hasInsecureLocalHttpConsent(hostname, env = process.env) {
  const expected = buildInsecureLocalHttpConsentToken(hostname);
  const providedToken = env?.[INSECURE_LOCAL_HTTP_CONSENT_ENV] ?? process.env[INSECURE_LOCAL_HTTP_CONSENT_ENV];
  const provided = String(providedToken || "")
    .trim()
    .toLowerCase();
  if (!provided || provided.length !== expected.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

function isInsecureLoopbackHttpApiUrl(rawApiUrl) {
  try {
    const parsed = new URL(String(rawApiUrl || ""));
    return parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeApiUrl(
  rawValue,
  { env = process.env, allowInsecureLocalHttp = false } = {}
) {
  const candidate = String(rawValue || "").trim() || DEFAULT_API_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid API URL '${candidate}'.`);
  }
  const hostname = normalizeLoopbackHostname(parsed.hostname);
  const isLocalDevEndpoint = isLoopbackHostname(hostname);
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid API URL '${candidate}': URL credentials are not allowed.`);
  }
  if (parsed.protocol === "http:" && isLocalDevEndpoint) {
    const allowInsecureLocalHttpEnv = isEnabledFlag(env?.[ALLOW_INSECURE_LOCAL_HTTP_ENV]);
    const allowInsecureLocalHttpRuntime = Boolean(allowInsecureLocalHttp);
    const runningInCi = isEnabledFlag(env?.CI);
    const localPort = parseExplicitPort(parsed);
    if (!allowInsecureLocalHttpEnv || !allowInsecureLocalHttpRuntime || runningInCi) {
      throw new Error(
        `Invalid API URL '${candidate}': localhost HTTP requires ${ALLOW_INSECURE_LOCAL_HTTP_ENV}=true plus explicit runtime opt-in and is blocked when CI=true.`
      );
    }
    if (!Number.isInteger(localPort)) {
      throw new Error(
        `Invalid API URL '${candidate}': localhost HTTP requires an explicit loopback port.`
      );
    }
    if (!isAllowedInsecureLocalHttpPort(localPort)) {
      throw new Error(
        `Invalid API URL '${candidate}': localhost HTTP port ${localPort} is not allowlisted (use >=${LOCAL_HTTP_EPHEMERAL_PORT_MIN} or one of ${[
          ...LOCAL_HTTP_PORT_ALLOWLIST,
        ].join(", ")}).`
      );
    }
    if (!hasInsecureLocalHttpConsent(hostname, env)) {
      const expectedConsent = buildInsecureLocalHttpConsentToken(hostname);
      throw new Error(
        `Invalid API URL '${candidate}': localhost HTTP requires ${INSECURE_LOCAL_HTTP_CONSENT_ENV}=${expectedConsent}.`
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(`Invalid API URL '${candidate}': HTTPS is required for non-local endpoints.`);
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizePositiveNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function toAuthHeader(token) {
  return {
    Authorization: `Bearer ${String(token || "").trim()}`,
  };
}

function normalizeUser(user = {}) {
  return {
    id: String(user.id || "").trim(),
    githubUsername: String(user.githubUsername || user.github_username || "").trim(),
    email: String(user.email || "").trim(),
    avatarUrl: String(user.avatarUrl || user.avatar_url || "").trim(),
    isAdmin: Boolean(user.isAdmin || user.is_admin),
  };
}

function normalizeAndValidateApiPathSuffix(pathSuffix) {
  const normalizedSuffix = String(pathSuffix || "").trim();
  if (!normalizedSuffix) {
    return "";
  }
  const normalizedPathSuffix = normalizedSuffix.startsWith("/")
    ? normalizedSuffix
    : `/${normalizedSuffix}`;
  let parsedSuffix;
  try {
    parsedSuffix = new URL(normalizedPathSuffix, "https://sentinelayer.invalid");
  } catch {
    throw new Error(`Invalid API path suffix '${normalizedSuffix}'.`);
  }
  const normalizedPath = parsedSuffix.pathname;
  const queryEntries = Array.from(parsedSuffix.searchParams.entries());
  const allowsRuntimeEventsQuery = RUNTIME_EVENTS_PATH_PATTERN.test(normalizedPath);
  if (!allowsRuntimeEventsQuery && queryEntries.length > 0) {
    throw new Error(`Unsupported API path query for '${normalizedSuffix}'.`);
  }
  if (allowsRuntimeEventsQuery) {
    if (queryEntries.length > 1) {
      throw new Error(`Unsupported API path query for '${normalizedSuffix}'.`);
    }
    if (queryEntries.length === 1) {
      const [queryKey, queryValue] = queryEntries[0];
      if (queryKey !== RUNTIME_EVENTS_QUERY_KEY) {
        throw new Error(`Unsupported API path query for '${normalizedSuffix}'.`);
      }
      if (!RUNTIME_EVENTS_QUERY_VALUE_PATTERN.test(queryValue)) {
        throw new Error(`Invalid API path query value for '${normalizedSuffix}'.`);
      }
    }
  }
  const normalizedQuery = parsedSuffix.searchParams.toString();
  const normalizedPathAndQuery = normalizedQuery
    ? `${normalizedPath}?${normalizedQuery}`
    : normalizedPath;
  const matchesAllowlist = ALLOWED_API_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
  if (!matchesAllowlist) {
    throw new Error(`Unsupported API path suffix '${normalizedSuffix}'.`);
  }
  return normalizedPathAndQuery;
}

function buildApiPath(apiUrl, pathSuffix) {
  const normalizedBase = String(apiUrl || "").trim();
  if (!normalizedBase) {
    throw new Error("apiUrl is required.");
  }
  let parsedBase;
  try {
    parsedBase = new URL(normalizedBase);
  } catch {
    throw new Error(`Invalid apiUrl '${normalizedBase}'.`);
  }
  const normalizedSuffix = String(pathSuffix || "").trim();
  const baseHref = parsedBase.toString().replace(/\/$/, "");
  if (!normalizedSuffix) {
    return baseHref;
  }
  const safePathSuffix = normalizeAndValidateApiPathSuffix(normalizedSuffix);
  return new URL(safePathSuffix, `${baseHref}/`).toString();
}

function generateChallenge() {
  return crypto.randomBytes(48).toString("base64url");
}

function generatePollClientId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function generateSecureRandomHex(length, { context = "secure-random" } = {}) {
  const normalizedLength = Math.max(1, Math.floor(Number(length) || 0));
  try {
    return crypto.randomBytes(normalizedLength).toString("hex");
  } catch {
    const webCryptoSource =
      (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function"
        ? globalThis.crypto
        : crypto.webcrypto && typeof crypto.webcrypto.getRandomValues === "function"
          ? crypto.webcrypto
          : null);
    if (!webCryptoSource) {
      throw new SentinelayerApiError(
        `Unable to initialize ${context}: cryptographic RNG is unavailable.`,
        {
          status: 500,
          code: "AUTH_CRYPTO_UNAVAILABLE",
        }
      );
    }
    const bytes = new Uint8Array(normalizedLength);
    webCryptoSource.getRandomValues(bytes);
    return Buffer.from(bytes).toString("hex");
  }
}

function generatePollJitterSeed() {
  return generateSecureRandomHex(16, {
    context: "auth-poll-jitter-seed",
  });
}

function deterministicJitterFactor(sessionId, pollJitterSeed, attempt, consecutiveFailures = 0) {
  const normalizedAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  const normalizedFailures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
  const seed = [
    String(sessionId || "").trim(),
    String(pollJitterSeed || "").trim(),
    String(normalizedAttempt),
    String(normalizedFailures),
    AUTH_POLL_JITTER_SALT,
  ].join(":");
  const digest = crypto.createHash("sha256").update(seed).digest();
  const bucket = digest[0] / 255;
  return 0.8 + bucket * 0.4;
}

function isRetryableAuthPollError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return false;
  }
  const status = Number(error.status || 0);
  if (status >= 500 && status <= 599) {
    return true;
  }
  const code = String(error.code || "")
    .trim()
    .toUpperCase();
  return RETRYABLE_AUTH_POLL_CODES.has(code);
}

function resolveAuthPollBackendCooldownMs({
  sessionId,
  pollJitterSeed,
  attempt,
  consecutiveFailures,
  pollIntervalMs,
}) {
  const normalizedBase = Math.max(MIN_AUTH_POLL_INTERVAL_MS, Number(pollIntervalMs) || MIN_AUTH_POLL_INTERVAL_MS);
  const failureMultiplier = 2 ** Math.min(Math.max(0, Number(consecutiveFailures) - 1), 5);
  const jitterFactor = deterministicJitterFactor(
    sessionId,
    pollJitterSeed,
    Number(attempt || 0),
    Number(consecutiveFailures || 0)
  );
  const cooldownMs = Math.round(normalizedBase * failureMultiplier * jitterFactor);
  return Math.max(MIN_AUTH_POLL_INTERVAL_MS, Math.min(MAX_AUTH_POLL_BACKEND_BACKOFF_MS, cooldownMs));
}

export function __resolveAuthPollBackendCooldownForTests(options = {}) {
  return resolveAuthPollBackendCooldownMs(options);
}

function resolveAuthPollIntervalMs(rawPollIntervalSeconds, fallbackSeconds = 2) {
  const fallback = Number(fallbackSeconds);
  const normalizedFallback = Number.isFinite(fallback) ? fallback : 2;
  const candidateSeconds = Number(rawPollIntervalSeconds ?? normalizedFallback);
  if (!Number.isFinite(candidateSeconds) || candidateSeconds <= 0) {
    return MIN_AUTH_POLL_INTERVAL_MS;
  }
  return Math.max(MIN_AUTH_POLL_INTERVAL_MS, Math.round(candidateSeconds * 1000));
}

function resolvePollWindowBucket(attempt) {
  const normalizedAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.floor(normalizedAttempt / AUTH_POLL_IDEMPOTENCY_WINDOW_SIZE);
}

function buildPollIdempotencyKey({ sessionId, pollClientId, attempt }) {
  const pollWindowBucket = resolvePollWindowBucket(attempt);
  return crypto
    .createHash("sha256")
    .update(
      [
        String(sessionId || "").trim(),
        String(pollClientId || "").trim(),
        String(pollWindowBucket),
      ].join(":")
    )
    .digest("hex");
}

function buildPollCorrelationId({ sessionId, pollClientId, attempt }) {
  return crypto
    .createHash("sha256")
    .update(
      [
        String(sessionId || "").trim(),
        String(pollClientId || "").trim(),
        String(resolvePollWindowBucket(attempt)),
        String(Math.max(0, Math.floor(Number(attempt) || 0))),
      ].join(":")
    )
    .digest("hex");
}

function resolveAuthHomeDir(homeDir) {
  return path.resolve(String(homeDir || os.homedir()));
}

function buildAuthPollResumeStateKey(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  return crypto.createHash("sha256").update(normalizedSessionId).digest("hex").slice(0, 24);
}

function resolveAuthPollResumeStateFilePath({ sessionId, homeDir } = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("sessionId is required to resolve auth poll resume state path.");
  }
  const resolvedHome = resolveAuthHomeDir(homeDir);
  const stateKey = buildAuthPollResumeStateKey(normalizedSessionId);
  return path.join(resolvedHome, ".sentinelayer", "auth", `poll-state-${stateKey}.json`);
}

function resolveAuthPollResumeStateLockFilePath({ sessionId, homeDir } = {}) {
  const stateFilePath = resolveAuthPollResumeStateFilePath({ sessionId, homeDir });
  return `${stateFilePath}.lock`;
}

function normalizeTrackedPollRequestIds(entries = []) {
  const normalized = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const requestId = String(entry || "").trim();
    if (!requestId || normalized.includes(requestId)) {
      continue;
    }
    normalized.push(requestId);
    if (normalized.length >= MAX_TRACKED_POLL_REQUEST_IDS) {
      break;
    }
  }
  return normalized;
}

function normalizeAuthPollResumeState(raw = {}, { expectedSessionId } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const sessionId = String(raw.sessionId || "").trim();
  if (!sessionId) {
    return null;
  }
  if (String(expectedSessionId || "").trim() && sessionId !== String(expectedSessionId || "").trim()) {
    return null;
  }
  const pollClientId = String(raw.pollClientId || "").trim() || null;
  if (!pollClientId) {
    return null;
  }
  const updatedAt = String(raw.updatedAt || "").trim();
  if (!updatedAt) {
    return null;
  }
  const updatedEpoch = Date.parse(updatedAt);
  if (!Number.isFinite(updatedEpoch)) {
    return null;
  }
  if (Date.now() - updatedEpoch > AUTH_POLL_RESUME_STATE_TTL_MS) {
    return null;
  }
  const highestSeenPollSequenceRaw = Number(raw.highestSeenPollSequence);
  const highestSeenPollSequence = Number.isFinite(highestSeenPollSequenceRaw)
    ? Math.max(-1, Math.floor(highestSeenPollSequenceRaw))
    : -1;
  const nextAttemptRaw = Number(raw.nextAttempt);
  const nextAttempt = Number.isFinite(nextAttemptRaw) ? Math.max(0, Math.floor(nextAttemptRaw)) : 0;
  const seenRequestIds = normalizeTrackedPollRequestIds(raw.seenRequestIds);
  const versionRaw = Number(raw.version);
  const version = Number.isFinite(versionRaw) ? Math.max(1, Math.floor(versionRaw)) : AUTH_POLL_RESUME_STATE_VERSION;
  return {
    version,
    sessionId,
    pollClientId,
    updatedAt,
    highestSeenPollSequence,
    nextAttempt,
    seenRequestIds,
  };
}

async function readAuthPollResumeStateFromFile(filePath, { expectedSessionId } = {}) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return normalizeAuthPollResumeState(parsed, { expectedSessionId });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function withAuthPollResumeStateLock({ sessionId, homeDir } = {}, operation) {
  if (typeof operation !== "function") {
    throw new Error("operation callback is required.");
  }
  const lockPath = resolveAuthPollResumeStateLockFilePath({ sessionId, homeDir });
  const stateFilePath = resolveAuthPollResumeStateFilePath({ sessionId, homeDir });
  const directoryPath = path.dirname(stateFilePath);
  await fsp.mkdir(directoryPath, { recursive: true });
  const deadlineMs = Date.now() + AUTH_POLL_RESUME_LOCK_TIMEOUT_MS;
  let lockHandle = null;
  while (!lockHandle) {
    try {
      lockHandle = await fsp.open(lockPath, "wx");
      await lockHandle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf-8"
      );
      await lockHandle.sync();
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStats = await fsp.stat(lockPath);
        if (Date.now() - Number(lockStats.mtimeMs || 0) > AUTH_POLL_RESUME_LOCK_STALE_MS) {
          await fsp.rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if (!lockError || typeof lockError !== "object" || lockError.code !== "ENOENT") {
          throw lockError;
        }
      }
      if (Date.now() >= deadlineMs) {
        throw new Error(
          `Timed out acquiring auth poll resume-state lock for session '${String(sessionId || "").trim() || "unknown"}'.`
        );
      }
      const retryDelayMs =
        AUTH_POLL_RESUME_LOCK_RETRY_BASE_MS +
        Math.floor(Math.random() * (AUTH_POLL_RESUME_LOCK_RETRY_JITTER_MS + 1));
      await sleep(retryDelayMs);
    }
  }
  try {
    return await operation({ stateFilePath, lockPath });
  } finally {
    try {
      if (lockHandle) {
        await lockHandle.close();
      }
    } catch {
      // Best-effort close before lock cleanup.
    }
    try {
      await fsp.rm(lockPath, { force: true });
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function readAuthPollResumeState({ sessionId, homeDir } = {}) {
  const filePath = resolveAuthPollResumeStateFilePath({ sessionId, homeDir });
  return readAuthPollResumeStateFromFile(filePath, { expectedSessionId: sessionId });
}

async function writeAuthPollResumeState({
  sessionId,
  pollClientId,
  highestSeenPollSequence,
  nextAttempt,
  seenRequestIds,
  homeDir,
} = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedPollClientId = String(pollClientId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("sessionId is required to persist auth poll resume state.");
  }
  if (!normalizedPollClientId) {
    throw new Error("pollClientId is required to persist auth poll resume state.");
  }
  const requestedHighestSequence = Math.max(-1, Math.floor(Number(highestSeenPollSequence) || -1));
  const requestedNextAttempt = Math.max(0, Math.floor(Number(nextAttempt) || 0));
  const requestedSeenRequestIds = normalizeTrackedPollRequestIds(seenRequestIds);
  await withAuthPollResumeStateLock(
    { sessionId: normalizedSessionId, homeDir },
    async ({ stateFilePath }) => {
      const existingState = await readAuthPollResumeStateFromFile(stateFilePath, {
        expectedSessionId: normalizedSessionId,
      });
      const mergedHighestSequence = Math.max(
        requestedHighestSequence,
        Number(existingState?.highestSeenPollSequence ?? -1)
      );
      const mergedNextAttempt = Math.max(requestedNextAttempt, Number(existingState?.nextAttempt ?? 0));
      const mergedSeenRequestIds = normalizeTrackedPollRequestIds([
        ...(existingState?.seenRequestIds || []),
        ...requestedSeenRequestIds,
      ]);
      const payload = {
        version: AUTH_POLL_RESUME_STATE_VERSION,
        sessionId: normalizedSessionId,
        pollClientId: normalizedPollClientId,
        highestSeenPollSequence: mergedHighestSequence,
        nextAttempt: mergedNextAttempt,
        seenRequestIds: mergedSeenRequestIds,
        updatedAt: new Date().toISOString(),
      };
      const tempPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
      const serialized = `${JSON.stringify(payload, null, 2)}\n`;
      await fsp.writeFile(tempPath, serialized, "utf-8");
      let renamed = false;
      try {
        await fsp.rename(tempPath, stateFilePath);
        renamed = true;
      } finally {
        if (!renamed) {
          await fsp.rm(tempPath, { force: true });
        }
      }
    }
  );
}

async function clearAuthPollResumeState({ sessionId, homeDir } = {}) {
  await withAuthPollResumeStateLock({ sessionId, homeDir }, async ({ stateFilePath }) => {
    try {
      await fsp.rm(stateFilePath);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
    }
  });
}

function normalizeOptionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  return Math.max(0, Math.floor(normalized));
}

function getAuthPollCorrelation(payload = {}) {
  const rawPollClientId = payload.poll_client_id ?? payload.pollClientId;
  const rawPollWindow = payload.poll_window ?? payload.pollWindow;
  const rawPollCorrelationId = payload.poll_correlation_id ?? payload.pollCorrelationId;
  return {
    pollClientId: String(rawPollClientId || "").trim() || null,
    pollWindow: normalizeOptionalInteger(rawPollWindow),
    pollCorrelationId: String(rawPollCorrelationId || "").trim() || null,
  };
}

function trackSeenPollRequestId(seenRequestIds, requestId) {
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedRequestId) {
    return;
  }
  if (seenRequestIds.has(normalizedRequestId)) {
    return;
  }
  seenRequestIds.add(normalizedRequestId);
  while (seenRequestIds.size > MAX_TRACKED_POLL_REQUEST_IDS) {
    const oldestRequestId = seenRequestIds.values().next().value;
    if (!oldestRequestId) {
      break;
    }
    seenRequestIds.delete(oldestRequestId);
  }
}

function throwIfAbortRequested(signal) {
  if (!signal || typeof signal !== "object" || !signal.aborted) {
    return;
  }
  throw new SentinelayerApiError("CLI authentication polling canceled by caller.", {
    status: 499,
    code: "CLI_AUTH_ABORTED",
  });
}

async function sleepWithAbortSignal(delayMs, signal) {
  throwIfAbortRequested(signal);
  const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);
  const abortSignal =
    signal &&
    typeof signal === "object" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function"
      ? signal
      : undefined;
  try {
    await sleep(normalizedDelayMs, undefined, { signal: abortSignal, ref: false });
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new SentinelayerApiError("CLI authentication polling canceled by caller.", {
        status: 499,
        code: "CLI_AUTH_ABORTED",
      });
    }
    throw error;
  }
}

const TERMINAL_CLI_AUTH_POLL_STATUSES = new Map([
  ["denied", { httpStatus: 403, code: "CLI_AUTH_DENIED", message: "CLI authentication was denied." }],
  ["rejected", { httpStatus: 403, code: "CLI_AUTH_REJECTED", message: "CLI authentication was rejected." }],
  ["declined", { httpStatus: 403, code: "CLI_AUTH_DECLINED", message: "CLI authentication was declined." }],
  ["expired", { httpStatus: 410, code: "CLI_AUTH_EXPIRED", message: "CLI authentication request expired." }],
  ["cancelled", { httpStatus: 409, code: "CLI_AUTH_CANCELLED", message: "CLI authentication was cancelled." }],
  ["canceled", { httpStatus: 409, code: "CLI_AUTH_CANCELLED", message: "CLI authentication was cancelled." }],
  ["failed", { httpStatus: 502, code: "CLI_AUTH_FAILED", message: "CLI authentication failed." }],
  ["error", { httpStatus: 502, code: "CLI_AUTH_ERROR", message: "CLI authentication failed." }],
]);

function getAuthPollRequestId(payload = {}) {
  const candidate = payload.request_id ?? payload.requestId;
  const normalized = String(candidate || "").trim();
  return normalized || null;
}

function getAuthPollSequence(payload = {}) {
  return normalizeOptionalInteger(payload.poll_sequence ?? payload.pollSequence);
}

function getAuthPollSessionId(payload = {}) {
  const candidate = payload.session_id ?? payload.sessionId;
  const normalized = String(candidate || "").trim();
  return normalized || null;
}

function describePollStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  return normalized;
}

function resolveMonotonicNowMs() {
  if (
    typeof globalThis.performance === "object" &&
    Number.isFinite(Number(globalThis.performance.timeOrigin)) &&
    typeof globalThis.performance.now === "function"
  ) {
    return Number(globalThis.performance.timeOrigin) + Number(globalThis.performance.now());
  }
  return Date.now();
}

function defaultTokenLabel() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `sl-cli-session-${stamp}`;
}

function resolveApiTokenScope(
  rawScope = "",
  { allowPrivilegedScope = false, env = process.env, apiUrl = "" } = {}
) {
  const normalized = String(rawScope || "").trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_API_TOKEN_SCOPE;
  }
  if (!ALLOWED_API_TOKEN_SCOPES.has(normalized)) {
    throw new Error(`tokenScope must be one of: ${[...ALLOWED_API_TOKEN_SCOPES].join(", ")}.`);
  }
  if (normalized === PRIVILEGED_API_TOKEN_SCOPE && !allowPrivilegedScope) {
    throw new Error(
      "tokenScope github_app_bridge requires explicit privileged approval. Re-run with --allow-privileged-scope."
    );
  }
  if (normalized === PRIVILEGED_API_TOKEN_SCOPE && !isInteractiveTty()) {
    throw new Error(
      `tokenScope github_app_bridge requires interactive TTY consent with ${PRIVILEGED_SCOPE_CONFIRM_ENV}=${PRIVILEGED_SCOPE_CONFIRM_TOKEN}.`
    );
  }
  if (normalized === PRIVILEGED_API_TOKEN_SCOPE && !hasPrivilegedScopePolicyConsent(env)) {
    throw new Error(
      `tokenScope github_app_bridge requires policy confirmation. Export ${PRIVILEGED_SCOPE_CONFIRM_ENV}=${PRIVILEGED_SCOPE_CONFIRM_TOKEN}.`
    );
  }
  if (normalized === PRIVILEGED_API_TOKEN_SCOPE && isInsecureLoopbackHttpApiUrl(apiUrl)) {
    throw new Error(
      "tokenScope github_app_bridge is disabled when API URL uses insecure localhost HTTP transport."
    );
  }
  return normalized;
}

function isNearExpiry(tokenExpiresAt, thresholdDays) {
  const normalized = String(tokenExpiresAt || "").trim();
  if (!normalized) {
    return false;
  }
  const expiryEpoch = Date.parse(normalized);
  if (!Number.isFinite(expiryEpoch)) {
    return false;
  }
  const thresholdMs = Number(thresholdDays || DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS) * 24 * 60 * 60 * 1000;
  return expiryEpoch - Date.now() <= thresholdMs;
}

/**
 * Resolve API URL precedence for auth operations: explicit -> env -> config -> default.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   allowInsecureLocalHttp?: boolean,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<string>}
 */
export async function resolveApiUrl({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  allowInsecureLocalHttp = false,
  homeDir,
} = {}) {
  const overrideUrl = String(explicitApiUrl || "").trim();
  if (overrideUrl) {
    return normalizeApiUrl(overrideUrl, { env, allowInsecureLocalHttp });
  }

  const envUrl = String(env.SENTINELAYER_API_URL || "").trim();
  if (envUrl) {
    return normalizeApiUrl(envUrl, { env, allowInsecureLocalHttp });
  }

  const config = await loadConfig({ cwd, env, homeDir });
  const configuredApiUrl = String(config.resolved.apiUrl || "").trim();
  if (configuredApiUrl) {
    return normalizeApiUrl(configuredApiUrl, { env, allowInsecureLocalHttp });
  }

  return normalizeApiUrl(DEFAULT_API_URL, { env, allowInsecureLocalHttp });
}

async function startCliAuthSession({ apiUrl, challenge, ide, cliVersion }) {
  return requestJson(buildApiPath(apiUrl, "/api/v1/auth/cli/sessions/start"), {
    method: "POST",
    body: {
      challenge,
      ide: String(ide || DEFAULT_IDE_NAME),
      cli_version: String(cliVersion || "").trim() || null,
    },
  });
}

async function pollCliAuthSession({
  apiUrl,
  sessionId,
  pollClientId,
  challenge,
  timeoutMs,
  pollIntervalSeconds,
  signal = null,
  homeDir,
}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  let persistedPollState = null;
  try {
    persistedPollState = await readAuthPollResumeState({
      sessionId: normalizedSessionId,
      homeDir,
    });
  } catch {
    persistedPollState = null;
  }
  const explicitPollClientId = String(pollClientId || "").trim();
  const normalizedPollClientId = explicitPollClientId || persistedPollState?.pollClientId || generatePollClientId();
  const resumeStateMatchesClientId = Boolean(
    persistedPollState && String(persistedPollState.pollClientId || "").trim() === normalizedPollClientId
  );
  const timeout = normalizePositiveNumber(timeoutMs, "timeoutMs", DEFAULT_AUTH_TIMEOUT_MS);
  const deadlineMs = resolveMonotonicNowMs() + timeout;
  const maxAttempts = Math.max(
    1,
    Math.min(MAX_AUTH_POLL_ATTEMPTS, Math.ceil(timeout / MIN_AUTH_POLL_INTERVAL_MS))
  );
  let lastKnownPollIntervalMs = resolveAuthPollIntervalMs(pollIntervalSeconds, 2);
  let consecutiveBackendFailures = 0;
  let attempt = resumeStateMatchesClientId ? Math.max(0, Number(persistedPollState.nextAttempt || 0)) : 0;
  const seenRequestIds = new Set(
    resumeStateMatchesClientId ? normalizeTrackedPollRequestIds(persistedPollState.seenRequestIds) : []
  );
  let highestSeenPollSequence = resumeStateMatchesClientId
    ? Math.max(-1, Number(persistedPollState.highestSeenPollSequence || -1))
    : -1;
  const pollJitterSeed = generatePollJitterSeed();

  async function persistResumeState() {
    try {
      await writeAuthPollResumeState({
        sessionId: normalizedSessionId,
        pollClientId: normalizedPollClientId,
        highestSeenPollSequence,
        nextAttempt: attempt,
        seenRequestIds: Array.from(seenRequestIds),
        homeDir,
      });
    } catch {
      // Resume-state persistence is best-effort and must not block auth.
    }
  }

  async function clearResumeState() {
    try {
      await clearAuthPollResumeState({ sessionId: normalizedSessionId, homeDir });
    } catch {
      // Resume-state cleanup is best-effort and must not block auth.
    }
  }

  while (resolveMonotonicNowMs() < deadlineMs && attempt < maxAttempts) {
    throwIfAbortRequested(signal);
    const remainingBudgetMs = Math.max(0, deadlineMs - resolveMonotonicNowMs());
    if (remainingBudgetMs <= 0) {
      break;
    }
    const pollRequestTimeoutMs = Math.max(250, Math.min(5_000, remainingBudgetMs));
    const pollIdempotencyKey = buildPollIdempotencyKey({
      sessionId: normalizedSessionId,
      pollClientId: normalizedPollClientId,
      attempt,
    });
    const pollWindow = resolvePollWindowBucket(attempt);
    const pollCorrelationId = buildPollCorrelationId({
      sessionId: normalizedSessionId,
      pollClientId: normalizedPollClientId,
      attempt,
    });
    let payload = null;
    try {
      payload = await requestJson(buildApiPath(apiUrl, "/api/v1/auth/cli/sessions/poll"), {
        method: "POST",
        headers: {
          "Idempotency-Key": pollIdempotencyKey,
          "X-Poll-Client-Id": normalizedPollClientId,
          "X-Poll-Window": String(pollWindow),
          "X-Poll-Correlation-Id": pollCorrelationId,
          "X-Poll-Attempt": String(attempt),
        },
        body: {
          session_id: normalizedSessionId,
          challenge,
          poll_client_id: normalizedPollClientId,
          poll_window: pollWindow,
          poll_correlation_id: pollCorrelationId,
          poll_attempt: attempt,
        },
        timeoutMs: pollRequestTimeoutMs,
        signal,
      });
      consecutiveBackendFailures = 0;
    } catch (error) {
      if (!isRetryableAuthPollError(error)) {
        await persistResumeState();
        throw error;
      }
      consecutiveBackendFailures += 1;
      if (consecutiveBackendFailures >= MAX_AUTH_POLL_BACKEND_FAILURES) {
        const remainingMs = Math.max(0, deadlineMs - resolveMonotonicNowMs());
        const retryAfterMs = Math.max(
          MIN_AUTH_POLL_INTERVAL_MS,
          Math.min(
            MAX_AUTH_POLL_BACKEND_BACKOFF_MS,
            Math.min(
              remainingMs,
              resolveAuthPollBackendCooldownMs({
                sessionId: normalizedSessionId,
                pollJitterSeed,
                attempt,
                consecutiveFailures: consecutiveBackendFailures,
                pollIntervalMs: lastKnownPollIntervalMs,
              })
            )
          )
        );
        throw new SentinelayerApiError(
          "Authentication polling backend is temporarily unavailable. Retry once service health recovers.",
          {
            status: 503,
            code: "CLI_AUTH_BACKEND_UNAVAILABLE",
            requestId: error instanceof SentinelayerApiError ? error.requestId : null,
            retryAfterMs,
          }
        );
      }
      const remainingMs = Math.max(0, deadlineMs - resolveMonotonicNowMs());
      const cooldownMs = Math.min(
        remainingMs,
        resolveAuthPollBackendCooldownMs({
          sessionId: normalizedSessionId,
          pollJitterSeed,
          attempt,
          consecutiveFailures: consecutiveBackendFailures,
          pollIntervalMs: lastKnownPollIntervalMs,
        })
      );
      await sleepWithAbortSignal(cooldownMs, signal);
      attempt += 1;
      await persistResumeState();
      continue;
    }

    const responseSessionId = getAuthPollSessionId(payload);
    const requestId = getAuthPollRequestId(payload);
    const pollSequence = getAuthPollSequence(payload);
    const responseCorrelation = getAuthPollCorrelation(payload);
    if (requestId && seenRequestIds.has(requestId)) {
      const replayDelayMs = Math.min(
        Math.max(MIN_AUTH_POLL_INTERVAL_MS, Math.floor(lastKnownPollIntervalMs / 2)),
        Math.max(0, deadlineMs - resolveMonotonicNowMs())
      );
      if (replayDelayMs > 0) {
        await sleepWithAbortSignal(replayDelayMs, signal);
      }
      attempt += 1;
      await persistResumeState();
      continue;
    }
    if (
      (responseCorrelation.pollClientId && responseCorrelation.pollClientId !== normalizedPollClientId) ||
      (responseCorrelation.pollWindow !== null && responseCorrelation.pollWindow !== pollWindow) ||
      (responseCorrelation.pollCorrelationId && responseCorrelation.pollCorrelationId !== pollCorrelationId)
    ) {
      const replayDelayMs = Math.min(
        Math.max(MIN_AUTH_POLL_INTERVAL_MS, Math.floor(lastKnownPollIntervalMs / 2)),
        Math.max(0, deadlineMs - resolveMonotonicNowMs())
      );
      if (replayDelayMs > 0) {
        await sleepWithAbortSignal(replayDelayMs, signal);
      }
      attempt += 1;
      await persistResumeState();
      continue;
    }
    if (responseSessionId && responseSessionId !== normalizedSessionId) {
      throw new SentinelayerApiError("CLI authentication poll returned mismatched session id.", {
        status: 502,
        code: "CLI_AUTH_SESSION_MISMATCH",
        requestId,
      });
    }
    if (pollSequence !== null) {
      if (pollSequence <= highestSeenPollSequence) {
        const replayDelayMs = Math.min(
          Math.max(MIN_AUTH_POLL_INTERVAL_MS, Math.floor(lastKnownPollIntervalMs / 2)),
          Math.max(0, deadlineMs - resolveMonotonicNowMs())
        );
        if (replayDelayMs > 0) {
          await sleepWithAbortSignal(replayDelayMs, signal);
        }
        attempt += 1;
        await persistResumeState();
        continue;
      }
      highestSeenPollSequence = pollSequence;
    }

    const status = String(payload.status || "pending").trim().toLowerCase();
    if (status === "approved" && payload.auth_token) {
      trackSeenPollRequestId(seenRequestIds, requestId);
      await clearResumeState();
      const normalizedRequestId = requestId || null;
      return {
        ...payload,
        request_id: normalizedRequestId,
        requestId: normalizedRequestId,
      };
    }
    if (TERMINAL_CLI_AUTH_POLL_STATUSES.has(status)) {
      trackSeenPollRequestId(seenRequestIds, requestId);
      const terminalConfig = TERMINAL_CLI_AUTH_POLL_STATUSES.get(status);
      const reason = String(payload.message || payload.error || payload.reason || "").trim();
      const message = reason ? `${terminalConfig.message} ${reason}` : terminalConfig.message;
      await clearResumeState();
      throw new SentinelayerApiError(message, {
        status: terminalConfig.httpStatus,
        code: terminalConfig.code,
        requestId,
      });
    }
    if (status !== "pending") {
      await clearResumeState();
      throw new SentinelayerApiError(
        `Unexpected CLI authentication session status '${describePollStatus(status)}'.`,
        {
          status: 502,
          code: "CLI_AUTH_UNEXPECTED_STATUS",
          requestId,
        }
      );
    }
    trackSeenPollRequestId(seenRequestIds, requestId);

    const serverPollIntervalMs = resolveAuthPollIntervalMs(
      payload.poll_interval_seconds ?? payload.pollIntervalSeconds ?? pollIntervalSeconds,
      2
    );
    lastKnownPollIntervalMs = serverPollIntervalMs;
    const backoffMultiplier = 2 ** Math.min(attempt, 5);
    const baseDelayMs = Math.min(serverPollIntervalMs * backoffMultiplier, 8_000);
    const jitterFactor = deterministicJitterFactor(normalizedSessionId, pollJitterSeed, attempt);
    const remainingMs = Math.max(0, deadlineMs - resolveMonotonicNowMs());
    const nextDelayMs = Math.max(
      MIN_AUTH_POLL_INTERVAL_MS,
      Math.min(Math.round(baseDelayMs * jitterFactor), remainingMs)
    );
    await sleepWithAbortSignal(nextDelayMs, signal);
    attempt += 1;
    await persistResumeState();
  }

  await persistResumeState();
  throw new SentinelayerApiError("CLI authentication timed out. Restart and try again.", {
    status: 408,
    code: "CLI_AUTH_TIMEOUT",
  });
}

export async function __pollCliAuthSessionForTests(options = {}) {
  return pollCliAuthSession(options);
}

export async function __writeAuthPollResumeStateForTests(options = {}) {
  return writeAuthPollResumeState(options);
}

export async function __readAuthPollResumeStateForTests(options = {}) {
  return readAuthPollResumeState(options);
}

export function __buildApiPathForTests(apiUrl, pathSuffix) {
  return buildApiPath(apiUrl, pathSuffix);
}

export function __buildInsecureLocalHttpConsentTokenForTests(hostname = "127.0.0.1") {
  return buildInsecureLocalHttpConsentToken(hostname);
}

async function fetchCurrentUser({ apiUrl, token }) {
  return requestJson(buildApiPath(apiUrl, "/api/v1/auth/me"), {
    method: "GET",
    headers: toAuthHeader(token),
  });
}

async function issueApiToken({
  apiUrl,
  authToken,
  tokenLabel,
  tokenTtlDays,
  tokenScope = "",
  allowPrivilegedScope = false,
  env = process.env,
}) {
  const expiresInDays = Math.round(
    normalizePositiveNumber(tokenTtlDays, "apiTokenTtlDays", DEFAULT_API_TOKEN_TTL_DAYS)
  );
  return requestJson(buildApiPath(apiUrl, "/api/v1/auth/api-tokens"), {
    method: "POST",
    headers: toAuthHeader(authToken),
    body: {
      label: String(tokenLabel || "").trim() || defaultTokenLabel(),
      scope: resolveApiTokenScope(tokenScope, { allowPrivilegedScope, env, apiUrl }),
      llm_credential_mode: "managed",
      expires_in_days: expiresInDays,
    },
  });
}

function isAuthorizationFailure(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return false;
  }
  const status = Number(error.status || 0);
  if (status === 401 || status === 403) {
    return true;
  }
  const code = String(error.code || "").trim().toUpperCase();
  return code === "AUTH_REQUIRED" || code === "FORBIDDEN" || code === "INVALID_TOKEN";
}

function resolveRevocationAuthCandidates(primaryToken, fallbackToken = "") {
  const candidates = [];
  for (const rawToken of [primaryToken, fallbackToken]) {
    const normalized = String(rawToken || "").trim();
    if (!normalized || candidates.includes(normalized)) {
      continue;
    }
    candidates.push(normalized);
  }
  return candidates;
}

async function revokeApiToken({ apiUrl, authToken, tokenId, fallbackAuthToken = "" }) {
  const normalizedTokenId = String(tokenId || "").trim();
  if (!normalizedTokenId) {
    return false;
  }
  const authCandidates = resolveRevocationAuthCandidates(authToken, fallbackAuthToken);
  if (authCandidates.length === 0) {
    throw new SentinelayerApiError("No revocation auth token available.", {
      status: 401,
      code: "AUTH_REQUIRED",
    });
  }

  const knownNotFoundCodes = new Set(["NOT_FOUND", "TOKEN_NOT_FOUND", "TOKEN_ALREADY_REVOKED"]);
  let lastError = null;
  for (let index = 0; index < authCandidates.length; index += 1) {
    const candidateToken = authCandidates[index];
    try {
      await requestJson(buildApiPath(apiUrl, `/api/v1/auth/api-tokens/${encodeURIComponent(normalizedTokenId)}`), {
        method: "DELETE",
        headers: toAuthHeader(candidateToken),
      });
      return true;
    } catch (error) {
      lastError = error;
      if (error instanceof SentinelayerApiError) {
        const status = Number(error.status || 0);
        const normalizedCode = String(error.code || "").trim().toUpperCase();
        const alreadyRevoked = status === 404 || status === 410;
        if (alreadyRevoked || knownNotFoundCodes.has(normalizedCode)) {
          return true;
        }
        const hasFallback = index < authCandidates.length - 1;
        if (hasFallback && isAuthorizationFailure(error)) {
          continue;
        }
      }
      throw error;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new SentinelayerApiError("Unable to revoke API token.", {
    status: 500,
    code: "TOKEN_REVOKE_FAILED",
  });
}

function isRetryableRevokeError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return false;
  }
  const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  return retryableStatuses.has(Number(error.status || 0));
}

function toRotationWarning(tokenId, error) {
  if (error instanceof SentinelayerApiError) {
    return {
      tokenId: normalizeString(tokenId) || null,
      code: error.code,
      status: error.status,
      message: error.message,
    };
  }
  return {
    tokenId: normalizeString(tokenId) || null,
    code: "UNKNOWN",
    status: 500,
    message: error instanceof Error ? error.message : String(error || "Unknown rotation error"),
  };
}

function toStoredSessionApiError(error) {
  if (error instanceof SentinelayerApiError) {
    return error;
  }
  if (error instanceof StoredSessionError) {
    return new SentinelayerApiError(error.message, {
      status: 401,
      code: error.code || "STORED_SESSION_INVALID",
    });
  }
  return error;
}

async function rotateStoredApiTokenIfNeeded({
  session,
  thresholdDays,
  tokenLabel,
  tokenTtlDays,
  tokenScope,
  allowPrivilegedScope = false,
  env = process.env,
  homeDir,
}) {
  if (!session || !session.token || !session.tokenExpiresAt) {
    return { session, rotated: false };
  }
  if (!isNearExpiry(session.tokenExpiresAt, thresholdDays)) {
    return { session, rotated: false };
  }

  const issued = await issueApiToken({
    apiUrl: session.apiUrl,
    authToken: session.token,
    tokenLabel,
    tokenTtlDays,
    tokenScope,
    allowPrivilegedScope,
    env,
  });

  const nextSession = await writeStoredSession(
    {
      apiUrl: session.apiUrl,
      token: String(issued.token || ""),
      tokenId: issued.id || null,
      tokenPrefix: issued.token_prefix || null,
      tokenExpiresAt: issued.expires_at || null,
      user: session.user,
    },
    {
      homeDir,
      allowFileStorageFallback: String(session?.storage || "").trim().toLowerCase() === "file",
    }
  );

  if (session.tokenId) {
    let revokeWarning = null;
    const maxRevokeAttempts = 3;
    for (let attempt = 0; attempt < maxRevokeAttempts; attempt += 1) {
      try {
        await revokeApiToken({
          apiUrl: session.apiUrl,
          authToken: nextSession.token,
          fallbackAuthToken: session.token,
          tokenId: session.tokenId,
        });
        revokeWarning = null;
        break;
      } catch (error) {
        if (!isRetryableRevokeError(error)) {
          throw error;
        }
        revokeWarning = toRotationWarning(session.tokenId, error);
        if (attempt < maxRevokeAttempts - 1) {
          const delayMs = Math.min(200 * 2 ** attempt, 2000);
          await sleep(delayMs);
        }
      }
    }
    if (revokeWarning) {
      return {
        session: nextSession,
        rotated: true,
        rotationWarning: revokeWarning,
      };
    }
  }

  return {
    session: nextSession,
    rotated: true,
    rotationWarning: null,
  };
}

/**
 * Perform browser-based CLI login flow and persist an API token session locally.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   skipBrowserOpen?: boolean,
 *   timeoutMs?: number,
 *   tokenLabel?: string,
 *   tokenTtlDays?: number,
 *   tokenScope?: string,
 *   allowPrivilegedScope?: boolean,
 *   allowInsecureLocalHttp?: boolean,
 *   allowFileStorageFallback?: boolean,
 *   ide?: string,
 *   cliVersion?: string,
 *   signal?: AbortSignal | null,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<{
 *   apiUrl: string,
 *   authorizeUrl: string,
 *   browserOpened: boolean,
 *   user: {
 *     id: string,
 *     githubUsername: string,
 *     email: string,
 *     avatarUrl: string,
 *     isAdmin: boolean
 *   },
 *   tokenId: string | null,
 *   tokenPrefix: string | null,
 *   tokenExpiresAt: string | null,
 *   storage: string,
 *   filePath: string
 * }>}
 */
export async function loginAndPersistSession({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  skipBrowserOpen = false,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  tokenLabel = "",
  tokenTtlDays = DEFAULT_API_TOKEN_TTL_DAYS,
  tokenScope = "",
  allowPrivilegedScope = false,
  allowInsecureLocalHttp = false,
  allowFileStorageFallback = false,
  ide = DEFAULT_IDE_NAME,
  cliVersion = "",
  signal = null,
  homeDir,
} = {}) {
  const apiUrl = await resolveApiUrl({
    cwd,
    env,
    explicitApiUrl,
    allowInsecureLocalHttp,
    homeDir,
  });
  const challenge = generateChallenge();
  const pollClientId = generatePollClientId();
  const session = await startCliAuthSession({
    apiUrl,
    challenge,
    ide,
    cliVersion,
  });

  const authorizeUrl = String(session.authorize_url || "").trim();
  let browserOpened = false;
  if (!skipBrowserOpen && authorizeUrl) {
    try {
      await open(authorizeUrl);
      browserOpened = true;
    } catch {
      browserOpened = false;
    }
  }

  const approval = await pollCliAuthSession({
    apiUrl,
    sessionId: String(session.session_id || "").trim(),
    pollClientId,
    challenge,
    timeoutMs,
    pollIntervalSeconds: Number(session.poll_interval_seconds || 2),
    signal,
    homeDir,
  });

  const approvalToken = String(approval.auth_token || "").trim();
  if (!approvalToken) {
    throw new SentinelayerApiError("Authentication completed but no auth token was returned.", {
      status: 503,
      code: "CLI_AUTH_MISSING_TOKEN",
    });
  }

  const user = normalizeUser(approval.user || (await fetchCurrentUser({ apiUrl, token: approvalToken })));
  const issuedApiToken = await issueApiToken({
    apiUrl,
    authToken: approvalToken,
    tokenLabel,
    tokenTtlDays,
    tokenScope,
    allowPrivilegedScope,
    env,
  });

  const stored = await writeStoredSession(
    {
      apiUrl,
      token: String(issuedApiToken.token || ""),
      tokenId: issuedApiToken.id || null,
      tokenPrefix: issuedApiToken.token_prefix || null,
      tokenExpiresAt: issuedApiToken.expires_at || null,
      user,
    },
    { homeDir, allowFileStorageFallback }
  );

  return {
    apiUrl,
    authorizeUrl,
    browserOpened,
    user,
    tokenId: stored.tokenId,
    tokenPrefix: stored.tokenPrefix,
    tokenExpiresAt: stored.tokenExpiresAt,
    storage: stored.storage,
    storageDowngraded: Boolean(stored.storageDowngraded),
    filePath: stored.filePath,
  };
}

/**
 * Resolve active auth credentials used by CLI commands, optionally rotating near-expiry session tokens.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   autoRotate?: boolean,
 *   rotateThresholdDays?: number,
 *   tokenLabel?: string,
 *   tokenTtlDays?: number,
 *   tokenScope?: string,
 *   allowPrivilegedScope?: boolean,
 *   allowInsecureLocalHttp?: boolean,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<null | {
 *   apiUrl: string,
 *   token: string,
 *   source: "env" | "config" | "session",
 *   user: {
 *     id: string,
 *     githubUsername: string,
 *     email: string,
 *     avatarUrl: string,
 *     isAdmin: boolean
 *   } | null,
 *   storage: string,
 *   tokenId: string | null,
 *   tokenPrefix: string | null,
 *   tokenExpiresAt: string | null,
 *   rotated: boolean,
 *   rotationWarning: null | { tokenId: string | null, code: string, status: number, message: string },
 *   filePath: string | null
 * }>}
 */
export async function resolveActiveAuthSession({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  autoRotate = true,
  rotateThresholdDays = DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS,
  tokenLabel = "",
  tokenTtlDays = DEFAULT_API_TOKEN_TTL_DAYS,
  tokenScope = "",
  allowPrivilegedScope = false,
  allowInsecureLocalHttp = false,
  homeDir,
} = {}) {
  const apiUrl = await resolveApiUrl({
    cwd,
    env,
    explicitApiUrl,
    allowInsecureLocalHttp,
    homeDir,
  });

  const envToken = normalizeValueForKey("sentinelayerToken", env?.SENTINELAYER_TOKEN) || "";
  if (envToken) {
    return {
      apiUrl,
      token: envToken,
      source: "env",
      user: null,
      storage: "env",
      storageDowngraded: false,
      tokenId: null,
      tokenPrefix: null,
      tokenExpiresAt: null,
      rotated: false,
      rotationWarning: null,
      filePath: null,
    };
  }

  const config = await loadConfig({ cwd, env, homeDir });
  const configuredToken = String(config.resolved.sentinelayerToken || "").trim();
  if (configuredToken) {
    return {
      apiUrl,
      token: configuredToken,
      source: "config",
      user: null,
      storage: "config",
      storageDowngraded: false,
      tokenId: null,
      tokenPrefix: null,
      tokenExpiresAt: null,
      rotated: false,
      rotationWarning: null,
      filePath: null,
    };
  }

  let stored = null;
  try {
    stored = await readStoredSession({ homeDir });
  } catch (error) {
    throw toStoredSessionApiError(error);
  }
  if (!stored) {
    return null;
  }

  let active = stored;
  let rotated = false;
  let rotationWarning = null;
  if (autoRotate) {
    try {
      const rotateResult = await rotateStoredApiTokenIfNeeded({
        session: stored,
        thresholdDays: rotateThresholdDays,
        tokenLabel,
        tokenTtlDays,
        tokenScope,
        allowPrivilegedScope,
        env,
        homeDir,
      });
      active = rotateResult.session;
      rotated = rotateResult.rotated;
      rotationWarning = rotateResult.rotationWarning || null;
    } catch (error) {
      // Keep existing token if rotation fails.
      active = stored;
      rotated = false;
      rotationWarning = toRotationWarning(stored.tokenId, error);
    }
  }

  return {
    apiUrl,
    token: active.token,
    source: "session",
    user: normalizeUser(active.user || {}),
    storage: active.storage,
    storageDowngraded: Boolean(active.storageDowngraded),
    tokenId: active.tokenId || null,
    tokenPrefix: active.tokenPrefix || null,
    tokenExpiresAt: active.tokenExpiresAt || null,
    rotated,
    rotationWarning,
    filePath: active.filePath,
  };
}

/**
 * Return current authentication state, with optional remote `/auth/me` verification.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   checkRemote?: boolean,
 *   autoRotate?: boolean,
 *   rotateThresholdDays?: number,
 *   tokenLabel?: string,
 *   tokenTtlDays?: number,
 *   allowInsecureLocalHttp?: boolean,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<{
 *   authenticated: boolean,
 *   apiUrl: string,
 *   source: string | null,
 *   storage: string | null,
 *   user: any,
 *   remoteUser: any,
 *   remoteError: null | { code: string, message: string, status: number, requestId: string | null },
 *   rotated: boolean,
 *   rotationWarning: null | { tokenId: string | null, code: string, status: number, message: string },
 *   tokenExpiresAt: string | null,
 *   tokenPrefix: string | null,
 *   tokenId: string | null,
 *   filePath: string | null
 * }>}
 */
export async function getAuthStatus({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  checkRemote = true,
  autoRotate = true,
  rotateThresholdDays = DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS,
  tokenLabel = "",
  tokenTtlDays = DEFAULT_API_TOKEN_TTL_DAYS,
  allowInsecureLocalHttp = false,
  homeDir,
} = {}) {
  const session = await resolveActiveAuthSession({
    cwd,
    env,
    explicitApiUrl,
    autoRotate,
    rotateThresholdDays,
    tokenLabel,
    tokenTtlDays,
    allowInsecureLocalHttp,
    homeDir,
  });

  if (!session) {
    return {
      authenticated: false,
      apiUrl: await resolveApiUrl({
        cwd,
        env,
        explicitApiUrl,
        allowInsecureLocalHttp,
        homeDir,
      }),
      source: null,
      storage: null,
      user: null,
      remoteUser: null,
      remoteError: null,
      rotated: false,
      rotationWarning: null,
      tokenExpiresAt: null,
      tokenPrefix: null,
      tokenId: null,
      filePath: null,
    };
  }

  let remoteUser = null;
  let remoteError = null;
  if (checkRemote) {
    try {
      remoteUser = normalizeUser(await fetchCurrentUser({ apiUrl: session.apiUrl, token: session.token }));
    } catch (error) {
      remoteError =
        error instanceof SentinelayerApiError
          ? {
              code: error.code,
              message: error.message,
              status: error.status,
              requestId: error.requestId,
            }
          : {
              code: "UNKNOWN",
              message: error instanceof Error ? error.message : String(error || "Unknown error"),
              status: 500,
              requestId: null,
            };
    }
  }

  return {
    authenticated: !remoteError,
    apiUrl: session.apiUrl,
    source: session.source,
    storage: session.storage,
    user: session.user,
    remoteUser,
    remoteError,
    rotated: session.rotated,
    rotationWarning: session.rotationWarning || null,
    tokenExpiresAt: session.tokenExpiresAt,
    tokenPrefix: session.tokenPrefix,
    tokenId: session.tokenId,
    filePath: session.filePath,
  };
}

/**
 * List persisted local session metadata for CLI operators/HITL dashboards.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   allowInsecureLocalHttp?: boolean,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<{ apiUrl: string, sessions: Array<any> }>}
 */
export async function listStoredAuthSessions({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  allowInsecureLocalHttp = false,
  homeDir,
} = {}) {
  const apiUrl = await resolveApiUrl({
    cwd,
    env,
    explicitApiUrl,
    allowInsecureLocalHttp,
    homeDir,
  });
  const stored = await readStoredSessionMetadata({ homeDir });
  if (!stored) {
    return {
      apiUrl,
      sessions: [],
    };
  }

  return {
    apiUrl,
    sessions: [
      {
        source: "session",
        storage: stored.storage || null,
        tokenId: stored.tokenId || null,
        tokenPrefix: stored.tokenPrefix || null,
        tokenExpiresAt: stored.tokenExpiresAt || null,
        createdAt: stored.createdAt || null,
        updatedAt: stored.updatedAt || null,
        user: normalizeUser(stored.user || {}),
        filePath: stored.filePath || null,
      },
    ],
  };
}

/**
 * Revoke an API token remotely and clear matching local stored session metadata when applicable.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   allowInsecureLocalHttp?: boolean,
 *   tokenId?: string,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<{
 *   apiUrl: string,
 *   source: string,
 *   tokenId: string,
 *   revokedRemote: boolean,
 *   matchedStoredSession: boolean,
 *   clearedLocal: boolean,
 *   filePath: string | null
 * }>}
 */
export async function revokeAuthToken({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  allowInsecureLocalHttp = false,
  tokenId = "",
  homeDir,
} = {}) {
  const active = await resolveActiveAuthSession({
    cwd,
    env,
    explicitApiUrl,
    autoRotate: false,
    allowInsecureLocalHttp,
    homeDir,
  });
  if (!active || !active.token) {
    throw new SentinelayerApiError("No active auth token found. Run `sl auth login` first.", {
      status: 401,
      code: "AUTH_REQUIRED",
    });
  }

  const targetTokenId = String(tokenId || "").trim() || String(active.tokenId || "").trim();
  if (!targetTokenId) {
    throw new Error(
      "tokenId is required. Provide --token-id or use a stored session that includes token metadata."
    );
  }

  await revokeApiToken({
    apiUrl: active.apiUrl,
    authToken: active.token,
    tokenId: targetTokenId,
  });

  let matchedStoredSession = false;
  let clearedLocal = false;
  let filePath = null;
  let stored = null;
  try {
    stored = await readStoredSession({ homeDir });
  } catch (error) {
    throw toStoredSessionApiError(error);
  }
  if (stored && String(stored.tokenId || "").trim() === targetTokenId) {
    matchedStoredSession = true;
    const cleared = await clearStoredSession({ homeDir });
    clearedLocal = Boolean(cleared.clearedMetadata);
    filePath = cleared.filePath || null;
  }

  return {
    apiUrl: active.apiUrl,
    source: active.source,
    tokenId: targetTokenId,
    revokedRemote: true,
    matchedStoredSession,
    clearedLocal,
    filePath,
  };
}

/**
 * Clear local CLI session state and optionally revoke the remote token first.
 *
 * @param {{
 *   homeDir?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   allowInsecureLocalHttp?: boolean,
 *   revokeRemote?: boolean
 * }} [options]
 * @returns {Promise<{
 *   hadStoredSession: boolean,
 *   revokedRemote: boolean,
 *   clearedLocal: boolean,
 *   apiUrl?: string,
 *   filePath?: string
 * }>}
 */
export async function logoutSession({
  homeDir,
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  allowInsecureLocalHttp = false,
  revokeRemote = true,
} = {}) {
  let stored = null;
  try {
    stored = await readStoredSession({ homeDir });
  } catch (error) {
    if (error instanceof StoredSessionError) {
      const cleared = await clearStoredSession({ homeDir });
      return {
        hadStoredSession: Boolean(cleared.hadSession),
        revokedRemote: false,
        clearedLocal: Boolean(cleared.clearedMetadata),
        filePath: cleared.filePath,
      };
    }
    throw error;
  }
  if (!stored) {
    return {
      hadStoredSession: false,
      revokedRemote: false,
      clearedLocal: false,
      apiUrl: await resolveApiUrl({
        cwd,
        env,
        explicitApiUrl,
        allowInsecureLocalHttp,
        homeDir,
      }),
    };
  }

  let revokedRemote = false;
  if (revokeRemote && stored.tokenId && stored.token) {
    try {
      await revokeApiToken({
        apiUrl: await resolveApiUrl({
          cwd,
          env,
          explicitApiUrl,
          allowInsecureLocalHttp,
          homeDir,
        }),
        authToken: stored.token,
        tokenId: stored.tokenId,
      });
      revokedRemote = true;
    } catch {
      revokedRemote = false;
    }
  }

  const cleared = await clearStoredSession({ homeDir });
  return {
    hadStoredSession: true,
    revokedRemote,
    clearedLocal: cleared.clearedMetadata,
    filePath: cleared.filePath,
  };
}

/**
 * Fetch runtime run event stream slices used by `sl watch` and reproducibility artifacts.
 *
 * @param {{
 *   apiUrl: string,
 *   authToken: string,
 *   runId: string,
 *   afterEventId?: string | null
 * }} [options]
 * @returns {Promise<any>}
 */
export async function listRuntimeRunEvents({
  apiUrl,
  authToken,
  runId,
  afterEventId = null,
} = {}) {
  const query = afterEventId
    ? `?after_event_id=${encodeURIComponent(String(afterEventId))}`
    : "";
  return requestJson(
    buildApiPath(apiUrl, `/api/v1/runtime/runs/${encodeURIComponent(String(runId || ""))}/events/list${query}`),
    {
      method: "GET",
      headers: toAuthHeader(authToken),
    }
  );
}

/**
 * Fetch runtime run status snapshot from the Sentinelayer API.
 *
 * @param {{ apiUrl: string, authToken: string, runId: string }} [options]
 * @returns {Promise<any>}
 */
export async function getRuntimeRunStatus({
  apiUrl,
  authToken,
  runId,
} = {}) {
  return requestJson(
    buildApiPath(apiUrl, `/api/v1/runtime/runs/${encodeURIComponent(String(runId || ""))}/status`),
    {
      method: "GET",
      headers: toAuthHeader(authToken),
    }
  );
}
