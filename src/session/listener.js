import { setTimeout as delay } from "node:timers/promises";

import { pollSessionEvents } from "./sync.js";
import { readSyncCursor, writeSyncCursor } from "./sync-cursor.js";

const BROADCAST_RECIPIENTS = new Set([
  "*",
  "all",
  "broadcast",
  "everyone",
  "anyone",
  "agents",
  "all-agents",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeComparableId(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return fallbackValue;
  return Math.floor(normalized);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addRecipientValue(values, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) addRecipientValue(values, item);
    return;
  }
  if (isPlainObject(value)) {
    addRecipientValue(values, value.id || value.agentId || value.name);
    return;
  }
  const raw = normalizeString(value);
  if (!raw) return;
  for (const token of raw.split(/[\s,;]+/g)) {
    const normalized = normalizeString(token);
    if (normalized) values.push(normalized);
  }
}

export function collectSessionEventRecipients(event = {}) {
  const values = [];
  if (!isPlainObject(event)) return values;
  const payload = isPlainObject(event.payload) ? event.payload : {};
  for (const source of [
    event.to,
    event.recipient,
    event.recipients,
    event.targetAgent,
    event.targetAgentId,
    payload.to,
    payload.recipient,
    payload.recipients,
    payload.targetAgent,
    payload.targetAgentId,
  ]) {
    addRecipientValue(values, source);
  }
  return values;
}

export function eventMatchesAgent(event = {}, agentId = "") {
  if (!isPlainObject(event)) return false;
  const normalizedAgentId = normalizeComparableId(agentId);
  if (!normalizedAgentId) return false;

  const payload = isPlainObject(event.payload) ? event.payload : {};
  if (event.broadcast === true || payload.broadcast === true) return true;

  const recipients = collectSessionEventRecipients(event);
  if (recipients.length === 0) return true;

  for (const recipient of recipients) {
    const rawRecipient = normalizeString(recipient).toLowerCase();
    if (BROADCAST_RECIPIENTS.has(rawRecipient)) return true;
    const normalizedRecipient = normalizeComparableId(recipient);
    if (!normalizedRecipient) continue;
    if (BROADCAST_RECIPIENTS.has(normalizedRecipient)) return true;
    if (normalizedRecipient === normalizedAgentId) return true;
  }
  return false;
}

export function listenCursorSuffix(agentId = "") {
  return `listen-${normalizeComparableId(agentId) || "agent"}`;
}

async function defaultSleep(ms, { signal } = {}) {
  await delay(ms, undefined, { signal });
}

function shouldAbort(error, signal) {
  return Boolean(signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR");
}

function cursorFromEvents(events = [], fallbackCursor = null) {
  let cursor = normalizeString(fallbackCursor) || null;
  for (const event of events) {
    const candidate = normalizeString(event?.cursor);
    if (candidate) cursor = candidate;
  }
  return cursor;
}

function eventTimestampMs(event = {}) {
  for (const key of ["ts", "timestamp", "createdAt", "at"]) {
    const epoch = Date.parse(normalizeString(event?.[key]));
    if (Number.isFinite(epoch)) return epoch;
  }
  return 0;
}

/**
 * Poll session events in the background and emit only events addressed to
 * the current agent or broadcast to everyone. The loop advances its cursor
 * across non-matching events so direct listeners do not replay unrelated
 * traffic forever.
 */
export async function listenSessionEvents({
  sessionId,
  targetPath = process.cwd(),
  agentId = "cli-user",
  intervalSeconds = 60,
  limit = 200,
  since = undefined,
  replay = false,
  maxPolls = null,
  signal,
  onEvent = async () => {},
  onError = async () => {},
  _poll = pollSessionEvents,
  _readCursor = readSyncCursor,
  _writeCursor = writeSyncCursor,
  _sleep = defaultSleep,
  _nowMs = Date.now,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedAgentId = normalizeComparableId(agentId) || "cli-user";
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }

  const cursorSuffix = listenCursorSuffix(normalizedAgentId);
  let cursor =
    typeof since === "string" || since === null
      ? normalizeString(since) || null
      : await _readCursor(normalizedSessionId, { targetPath, suffix: cursorSuffix });
  let primed = Boolean(cursor) || Boolean(replay);
  let pollCount = 0;
  let emitted = 0;
  let matched = 0;
  let persistedCursor = false;
  let lastReason = "";
  const maxPollCount = normalizePositiveInteger(maxPolls, 0);
  const pollLimit = normalizePositiveInteger(limit, 200);
  const sleepMs = Math.max(1, normalizePositiveInteger(intervalSeconds, 60)) * 1000;
  const startedAtMs = Number(_nowMs()) || Date.now();

  while (!signal?.aborted) {
    pollCount += 1;
    const result = await _poll(normalizedSessionId, {
      targetPath,
      since: cursor,
      limit: pollLimit,
    });

    if (result?.ok) {
      lastReason = "";
      const events = Array.isArray(result.events) ? result.events : [];
      const shouldEmitBatch = primed || Boolean(replay);
      for (const event of events) {
        if (!eventMatchesAgent(event, normalizedAgentId)) continue;
        matched += 1;
        if (!shouldEmitBatch && eventTimestampMs(event) < startedAtMs) continue;
        await onEvent(event);
        emitted += 1;
      }

      const nextCursor = normalizeString(result.cursor) || cursorFromEvents(events, cursor);
      if (nextCursor && nextCursor !== cursor) {
        const writeResult = await _writeCursor(normalizedSessionId, nextCursor, {
          targetPath,
          suffix: cursorSuffix,
        }).catch(() => null);
        persistedCursor = Boolean(writeResult?.written) || persistedCursor;
        cursor = nextCursor;
      }
      primed = true;
    } else {
      lastReason = normalizeString(result?.reason) || "poll_failed";
      await onError({
        ok: false,
        reason: lastReason,
        cursor: result?.cursor || cursor || null,
      });
    }

    if (maxPollCount > 0 && pollCount >= maxPollCount) break;
    try {
      await _sleep(sleepMs, { signal });
    } catch (error) {
      if (shouldAbort(error, signal)) break;
      throw error;
    }
  }

  return {
    ok: true,
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    cursor,
    cursorSuffix,
    pollCount,
    matched,
    emitted,
    persistedCursor,
    reason: lastReason,
  };
}
