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

const outboundCircuit = {
  consecutiveFailures: 0,
  openedAtMs: 0,
};

const inboundCircuit = {
  consecutiveFailures: 0,
  openedAtMs: 0,
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

function resolveApiBaseUrl(session = {}) {
  const apiUrl = normalizeString(session.apiUrl) || DEFAULT_API_BASE_URL;
  return apiUrl.replace(/\/+$/, "");
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
}

function recordCircuitSuccess(circuit) {
  if (!circuit) {
    return;
  }
  circuit.consecutiveFailures = 0;
  circuit.openedAtMs = 0;
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
