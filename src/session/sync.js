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

  if (event?.payload?.relayedFromApi) {
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
          event,
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
  if (isCircuitOpen(inboundCircuit, normalizedNowMs)) {
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
}

export {
  CIRCUIT_RESET_MS,
  HUMAN_MESSAGE_LIMIT_PER_MINUTE,
  HUMAN_MESSAGE_MAX_LENGTH,
  MAX_CONSECUTIVE_FAILURES,
  SESSION_INGEST_LIMIT_PER_MINUTE,
};
