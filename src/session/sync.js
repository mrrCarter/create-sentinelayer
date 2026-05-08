import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveActiveAuthSession } from "../auth/service.js";
import { createAgentEvent } from "../events/schema.js";

const DEFAULT_API_BASE_URL = "https://api.sentinelayer.com";
const DEFAULT_SYNC_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const CIRCUIT_RESET_MS = 60_000;
const SESSION_INGEST_LIMIT_PER_MINUTE = 500;
const HUMAN_MESSAGE_LIMIT_PER_MINUTE = 10;
const HUMAN_MESSAGE_MAX_LENGTH = 2_000;
const HUMAN_MESSAGE_FETCH_LIMIT = 50;
const SESSION_EVENT_FETCH_LIMIT = 200;

// Audit §2.9: crash-recovery contract for in-memory circuit state.
// Persist outbound/inbound circuit state to disk so a process restart
// doesn't drop an open circuit, causing thundering-herd retries against a
// still-degraded API. The on-disk envelope carries acquiredAt so that the
// hydrator can reject entries older than CIRCUIT_RESET_MS — after the
// reset window the circuit is considered closed regardless of persisted
// state. Write-through is best-effort; failure never blocks local CLI.
const CIRCUIT_STATE_FILE_DIR = ".sentinelayer";
const CIRCUIT_STATE_FILE_NAME = "circuit-state.json";
const CIRCUIT_STATE_SCHEMA_VERSION = "1.0.0";

function resolveCircuitStateFilePath(homeDir) {
  const resolvedHome = path.resolve(String(homeDir || os.homedir()));
  return path.join(resolvedHome, CIRCUIT_STATE_FILE_DIR, CIRCUIT_STATE_FILE_NAME);
}

function hydrateCircuitFromDisk(homeDir) {
  try {
    const filePath = resolveCircuitStateFilePath(homeDir);
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { outbound: null, inbound: null };
    }
    if (String(parsed.schemaVersion || "") !== CIRCUIT_STATE_SCHEMA_VERSION) {
      return { outbound: null, inbound: null };
    }
    const nowMs = Date.now();
    const reviveEntry = (entry) => {
      if (!entry || typeof entry !== "object") return null;
      const failures = Number(entry.consecutiveFailures || 0);
      const openedAtMs = Number(entry.openedAtMs || 0);
      if (!Number.isFinite(failures) || !Number.isFinite(openedAtMs)) return null;
      if (failures < MAX_CONSECUTIVE_FAILURES) return null;
      if (openedAtMs <= 0) return null;
      if (nowMs - openedAtMs >= CIRCUIT_RESET_MS) return null;
      return { consecutiveFailures: failures, openedAtMs };
    };
    return {
      outbound: reviveEntry(parsed.outbound),
      inbound: reviveEntry(parsed.inbound),
    };
  } catch {
    return { outbound: null, inbound: null };
  }
}

function persistCircuitState(homeDir) {
  try {
    const filePath = resolveCircuitStateFilePath(homeDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = {
      schemaVersion: CIRCUIT_STATE_SCHEMA_VERSION,
      writtenAtMs: Date.now(),
      writerPid: process.pid,
      writerHostname: os.hostname(),
      outbound: {
        consecutiveFailures: outboundCircuit.consecutiveFailures,
        openedAtMs: outboundCircuit.openedAtMs,
      },
      inbound: {
        consecutiveFailures: inboundCircuit.consecutiveFailures,
        openedAtMs: inboundCircuit.openedAtMs,
      },
    };
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Best-effort only; local CLI must not crash on telemetry persistence.
  }
}

const _hydrated = hydrateCircuitFromDisk();

const outboundCircuit = {
  consecutiveFailures: _hydrated.outbound?.consecutiveFailures ?? 0,
  openedAtMs: _hydrated.outbound?.openedAtMs ?? 0,
};

const inboundCircuit = {
  consecutiveFailures: _hydrated.inbound?.consecutiveFailures ?? 0,
  openedAtMs: _hydrated.inbound?.openedAtMs ?? 0,
};

const sessionIngestWindowBySessionId = new Map();
const humanRelayWindowBySessionId = new Map();

// Per-process record of agent identities for which we have already issued an
// auto-grant attempt against `POST /api/v1/sessions/agent-grants`. Server-side
// agent-identity enforcement (PR #478) returns 403 IDENTITY_FORGERY when the
// active user has not granted the `agent.id` carried on a session event. The
// CLI auto-grants on the first 403 and retries the event POST exactly once,
// but if the grant itself fails (e.g. 422 from a malformed agent_id), we MUST
// NOT loop. This Set is the loop-breaker: insertion order is preserved (Set
// semantics in V8) so an LRU-ish trim drops the oldest entries first when the
// cap is exceeded. SessionId-agnostic by design — once a user grants
// `agent.id="codex"`, the grant is global to their account.
const AUTO_GRANT_ATTEMPT_CACHE_MAX = 50;
const autoGrantAttemptedAgentIds = new Set();

// Reserved agent_id values that the API treats specially — granting these
// is either a no-op or rejected outright. Skip the auto-grant round-trip and
// return the original 403 cleanly.
const AUTO_GRANT_RESERVED_PREFIXES = ["human-"];
const AUTO_GRANT_RESERVED_EXACT = new Set(["", "cli-user", "unknown"]);

// API role enum (per PR #478 server contract). Anything not in this set
// (notably the legacy `orchestrator` role we still emit locally) falls back
// to `coder`. This is a forward-compat workaround pending an API enum
// extension that adds `orchestrator`.
const AUTO_GRANT_VALID_ROLES = new Set([
  "auditor",
  "coder",
  "coordinator",
  "observer",
  "reviewer",
]);
const AUTO_GRANT_DEFAULT_ROLE = "coder";

function rememberAutoGrantAttempt(agentId) {
  if (!agentId) return;
  if (autoGrantAttemptedAgentIds.has(agentId)) {
    // Refresh insertion order so the most recently used entry survives
    // LRU eviction when the cap is hit.
    autoGrantAttemptedAgentIds.delete(agentId);
    autoGrantAttemptedAgentIds.add(agentId);
    return;
  }
  autoGrantAttemptedAgentIds.add(agentId);
  while (autoGrantAttemptedAgentIds.size > AUTO_GRANT_ATTEMPT_CACHE_MAX) {
    const oldest = autoGrantAttemptedAgentIds.values().next().value;
    if (oldest === undefined) break;
    autoGrantAttemptedAgentIds.delete(oldest);
  }
}

function isReservedAgentIdForGrant(agentId) {
  const id = normalizeString(agentId);
  if (AUTO_GRANT_RESERVED_EXACT.has(id)) return true;
  for (const prefix of AUTO_GRANT_RESERVED_PREFIXES) {
    if (id.startsWith(prefix)) return true;
  }
  return false;
}

function resolveGrantRole(rawRole) {
  const normalized = normalizeString(rawRole).toLowerCase();
  if (AUTO_GRANT_VALID_ROLES.has(normalized)) {
    return normalized;
  }
  return AUTO_GRANT_DEFAULT_ROLE;
}

async function readResponseJsonSafely(response) {
  if (!response || typeof response.json !== "function") {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isIdentityForgeryBody(body) {
  if (!body || typeof body !== "object") return false;
  const error = body.error;
  if (!error || typeof error !== "object") return false;
  return normalizeString(error.code) === "IDENTITY_FORGERY";
}

// Test-only: clear the per-process auto-grant attempt cache so unit tests
// exercising the loop-breaker don't bleed state across runs.
export function __resetAutoGrantCacheForTests() {
  autoGrantAttemptedAgentIds.clear();
}

const SECRET_LIKE_PATTERN =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|SENTINELAYER_TOKEN|AIDENID_API_KEY|NPM_TOKEN|xox[baprs]-[A-Za-z0-9-]+)/i;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeIsoTimestamp(value, fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallbackIso;
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    return fallbackIso;
  }
  return new Date(epoch).toISOString();
}

function normalizePositiveInteger(value, fallbackValue) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.floor(normalized);
}

function eventTimestampMs(event = {}) {
  for (const key of ["ts", "timestamp", "createdAt", "at"]) {
    const epoch = Date.parse(normalizeString(event?.[key]));
    if (Number.isFinite(epoch)) {
      return epoch;
    }
  }
  return 0;
}

function eventSequenceNumber(event = {}) {
  for (const key of ["sequenceId", "sequence_id", "sequence"]) {
    const value = Number(event?.[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function chronologicalSessionEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const timeDiff = eventTimestampMs(left.event) - eventTimestampMs(right.event);
      if (timeDiff !== 0) return timeDiff;
      const sequenceDiff = eventSequenceNumber(left.event) - eventSequenceNumber(right.event);
      if (sequenceDiff !== 0) return sequenceDiff;
      return left.index - right.index;
    })
    .map((entry) => entry.event);
}

// Session-apiUrl allowlist. A session file is an untrusted input: if an
// attacker can write to .sentinelayer/sessions/<id>/meta.json (or trick a user
// into joining a crafted session), they can redirect every outbound fetch.
// Hard-coded list + override via SENTINELAYER_API_ALLOWED_HOSTS.
const BUILTIN_API_ALLOWED_HOSTS = new Set([
  "api.sentinelayer.com",
  "api.staging.sentinelayer.com",
  "localhost",
  "127.0.0.1",
]);

function resolveAllowedApiHosts() {
  const extras = normalizeString(process.env.SENTINELAYER_API_ALLOWED_HOSTS || "");
  const set = new Set(BUILTIN_API_ALLOWED_HOSTS);
  if (extras) {
    for (const host of extras.split(",")) {
      const trimmed = host.trim().toLowerCase();
      if (trimmed) set.add(trimmed);
    }
  }
  return set;
}

function isApiHostAllowed(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      return false;
    }
    return resolveAllowedApiHosts().has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function resolveApiBaseUrl(session = {}) {
  const apiUrl = normalizeString(session.apiUrl) || DEFAULT_API_BASE_URL;
  const normalized = apiUrl.replace(/\/+$/, "");
  if (!isApiHostAllowed(normalized)) {
    // Reject tampered session.apiUrl and fall back to the default.
    // Caller will see API calls land on the canonical host, not an attacker's.
    return DEFAULT_API_BASE_URL;
  }
  return normalized;
}

function isCircuitOpen(circuit, nowMs) {
  if (!circuit || circuit.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    return false;
  }
  const openedAtMs = Number(circuit.openedAtMs || 0);
  if (!Number.isFinite(openedAtMs) || openedAtMs <= 0) {
    return false;
  }
  if (nowMs - openedAtMs >= CIRCUIT_RESET_MS) {
    circuit.consecutiveFailures = 0;
    circuit.openedAtMs = 0;
    return false;
  }
  return true;
}

function recordCircuitFailure(circuit, nowMs) {
  if (!circuit) {
    return;
  }
  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    circuit.openedAtMs = nowMs;
  }
  persistCircuitState();
}

function recordCircuitSuccess(circuit) {
  if (!circuit) {
    return;
  }
  circuit.consecutiveFailures = 0;
  circuit.openedAtMs = 0;
  persistCircuitState();
}

// Test-only helper. Resets both circuits in memory AND on disk so unit
// tests that exercise hydration don't leak state across runs.
export function __resetCircuitStateForTests(homeDir) {
  outboundCircuit.consecutiveFailures = 0;
  outboundCircuit.openedAtMs = 0;
  inboundCircuit.consecutiveFailures = 0;
  inboundCircuit.openedAtMs = 0;
  try {
    const filePath = resolveCircuitStateFilePath(homeDir);
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
}

export function __hydrateCircuitStateFromDiskForTests(homeDir) {
  const hydrated = hydrateCircuitFromDisk(homeDir);
  outboundCircuit.consecutiveFailures = hydrated.outbound?.consecutiveFailures ?? 0;
  outboundCircuit.openedAtMs = hydrated.outbound?.openedAtMs ?? 0;
  inboundCircuit.consecutiveFailures = hydrated.inbound?.consecutiveFailures ?? 0;
  inboundCircuit.openedAtMs = hydrated.inbound?.openedAtMs ?? 0;
}

function enforceRollingLimit(windowByKey, key, {
  nowMs = Date.now(),
  limit = 1,
  windowMs = 60_000,
} = {}) {
  const normalizedKey = normalizeString(key);
  if (!normalizedKey) {
    return {
      allowed: true,
      remaining: limit,
      count: 0,
    };
  }

  const existing = windowByKey.get(normalizedKey) || [];
  const recent = existing.filter((ts) => Number.isFinite(ts) && ts >= nowMs - windowMs);
  if (recent.length >= limit) {
    windowByKey.set(normalizedKey, recent);
    return {
      allowed: false,
      remaining: 0,
      count: recent.length,
    };
  }

  recent.push(nowMs);
  windowByKey.set(normalizedKey, recent);
  return {
    allowed: true,
    remaining: Math.max(0, limit - recent.length),
    count: recent.length,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeoutHandle.unref === "function") {
    timeoutHandle.unref();
  }
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function sanitizeHumanMessage(rawMessage) {
  const stripped = String(rawMessage || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "")
    .trim();
  if (!stripped) {
    return {
      accepted: false,
      reason: "empty_message",
      message: "",
    };
  }
  if (SECRET_LIKE_PATTERN.test(stripped)) {
    return {
      accepted: false,
      reason: "secret_like_pattern",
      message: "",
    };
  }
  const truncated = stripped.length > HUMAN_MESSAGE_MAX_LENGTH
    ? stripped.slice(0, HUMAN_MESSAGE_MAX_LENGTH)
    : stripped;
  return {
    accepted: true,
    reason: "",
    message: truncated,
    truncated: truncated.length < stripped.length,
  };
}

function normalizeHumanMessageItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.messages)) {
      return payload.messages;
    }
    if (Array.isArray(payload.items)) {
      return payload.items;
    }
  }
  return [];
}

function extractCursor(payload, fallbackCursor) {
  if (payload && typeof payload === "object") {
    const explicit = normalizeString(payload.cursor || payload.nextCursor || payload.next_cursor);
    if (explicit) {
      return explicit;
    }
  }
  return normalizeString(fallbackCursor) || null;
}

function buildHumanRelayEvent(sessionId, message = {}) {
  const agentId =
    normalizeString(message.agentId || message.authorId || message.senderId || "human-operator")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "human-operator";
  const messageId = normalizeString(message.id || message.messageId || message.message_id) || null;
  const ts = normalizeIsoTimestamp(
    message.ts || message.timestamp || message.createdAt || message.created_at,
    new Date().toISOString()
  );
  const sanitization = sanitizeHumanMessage(message.message || message.text || message.body || "");
  if (!sanitization.accepted) {
    return {
      accepted: false,
      reason: sanitization.reason,
      event: null,
      messageId,
      ts,
    };
  }
  const event = createAgentEvent({
    event: "session_message",
    agentId,
    sessionId,
    ts,
    payload: {
      message: sanitization.message,
      channel: "session",
      source: "human",
      priority: "high",
      relayedFromApi: true,
      messageId,
      directive: normalizeString(message.directive || ""),
      command: normalizeString(message.command || ""),
      truncated: Boolean(sanitization.truncated),
    },
  });
  return {
    accepted: true,
    reason: "",
    event,
    messageId,
    ts,
  };
}

/**
 * Sync one local session event to sentinelayer-api.
 * This function is best-effort and never throws.
 */
export async function syncSessionEventToApi(
  sessionId,
  event,
  {
    targetPath = process.cwd(),
    timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
    resolveAuthSession = resolveActiveAuthSession,
    fetchImpl = fetchWithTimeout,
    nowMs = Date.now,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId || !event || typeof event !== "object" || Array.isArray(event)) {
    return { synced: false, reason: "invalid_input" };
  }

  // Test-fixture leak guard. Tests in this repo (and downstream consumers)
  // create + tear down sessions using a temp workspace; on a developer
  // machine those calls inherit the user's stored auth and silently posted
  // hundreds of orphan rooms to prod (Carter saw ~200 "<null>" sessions).
  // Honoring SENTINELAYER_SKIP_REMOTE_SYNC=1 keeps everything local while
  // still exercising the appendToStream + agent_join code paths the tests
  // care about. Local NDJSON durability is unaffected.
  if (String(process.env.SENTINELAYER_SKIP_REMOTE_SYNC || "").trim() === "1") {
    return { synced: false, reason: "remote_sync_disabled_env" };
  }

  const normalizedNowMs = Number(nowMs()) || Date.now();
  if (isCircuitOpen(outboundCircuit, normalizedNowMs)) {
    return { synced: false, reason: "circuit_breaker_open" };
  }

  const rateLimit = enforceRollingLimit(sessionIngestWindowBySessionId, normalizedSessionId, {
    nowMs: normalizedNowMs,
    limit: SESSION_INGEST_LIMIT_PER_MINUTE,
  });
  if (!rateLimit.allowed) {
    return {
      synced: false,
      reason: "local_ingest_rate_limited",
      limit: SESSION_INGEST_LIMIT_PER_MINUTE,
    };
  }

  if (
    event?.payload?.relayedFromApi ||
    normalizeString(event?.cursor) ||
    normalizeString(event?.sequenceId || event?.sequence_id)
  ) {
    return { synced: false, reason: "relay_event_skip" };
  }

  let session = null;
  try {
    session = await resolveAuthSession({
      cwd: targetPath,
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return { synced: false, reason: "no_session" };
  }

  if (!session || !session.token) {
    return { synced: false, reason: "not_authenticated" };
  }

  const apiBaseUrl = resolveApiBaseUrl(session);
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/events`;
  const requestBody = JSON.stringify({
    event,
    source: "cli",
  });
  const requestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: requestBody,
  };
  const resolvedTimeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_SYNC_TIMEOUT_MS);

  try {
    const response = await fetchImpl(endpoint, requestInit, resolvedTimeoutMs);

    if (response && response.ok) {
      recordCircuitSuccess(outboundCircuit);
      return {
        synced: true,
        status: response.status,
      };
    }

    // Handle PR #478 IDENTITY_FORGERY: server now requires the active user to
    // have explicitly granted any `agent.id` posted to /events. Without this
    // auto-grant, every CLI-driven agent post returns 403 and the user sees
    // their agents "talking" locally while the API has zero record. We attempt
    // the grant once per agentId per process, then retry the event POST once.
    if (response && response.status === 403) {
      const body = await readResponseJsonSafely(response);
      if (isIdentityForgeryBody(body)) {
        const agentId = normalizeString(event?.agent?.id);
        if (!agentId || isReservedAgentIdForGrant(agentId)) {
          // Reserved or empty — server enforcement is intentional, no grant
          // attempt is meaningful. Treat as a normal 403 failure.
          recordCircuitFailure(outboundCircuit, normalizedNowMs);
          return { synced: false, reason: "api_403" };
        }
        if (autoGrantAttemptedAgentIds.has(agentId)) {
          // We already tried to grant this identity in a prior event in this
          // process and either it succeeded but the server still says no, or
          // the grant failed. Either way, don't loop — surface the 403.
          recordCircuitFailure(outboundCircuit, normalizedNowMs);
          return { synced: false, reason: "api_403" };
        }
        rememberAutoGrantAttempt(agentId);

        const grantRole = resolveGrantRole(event?.agent?.role);
        const grantEndpoint = `${apiBaseUrl}/api/v1/sessions/agent-grants`;
        let grantResponse = null;
        try {
          grantResponse = await fetchImpl(
            grantEndpoint,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.token}`,
              },
              body: JSON.stringify({
                agent_id: agentId,
                role: grantRole,
              }),
            },
            resolvedTimeoutMs
          );
        } catch (grantError) {
          recordCircuitFailure(outboundCircuit, normalizedNowMs);
          return {
            synced: false,
            reason: normalizeString(grantError?.message) || "grant_failed",
          };
        }

        const grantStatus = grantResponse ? grantResponse.status : 0;
        const grantOk = Boolean(grantResponse && grantResponse.ok);
        // Treat 409 (already granted) as success — idempotent on the server.
        const grantIdempotent = grantStatus === 409;
        if (!grantOk && !grantIdempotent) {
          recordCircuitFailure(outboundCircuit, normalizedNowMs);
          return {
            synced: false,
            reason: `grant_failed_${grantStatus || "no_response"}`,
          };
        }

        // Retry the original event POST exactly once.
        let retryResponse;
        try {
          retryResponse = await fetchImpl(endpoint, requestInit, resolvedTimeoutMs);
        } catch (retryError) {
          recordCircuitFailure(outboundCircuit, normalizedNowMs);
          return {
            synced: false,
            reason: normalizeString(retryError?.message) || "sync_failed",
          };
        }
        if (retryResponse && retryResponse.ok) {
          recordCircuitSuccess(outboundCircuit);
          return {
            synced: true,
            status: retryResponse.status,
            autoGranted: true,
          };
        }
        recordCircuitFailure(outboundCircuit, normalizedNowMs);
        return {
          synced: false,
          reason: `api_${retryResponse ? retryResponse.status : "no_response"}`,
        };
      }
    }

    recordCircuitFailure(outboundCircuit, normalizedNowMs);
    return {
      synced: false,
      reason: `api_${response ? response.status : "no_response"}`,
    };
  } catch (error) {
    recordCircuitFailure(outboundCircuit, normalizedNowMs);
    return {
      synced: false,
      reason: normalizeString(error?.message) || "sync_failed",
    };
  }
}

async function syncSessionAuxPayload(
  sessionId,
  pathSuffix,
  payload,
  {
    targetPath = process.cwd(),
    timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
    resolveAuthSession = resolveActiveAuthSession,
    fetchImpl = fetchWithTimeout,
    nowMs = Date.now,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId || !pathSuffix || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { synced: false, reason: "invalid_input" };
  }

  // Same test-fixture leak guard as syncSessionEventToApi — keep parity
  // so neither the event channel nor the metadata/error channels can
  // exfiltrate a test session into prod when the env flag is set.
  if (String(process.env.SENTINELAYER_SKIP_REMOTE_SYNC || "").trim() === "1") {
    return { synced: false, reason: "remote_sync_disabled_env" };
  }

  const normalizedNowMs = Number(nowMs()) || Date.now();
  if (isCircuitOpen(outboundCircuit, normalizedNowMs)) {
    return { synced: false, reason: "circuit_breaker_open" };
  }

  const rateLimit = enforceRollingLimit(sessionIngestWindowBySessionId, normalizedSessionId, {
    nowMs: normalizedNowMs,
    limit: SESSION_INGEST_LIMIT_PER_MINUTE,
  });
  if (!rateLimit.allowed) {
    return {
      synced: false,
      reason: "local_ingest_rate_limited",
      limit: SESSION_INGEST_LIMIT_PER_MINUTE,
    };
  }

  let session = null;
  try {
    session = await resolveAuthSession({
      cwd: targetPath,
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return { synced: false, reason: "no_session" };
  }
  if (!session || !session.token) {
    return { synced: false, reason: "not_authenticated" };
  }

  const apiBaseUrl = resolveApiBaseUrl(session);
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}${pathSuffix}`;
  try {
    const response = await fetchImpl(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          ...payload,
          source: "cli",
        }),
      },
      normalizePositiveInteger(timeoutMs, DEFAULT_SYNC_TIMEOUT_MS)
    );
    if (!response || !response.ok) {
      recordCircuitFailure(outboundCircuit, normalizedNowMs);
      return {
        synced: false,
        reason: `api_${response ? response.status : "no_response"}`,
      };
    }
    recordCircuitSuccess(outboundCircuit);
    return {
      synced: true,
      status: response.status,
    };
  } catch (error) {
    recordCircuitFailure(outboundCircuit, normalizedNowMs);
    return {
      synced: false,
      reason: normalizeString(error?.message) || "sync_failed",
    };
  }
}

/**
 * Sync local session metadata to sentinelayer-api for admin visibility.
 * This function is best-effort and never throws.
 */
export async function syncSessionMetadataToApi(sessionId, metadata, options = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { synced: false, reason: "invalid_input" };
  }
  return syncSessionAuxPayload(sessionId, "/metadata", { metadata }, options);
}

/**
 * Sync local session error envelopes to sentinelayer-api for admin visibility.
 * This function is best-effort and never throws.
 */
export async function syncSessionErrorToApi(sessionId, error, options = {}) {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return { synced: false, reason: "invalid_input" };
  }
  return syncSessionAuxPayload(sessionId, "/errors", { error }, options);
}

/**
 * Poll human messages for a session from sentinelayer-api and map them into
 * canonical high-priority session events for local relay.
 */
export async function pollHumanMessages(
  sessionId,
  {
    targetPath = process.cwd(),
    since = null,
    timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
    limit = HUMAN_MESSAGE_FETCH_LIMIT,
    forceCircuitProbe = false,
    resolveAuthSession = resolveActiveAuthSession,
    fetchImpl = fetchWithTimeout,
    nowMs = Date.now,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return {
      ok: false,
      reason: "invalid_session_id",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }

  const normalizedNowMs = Number(nowMs()) || Date.now();
  if (!forceCircuitProbe && isCircuitOpen(inboundCircuit, normalizedNowMs)) {
    return {
      ok: false,
      reason: "circuit_breaker_open",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }

  let session = null;
  try {
    session = await resolveAuthSession({
      cwd: targetPath,
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return {
      ok: false,
      reason: "no_session",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }
  if (!session || !session.token) {
    return {
      ok: false,
      reason: "not_authenticated",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }

  const apiBaseUrl = resolveApiBaseUrl(session);
  const query = new URLSearchParams();
  const normalizedSince = normalizeString(since);
  if (normalizedSince) {
    query.set("since", normalizedSince);
  }
  query.set("limit", String(Math.max(1, Math.min(HUMAN_MESSAGE_FETCH_LIMIT, normalizePositiveInteger(limit, HUMAN_MESSAGE_FETCH_LIMIT)))));
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/human-messages?${query.toString()}`;

  try {
    const response = await fetchImpl(
      endpoint,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.token}`,
        },
      },
      normalizePositiveInteger(timeoutMs, DEFAULT_SYNC_TIMEOUT_MS)
    );
    if (!response || !response.ok) {
      recordCircuitFailure(inboundCircuit, normalizedNowMs);
      return {
        ok: false,
        reason: `api_${response ? response.status : "no_response"}`,
        events: [],
        cursor: normalizedSince || null,
      };
    }
    const payload = await response.json().catch(() => ({}));
    recordCircuitSuccess(inboundCircuit);

    const items = normalizeHumanMessageItems(payload);
    const acceptedEvents = [];
    const dropped = [];
    let fallbackCursor = normalizedSince || null;
    for (const item of items) {
      const normalizedTs = normalizeIsoTimestamp(
        item?.ts || item?.timestamp || item?.createdAt || item?.created_at,
        fallbackCursor || new Date().toISOString()
      );
      fallbackCursor = normalizedTs;
      const built = buildHumanRelayEvent(normalizedSessionId, item || {});
      if (!built.accepted || !built.event) {
        dropped.push({
          messageId: built.messageId,
          reason: built.reason || "rejected",
        });
        continue;
      }
      const localRate = enforceRollingLimit(humanRelayWindowBySessionId, normalizedSessionId, {
        nowMs: normalizedNowMs,
        limit: HUMAN_MESSAGE_LIMIT_PER_MINUTE,
      });
      if (!localRate.allowed) {
        dropped.push({
          messageId: built.messageId,
          reason: "local_human_rate_limited",
        });
        continue;
      }
      acceptedEvents.push(built.event);
    }

    return {
      ok: true,
      reason: "",
      events: acceptedEvents,
      cursor: extractCursor(payload, fallbackCursor),
      dropped,
    };
  } catch (error) {
    recordCircuitFailure(inboundCircuit, normalizedNowMs);
    return {
      ok: false,
      reason: normalizeString(error?.message) || "poll_failed",
      events: [],
      cursor: normalizedSince || null,
    };
  }
}

/**
 * Poll the durable session-events endpoint for ALL events (not just
 * human-posted ones). Fixes the cross-agent blind spot Carter caught
 * in the standup session: agents polling via `pollHumanMessages` only
 * saw web-posted human messages, never each other's `session_message`
 * / `agent_response` events. The result was codex and claude talking
 * past each other ("Apologies — I missed your 5 updates").
 *
 * Endpoint contract: `GET /api/v1/sessions/{id}/events?after=<cursor>&limit=N`.
 * The API returns events in chronological order with cursor-based
 * pagination. We map each row to the local NDJSON envelope shape so
 * `appendToStream` accepts it without modification.
 *
 * @param {string} sessionId
 * @param {object} [options]
 * @param {string} [options.targetPath]
 * @param {string|null} [options.since] - cursor to start after; null = full history
 * @param {number} [options.limit]      - default 200 (max from API)
 * @param {number} [options.timeoutMs]  - per-request deadline
 * @returns {Promise<{ok: boolean, reason: string, events: Array<object>, cursor: string|null}>}
 */
export async function pollSessionEvents(
  sessionId,
  {
    targetPath = process.cwd(),
    since = null,
    limit = 200,
    timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
    forceCircuitProbe = false,
    resolveAuthSession = resolveActiveAuthSession,
    fetchImpl = fetchWithTimeout,
    nowMs = Date.now,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return {
      ok: false,
      reason: "invalid_session_id",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }

  const normalizedNowMs = Number(nowMs()) || Date.now();
  if (!forceCircuitProbe && isCircuitOpen(inboundCircuit, normalizedNowMs)) {
    return {
      ok: false,
      reason: "circuit_breaker_open",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }

  let session = null;
  try {
    session = await resolveAuthSession({
      cwd: targetPath,
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return {
      ok: false,
      reason: "no_session",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }
  if (!session || !session.token) {
    return {
      ok: false,
      reason: "not_authenticated",
      events: [],
      cursor: normalizeString(since) || null,
    };
  }

  const apiBaseUrl = resolveApiBaseUrl(session);
  const query = new URLSearchParams();
  const normalizedSince = normalizeString(since);
  if (normalizedSince) {
    query.set("after", normalizedSince);
  }
  query.set(
    "limit",
    String(Math.max(1, Math.min(SESSION_EVENT_FETCH_LIMIT, normalizePositiveInteger(limit, SESSION_EVENT_FETCH_LIMIT))))
  );
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/events?${query.toString()}`;

  try {
    const response = await fetchImpl(
      endpoint,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${session.token}` },
      },
      normalizePositiveInteger(timeoutMs, DEFAULT_SYNC_TIMEOUT_MS)
    );
    if (!response || !response.ok) {
      recordCircuitFailure(inboundCircuit, normalizedNowMs);
      return {
        ok: false,
        reason: `api_${response ? response.status : "no_response"}`,
        events: [],
        cursor: normalizedSince || null,
      };
    }
    const payload = await response.json().catch(() => ({}));
    recordCircuitSuccess(inboundCircuit);

    const items = Array.isArray(payload?.events) ? payload.events : [];
    const acceptedEvents = [];
    let lastCursor = normalizedSince || null;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const cursor = normalizeString(item.cursor);
      if (cursor) lastCursor = cursor;
      // Pass through verbatim — the API already returns the NDJSON
      // envelope shape that appendToStream expects.
      acceptedEvents.push(item);
    }

    return {
      ok: true,
      reason: "",
      events: acceptedEvents,
      cursor: lastCursor,
    };
  } catch (error) {
    recordCircuitFailure(inboundCircuit, normalizedNowMs);
    return {
      ok: false,
      reason: normalizeString(error?.message) || "poll_failed",
      events: [],
      cursor: normalizedSince || null,
    };
  }
}

/**
 * Poll the latest durable session events page via the reverse-history endpoint.
 *
 * This powers `sl session read --remote --tail`: a forward cursor can be many
 * pages behind in long rooms, but a tail read must show the latest messages now.
 * The API returns newest-first for `/events/before`; callers get chronological
 * order so appending/displaying matches the local NDJSON stream.
 */
export async function pollSessionEventsBefore(
  sessionId,
  {
    targetPath = process.cwd(),
    beforeSequence = null,
    limit = 50,
    timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
    forceCircuitProbe = false,
    resolveAuthSession = resolveActiveAuthSession,
    fetchImpl = fetchWithTimeout,
    nowMs = Date.now,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return {
      ok: false,
      reason: "invalid_session_id",
      events: [],
      cursor: null,
      beforeSequence: null,
    };
  }

  const normalizedNowMs = Number(nowMs()) || Date.now();
  if (!forceCircuitProbe && isCircuitOpen(inboundCircuit, normalizedNowMs)) {
    return {
      ok: false,
      reason: "circuit_breaker_open",
      events: [],
      cursor: null,
      beforeSequence: null,
    };
  }

  let session = null;
  try {
    session = await resolveAuthSession({
      cwd: targetPath,
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return {
      ok: false,
      reason: "no_session",
      events: [],
      cursor: null,
      beforeSequence: null,
    };
  }
  if (!session || !session.token) {
    return {
      ok: false,
      reason: "not_authenticated",
      events: [],
      cursor: null,
      beforeSequence: null,
    };
  }

  const apiBaseUrl = resolveApiBaseUrl(session);
  const query = new URLSearchParams();
  const normalizedBeforeSequence = Number(beforeSequence);
  if (Number.isFinite(normalizedBeforeSequence) && normalizedBeforeSequence > 0) {
    query.set("beforeSequence", String(Math.floor(normalizedBeforeSequence)));
  }
  query.set(
    "limit",
    String(Math.max(1, Math.min(SESSION_EVENT_FETCH_LIMIT, normalizePositiveInteger(limit, 50))))
  );
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/events/before?${query.toString()}`;

  try {
    const response = await fetchImpl(
      endpoint,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${session.token}` },
      },
      normalizePositiveInteger(timeoutMs, DEFAULT_SYNC_TIMEOUT_MS)
    );
    if (!response || !response.ok) {
      recordCircuitFailure(inboundCircuit, normalizedNowMs);
      return {
        ok: false,
        reason: `api_${response ? response.status : "no_response"}`,
        events: [],
        cursor: null,
        beforeSequence: Number.isFinite(normalizedBeforeSequence) ? normalizedBeforeSequence : null,
      };
    }
    const payload = await response.json().catch(() => ({}));
    recordCircuitSuccess(inboundCircuit);

    const events = chronologicalSessionEvents(payload?.events || []);
    const lastEvent = events[events.length - 1] || null;
    const firstEvent = events[0] || null;
    return {
      ok: true,
      reason: "",
      events,
      cursor: normalizeString(lastEvent?.cursor) || null,
      beforeSequence: eventSequenceNumber(firstEvent) || null,
    };
  } catch (error) {
    recordCircuitFailure(inboundCircuit, normalizedNowMs);
    return {
      ok: false,
      reason: normalizeString(error?.message) || "poll_failed",
      events: [],
      cursor: null,
      beforeSequence: Number.isFinite(normalizedBeforeSequence) ? normalizedBeforeSequence : null,
    };
  }
}


/**
 * List sessions owned by the active user via `GET /api/v1/sessions`.
 *
 * Mirrors the failure shape of `pollHumanMessages` so callers can render
 * a single error path: `{ ok, reason, sessions, count }`. Sessions are
 * returned in API order (newest-first per the server's contract); the
 * caller is responsible for any further sort or filter.
 *
 * @param {object} [options]
 * @param {string} [options.targetPath]
 * @param {boolean} [options.includeArchived]
 * @param {number} [options.limit]
 * @param {Function} [options.resolveAuthSession]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{ok: boolean, reason: string, sessions: Array<object>, count: number}>}
 */
export async function listSessionsFromApi({
  targetPath = process.cwd(),
  includeArchived = false,
  limit = 50,
  resolveAuthSession = resolveActiveAuthSession,
  fetchImpl = fetchWithTimeout,
  timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
} = {}) {
  let session;
  try {
    session = await resolveAuthSession({
      cwd: targetPath,
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return { ok: false, reason: "no_session", sessions: [], count: 0 };
  }
  if (!session || !session.token) {
    return { ok: false, reason: "not_authenticated", sessions: [], count: 0 };
  }

  const apiBaseUrl = resolveApiBaseUrl(session);
  const query = new URLSearchParams();
  if (includeArchived) query.set("include_archived", "true");
  const normalizedLimit = Math.max(1, Math.min(200, normalizePositiveInteger(limit, 50)));
  query.set("limit", String(normalizedLimit));
  const endpoint = `${apiBaseUrl}/api/v1/sessions?${query.toString()}`;

  let response;
  try {
    response = await fetchImpl(
      endpoint,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${session.token}` },
      },
      normalizePositiveInteger(timeoutMs, DEFAULT_SYNC_TIMEOUT_MS),
    );
  } catch (err) {
    return {
      ok: false,
      reason: normalizeString(err?.message) || "list_failed",
      sessions: [],
      count: 0,
    };
  }
  if (!response || !response.ok) {
    return {
      ok: false,
      reason: `api_${response ? response.status : "no_response"}`,
      sessions: [],
      count: 0,
    };
  }
  const payload = await response.json().catch(() => ({}));
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  return {
    ok: true,
    reason: "",
    sessions,
    count: typeof payload?.count === "number" ? payload.count : sessions.length,
  };
}

/**
 * Probe whether a single session is visible to the active user.
 *
 * Used by `session sync` to discriminate between "owned but empty" and
 * "not a member / wrong session id" — the former is a quiet success,
 * the latter deserves a loud hint.
 *
 * @returns {Promise<{accessible: boolean, reason: string, status?: number}>}
 */
export async function probeSessionAccess(
  sessionId,
  {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    fetchImpl = fetchWithTimeout,
    timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
  } = {},
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return { accessible: false, reason: "invalid_session_id" };
  }

  let session;
  try {
    session = await resolveAuthSession({
      cwd: targetPath,
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return { accessible: false, reason: "no_session" };
  }
  if (!session || !session.token) {
    return { accessible: false, reason: "not_authenticated" };
  }

  const apiBaseUrl = resolveApiBaseUrl(session);
  const endpoint = `${apiBaseUrl}/api/v1/sessions/${encodeURIComponent(
    normalizedSessionId,
  )}/events?limit=1`;

  let response;
  try {
    response = await fetchImpl(
      endpoint,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${session.token}` },
      },
      normalizePositiveInteger(timeoutMs, DEFAULT_SYNC_TIMEOUT_MS),
    );
  } catch (err) {
    return {
      accessible: false,
      reason: normalizeString(err?.message) || "probe_failed",
    };
  }

  if (response && response.ok) {
    return { accessible: true, reason: "", status: response.status };
  }
  if (!response) {
    return { accessible: false, reason: "no_response" };
  }
  if (response.status === 403) {
    return { accessible: false, reason: "not_a_member", status: 403 };
  }
  if (response.status === 404) {
    return { accessible: false, reason: "session_not_found", status: 404 };
  }
  return { accessible: false, reason: `api_${response.status}`, status: response.status };
}

export function resetSessionSyncStateForTests() {
  outboundCircuit.consecutiveFailures = 0;
  outboundCircuit.openedAtMs = 0;
  inboundCircuit.consecutiveFailures = 0;
  inboundCircuit.openedAtMs = 0;
  sessionIngestWindowBySessionId.clear();
  humanRelayWindowBySessionId.clear();
  autoGrantAttemptedAgentIds.clear();
  // Tests that exercise the network path explicitly need the
  // SENTINELAYER_SKIP_REMOTE_SYNC guard off — otherwise the function
  // short-circuits before the mocked fetchImpl is ever called. Tests that
  // want the guard on can re-set the env after resetting.
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
}

export {
  CIRCUIT_RESET_MS,
  HUMAN_MESSAGE_LIMIT_PER_MINUTE,
  HUMAN_MESSAGE_MAX_LENGTH,
  MAX_CONSECUTIVE_FAILURES,
  SESSION_INGEST_LIMIT_PER_MINUTE,
};
