import { setTimeout as delay } from "node:timers/promises";

import {
  pollSessionEvents,
  pollSessionEventsBefore,
  streamSessionEvents,
  updateSessionReadCursor,
} from "./sync.js";
import { cursorAdvances, readSyncCursor, writeSyncCursor } from "./sync-cursor.js";
import { isSessionListenerLifecycleEvent } from "./control-events.js";

const BROADCAST_RECIPIENTS = new Set([
  "*",
  "all",
  "broadcast",
  "everyone",
  "anyone",
  "agents",
  "all-agents",
]);

const DEFAULT_ACTIVE_INTERVAL_SECONDS = 60;
const DEFAULT_ACTIVE_WINDOW_SECONDS = 300;
const DEFAULT_POLL_JITTER_RATIO = 0.2;
const DEFAULT_MAX_POLL_BACKOFF_SECONDS = 300;
const MAX_CLOCK_SKEW_MS = 60_000;

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

function isListenerStopDirective(event = {}) {
  return normalizeString(event?.event) === "listener_stop";
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

function latestSequenceTarget(events = [], fallbackCursor = null) {
  let targetSequenceId = null;
  let targetCursor = normalizeString(fallbackCursor) || "";
  for (const event of Array.isArray(events) ? events : []) {
    const sequence = Number(event?.sequenceId ?? event?.sequence_id ?? event?.sequence);
    if (Number.isFinite(sequence) && sequence > 0) {
      if (targetSequenceId === null || sequence > targetSequenceId) {
        targetSequenceId = Math.floor(sequence);
        targetCursor = normalizeString(event?.cursor) || targetCursor;
      }
      continue;
    }
    const cursor = normalizeString(event?.cursor);
    if (cursor) targetCursor = cursor;
  }
  return { targetSequenceId, targetCursor };
}

export function computeListenerPollDelay({
  baseDelayMs,
  consecutiveFailures = 0,
  retryAfterMs = null,
  jitterRatio = DEFAULT_POLL_JITTER_RATIO,
  maxBackoffMs = DEFAULT_MAX_POLL_BACKOFF_SECONDS * 1000,
  randomValue = Math.random(),
} = {}) {
  const base = Math.max(1, Math.floor(Number(baseDelayMs) || 1));
  const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
  const maxBackoff = Math.max(base, Math.floor(Number(maxBackoffMs) || base));
  const exponential = failures > 0
    ? Math.min(maxBackoff, base * (2 ** Math.min(failures - 1, 20)))
    : base;
  const retryFloor = Math.max(0, Math.ceil(Number(retryAfterMs) || 0));
  const boundedJitterRatio = Math.max(0, Math.min(0.5, Number(jitterRatio) || 0));
  const boundedRandom = Math.max(0, Math.min(1, Number(randomValue) || 0));
  const jitter = Math.floor(exponential * boundedJitterRatio * boundedRandom);
  const jitteredBackoff = Math.min(maxBackoff, exponential + jitter);
  return Math.max(retryFloor, jitteredBackoff);
}

function eventIdentityKey(event = {}) {
  const cursor = normalizeString(event?.cursor);
  if (cursor) return `cursor:${cursor}`;
  const sequence = normalizeString(event?.sequenceId || event?.sequence_id || event?.sequence);
  if (sequence) return `sequence:${sequence}`;
  return JSON.stringify({
    event: normalizeString(event?.event),
    agent: normalizeString(event?.agent?.id || event?.agentId),
    ts: normalizeString(event?.ts || event?.timestamp || event?.createdAt || event?.at),
    message: normalizeString(event?.payload?.message || event?.payload?.text || event?.payload?.detail),
  });
}

function eventTimestampMs(event = {}) {
  for (const key of ["ts", "timestamp", "createdAt", "at"]) {
    const epoch = Date.parse(normalizeString(event?.[key]));
    if (Number.isFinite(epoch)) return epoch;
  }
  return 0;
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function isHumanMarker(value) {
  const raw = normalizeLower(value);
  if (!raw) return false;
  if (["human", "user", "operator"].includes(raw)) return true;
  const comparable = normalizeComparableId(raw);
  return Boolean(
    comparable === "human" ||
      comparable === "user" ||
      comparable === "operator" ||
      comparable.startsWith("human-") ||
      comparable.startsWith("user-")
  );
}

function isHumanAuthoredEvent(event = {}) {
  if (!isPlainObject(event)) return false;
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const agent = isPlainObject(event.agent) ? event.agent : {};
  const markerCandidates = [
    payload.source,
    payload.authorType,
    payload.senderType,
    payload.model,
    payload.role,
    event.source,
    event.authorType,
    event.senderType,
    event.model,
    event.role,
    agent.model,
    agent.role,
  ];
  if (markerCandidates.some(isHumanMarker)) return true;

  const idCandidates = [
    agent.id,
    event.agentId,
    event.authorId,
    event.senderId,
    payload.agentId,
    payload.authorId,
    payload.senderId,
  ];
  return idCandidates.some(isHumanMarker);
}

function humanActivityTimestampMs(event = {}, nowMs = Date.now()) {
  if (!isHumanAuthoredEvent(event)) return 0;
  return eventTimestampMs(event) || nowMs;
}

function eventTimeRange(events = []) {
  let oldestMs = 0;
  let newestMs = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const timeMs = eventTimestampMs(event);
    if (!timeMs) continue;
    if (!oldestMs || timeMs < oldestMs) oldestMs = timeMs;
    if (!newestMs || timeMs > newestMs) newestMs = timeMs;
  }
  return {
    oldestEventAt: oldestMs ? new Date(oldestMs).toISOString() : null,
    newestEventAt: newestMs ? new Date(newestMs).toISOString() : null,
  };
}

function isRecentActivity(activityMs, nowMs, windowMs) {
  return (
    Number.isFinite(activityMs) &&
    activityMs > 0 &&
    activityMs <= nowMs + MAX_CLOCK_SKEW_MS &&
    nowMs - activityMs <= windowMs
  );
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
  activeIntervalSeconds = DEFAULT_ACTIVE_INTERVAL_SECONDS,
  activeWindowSeconds = DEFAULT_ACTIVE_WINDOW_SECONDS,
  jitterRatio = DEFAULT_POLL_JITTER_RATIO,
  maxBackoffSeconds = DEFAULT_MAX_POLL_BACKOFF_SECONDS,
  limit = 200,
  since = undefined,
  replay = false,
  fromNow = false,
  persistStartCursor = false,
  maxPolls = null,
  signal,
  onEvent = async () => {},
  onError = async () => {},
  onCatchup = async () => {},
  onLifecycle = async () => {},
  transport = "poll",
  _poll = pollSessionEvents,
  _pollLatest = pollSessionEventsBefore,
  _stream = streamSessionEvents,
  _updateReadCursor = updateSessionReadCursor,
  _readCursor = readSyncCursor,
  _writeCursor = writeSyncCursor,
  _sleep = defaultSleep,
  _setInterval = setInterval,
  _clearInterval = clearInterval,
  _nowMs = Date.now,
  _random = Math.random,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedAgentId = normalizeComparableId(agentId) || "cli-user";
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }

  if (fromNow && since !== undefined) {
    throw new Error("Use either fromNow or since, not both.");
  }
  const normalizedTransport = normalizeLower(transport) || "poll";
  if (!["auto", "poll", "stream"].includes(normalizedTransport)) {
    throw new Error("transport must be one of: auto, poll, stream.");
  }

  const cursorSuffix = listenCursorSuffix(normalizedAgentId);
  const explicitSince = typeof since === "string" || since === null;
  let cursor = explicitSince
    ? normalizeString(since) || null
    : await _readCursor(normalizedSessionId, { targetPath, suffix: cursorSuffix });
  let cursorSource = explicitSince ? "explicit" : cursor ? "stored" : "none";
  let primed = Boolean(cursor) || Boolean(replay);
  let pollCount = 0;
  let emitted = 0;
  let matched = 0;
  let persistedCursor = false;
  let lastReason = "";
  let activeTransport = normalizedTransport === "poll" ? "poll" : "stream";
  let streamAttempted = false;
  let streamFallbackReason = "";
  let heartbeatCount = 0;
  let consecutivePollFailures = 0;
  let readCursorUpdates = 0;
  let readCursorReason = "";
  let catchupNotified = false;
  let catchupEventCount = 0;
  let catchupMatchingEventCount = 0;
  const emittedKeys = new Set();
  const maxPollCount = normalizePositiveInteger(maxPolls, 0);
  const pollLimit = normalizePositiveInteger(limit, 200);
  const idleSleepMs = Math.max(1, normalizePositiveInteger(intervalSeconds, 60)) * 1000;
  const activeSleepMs =
    Math.max(1, normalizePositiveInteger(activeIntervalSeconds, DEFAULT_ACTIVE_INTERVAL_SECONDS)) *
    1000;
  const activeWindowMs =
    Math.max(1, normalizePositiveInteger(activeWindowSeconds, DEFAULT_ACTIVE_WINDOW_SECONDS)) *
    1000;
  const maxBackoffMs =
    Math.max(1, normalizePositiveInteger(maxBackoffSeconds, DEFAULT_MAX_POLL_BACKOFF_SECONDS)) *
    1000;
  const autoStreamIdleTimeoutMs =
    normalizedTransport === "auto" ? Math.max(5_000, Math.min(idleSleepMs, 30_000)) : 0;

  if (fromNow) {
    const latest = await _pollLatest(normalizedSessionId, {
      targetPath,
      limit: 1,
      forceCircuitProbe: true,
    });
    if (!latest?.ok) {
      throw new Error(`Unable to start listener from the latest event (${latest?.reason || "unknown"}).`);
    }
    cursor = normalizeString(latest.cursor) || null;
    cursorSource = cursor ? "from_now" : "none";
    primed = Boolean(cursor) || Boolean(replay);
    if (cursor && persistStartCursor) {
      const writeResult = await _writeCursor(normalizedSessionId, cursor, {
        targetPath,
        suffix: cursorSuffix,
      }).catch(() => null);
      persistedCursor = Boolean(writeResult?.written) || persistedCursor;
    }
  }

  const startedAtMs = Number(_nowMs()) || Date.now();
  let lastHumanActivityMs = 0;
  let lastSleepMs = 0;

  const lifecycleSnapshot = (type, extra = {}) => ({
    type,
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    cursor: cursor || null,
    cursorSuffix,
    pollCount,
    heartbeatCount,
    matched,
    emitted,
    persistedCursor,
    cursorSource,
    transport: activeTransport,
    idleIntervalSeconds: Math.round(idleSleepMs / 1000),
    activeIntervalSeconds: Math.round(activeSleepMs / 1000),
    activeWindowSeconds: Math.round(activeWindowMs / 1000),
    lastHumanActivityAt: lastHumanActivityMs
      ? new Date(lastHumanActivityMs).toISOString()
      : null,
    lastSleepMs,
    consecutivePollFailures,
    readCursorUpdates,
    readCursorReason,
    reason: lastReason,
    ...extra,
  });

  async function notifyCatchup(payload) {
    try {
      await onCatchup(payload);
    } catch (error) {
      await onError({
        ok: false,
        reason: "catchup_notice_failed",
        cursor: payload.cursor || cursor || null,
        detail: normalizeString(error?.message),
      });
    }
  }

  async function notifyLifecycle(payload) {
    try {
      await onLifecycle(payload);
    } catch (error) {
      await onError({
        ok: false,
        reason: `lifecycle_${payload.type}_failed`,
        cursor: payload.cursor || cursor || null,
        detail: normalizeString(error?.message),
      });
    }
  }

  async function processEventBatch(eventsInput = [], resultCursor = null) {
    const events = Array.isArray(eventsInput) ? eventsInput : [];
    const nextCursor = normalizeString(resultCursor) || cursorFromEvents(events, cursor);
    const cursorDidNotAdvance = Boolean(nextCursor && cursor && !cursorAdvances(nextCursor, cursor));
    const cursorFault = cursorDidNotAdvance && (nextCursor !== cursor || events.length > 0);
    if (cursorFault) {
      lastReason = "cursor_not_advanced";
      await onError({
        ok: false,
        reason: lastReason,
        cursor: cursor || null,
        candidateCursor: nextCursor,
      });
      return { processed: false, retryAfterMs: null };
    }

    const observedAtMs = Number(_nowMs()) || Date.now();
    const visibleEvents = [];
    let preStartEventCount = 0;
    for (const event of events) {
      if (!isPlainObject(event)) continue;
      const timestampMs = eventTimestampMs(event);
      if (!timestampMs || timestampMs < startedAtMs) {
        preStartEventCount += 1;
      }
      const activityMs = humanActivityTimestampMs(event, observedAtMs);
      if (isRecentActivity(activityMs, observedAtMs, activeWindowMs)) {
        lastHumanActivityMs = Math.max(lastHumanActivityMs, activityMs);
      }
      if (timestampMs && timestampMs < startedAtMs && isListenerStopDirective(event)) continue;
      if (isSessionListenerLifecycleEvent(event)) continue;
      if (!eventMatchesAgent(event, normalizedAgentId)) continue;
      visibleEvents.push(event);
    }

    if (
      !catchupNotified &&
      cursorSource === "stored" &&
      Boolean(cursor) &&
      events.length > 0 &&
      preStartEventCount > 0
    ) {
      catchupNotified = true;
      catchupEventCount = events.length;
      catchupMatchingEventCount = visibleEvents.length;
      await notifyCatchup({
        type: "catchup",
        sessionId: normalizedSessionId,
        agentId: normalizedAgentId,
        cursor: cursor || null,
        candidateCursor: nextCursor || null,
        cursorSuffix,
        cursorSource,
        pollCount,
        eventCount: events.length,
        matchingEventCount: visibleEvents.length,
        preStartEventCount,
        limit: pollLimit,
        replay: Boolean(replay),
        ...eventTimeRange(events),
      });
    }

    const shouldEmitBatch = primed || Boolean(replay);
    for (const event of visibleEvents) {
      const key = eventIdentityKey(event);
      if (emittedKeys.has(key)) continue;
      matched += 1;
      if (!shouldEmitBatch && eventTimestampMs(event) < startedAtMs) continue;
      emittedKeys.add(key);
      try {
        await onEvent(event);
        emitted += 1;
      } catch (error) {
        emittedKeys.delete(key);
        throw error;
      }
    }

    if (nextCursor && nextCursor !== cursor) {
      const writeResult = await _writeCursor(normalizedSessionId, nextCursor, {
        targetPath,
        suffix: cursorSuffix,
      }).catch(() => null);
      persistedCursor = Boolean(writeResult?.written) || persistedCursor;
      cursor = nextCursor;
    }
    // A fetch cursor echoed on an empty page is transport state, not new read
    // progress. Writing it would recreate one operational write per idle poll.
    const readTarget = events.length > 0
      ? latestSequenceTarget(events, nextCursor)
      : { targetSequenceId: null, targetCursor: "" };
    let readCursorResult = null;
    if (readTarget.targetSequenceId || readTarget.targetCursor) {
      readCursorResult = await _updateReadCursor(normalizedSessionId, {
        targetPath,
        targetSequenceId: readTarget.targetSequenceId,
        targetCursor: readTarget.targetCursor,
        agentId: normalizedAgentId,
      }).catch((error) => ({
        ok: false,
        reason: normalizeString(error?.message) || "read_cursor_write_failed",
      }));
      if (readCursorResult?.ok) {
        readCursorUpdates += 1;
        readCursorReason = "";
      } else {
        readCursorReason = normalizeString(readCursorResult?.reason) || "read_cursor_write_failed";
      }
    }
    primed = true;
    return {
      processed: true,
      retryAfterMs: Number(readCursorResult?.retryAfterMs) || null,
    };
  }

  async function notifyHeartbeat({ stopping = false, nextPollMs = null } = {}) {
    heartbeatCount += 1;
    const heartbeatAtMs = Number(_nowMs()) || Date.now();
    const humanActive = isRecentActivity(lastHumanActivityMs, heartbeatAtMs, activeWindowMs);
    await notifyLifecycle(
      lifecycleSnapshot("heartbeat", {
        active: humanActive,
        state: humanActive ? "active" : "idle",
        nextPollMs,
        stopping,
        transport: activeTransport,
      }),
    );
    return humanActive;
  }

  let streamHeartbeatTimer = null;
  let streamHeartbeatInFlight = false;
  const streamHeartbeatMs = Math.max(1_000, Math.min(idleSleepMs, 60_000));

  function stopStreamHeartbeatTimer() {
    if (!streamHeartbeatTimer) return;
    _clearInterval(streamHeartbeatTimer);
    streamHeartbeatTimer = null;
  }

  function startStreamHeartbeatTimer() {
    stopStreamHeartbeatTimer();
    streamHeartbeatTimer = _setInterval(async () => {
      if (signal?.aborted || streamHeartbeatInFlight) return;
      streamHeartbeatInFlight = true;
      try {
        await notifyHeartbeat({ nextPollMs: streamHeartbeatMs });
      } finally {
        streamHeartbeatInFlight = false;
      }
    }, streamHeartbeatMs);
  }

  await notifyLifecycle(
    lifecycleSnapshot("started", {
      startedAt: new Date(startedAtMs).toISOString(),
      transport: activeTransport,
    }),
  );

  try {
    if (normalizedTransport !== "poll") {
      streamAttempted = true;
      activeTransport = "stream";
      startStreamHeartbeatTimer();
      const streamResult = await _stream(normalizedSessionId, {
        targetPath,
        since: cursor,
        idleTimeoutMs: autoStreamIdleTimeoutMs,
        signal,
        onEvent: async (event) => {
          await processEventBatch([event], normalizeString(event?.cursor) || cursor);
        },
        onError: async (error) => {
          lastReason = `stream_${normalizeString(error?.reason) || "error"}`;
          await onError({
            ok: false,
            reason: lastReason,
            cursor: error?.cursor || cursor || null,
          });
        },
        onHeartbeat: async () => {
          await notifyHeartbeat({ nextPollMs: streamHeartbeatMs });
        },
      }).finally(() => {
        stopStreamHeartbeatTimer();
      });
      if (!streamResult?.ok) {
        streamFallbackReason = normalizeString(streamResult?.reason) || lastReason || "stream_failed";
        lastReason = `stream_${streamFallbackReason}`;
      } else if (!signal?.aborted) {
        streamFallbackReason = "stream_closed";
      }
    }

    const shouldPoll =
      !signal?.aborted && (normalizedTransport === "poll" || normalizedTransport === "auto");
    if (shouldPoll) {
      activeTransport = "poll";
    }
    while (shouldPoll && !signal?.aborted) {
      pollCount += 1;
      const result = await _poll(normalizedSessionId, {
        targetPath,
        since: cursor,
        limit: pollLimit,
      });

      let cursorRetryAfterMs = null;
      if (result?.ok) {
        lastReason = "";
        consecutivePollFailures = 0;
        const processed = await processEventBatch(result.events, result.cursor);
        cursorRetryAfterMs = Number(processed?.retryAfterMs) || null;
      } else {
        lastReason = normalizeString(result?.reason) || "poll_failed";
        consecutivePollFailures += 1;
        await onError({
          ok: false,
          reason: lastReason,
          cursor: result?.cursor || cursor || null,
          retryAfterMs: Number(result?.retryAfterMs) || null,
          status: Number(result?.status) || null,
        });
      }

      const willStop = maxPollCount > 0 && pollCount >= maxPollCount;
      const heartbeatAtMs = Number(_nowMs()) || Date.now();
      const humanActive = isRecentActivity(lastHumanActivityMs, heartbeatAtMs, activeWindowMs);
      const baseSleepMs = humanActive ? Math.min(idleSleepMs, activeSleepMs) : idleSleepMs;
      const nextSleepMs = computeListenerPollDelay({
        baseDelayMs: baseSleepMs,
        consecutiveFailures: consecutivePollFailures,
        retryAfterMs: Math.max(
          Number(result?.retryAfterMs) || 0,
          Number(cursorRetryAfterMs) || 0,
        ),
        jitterRatio,
        maxBackoffMs,
        randomValue: _random(),
      });
      await notifyHeartbeat({ nextPollMs: willStop ? null : nextSleepMs, stopping: willStop });

      if (willStop) break;
      lastSleepMs = nextSleepMs;
      try {
        await _sleep(nextSleepMs, { signal });
      } catch (error) {
        if (shouldAbort(error, signal)) break;
        throw error;
      }
    }
  } finally {
    await notifyLifecycle(
      lifecycleSnapshot("stopped", {
        stoppedAt: new Date(Number(_nowMs()) || Date.now()).toISOString(),
        aborted: Boolean(signal?.aborted),
      }),
    );
  }

  return {
    ok: true,
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    cursor,
    cursorSuffix,
    cursorSource,
    transport: activeTransport,
    streamAttempted,
    streamFallbackReason,
    pollCount,
    matched,
    emitted,
    persistedCursor,
    readCursorUpdates,
    readCursorReason,
    consecutivePollFailures,
    catchupNotified,
    catchupEventCount,
    catchupMatchingEventCount,
    idleIntervalSeconds: Math.round(idleSleepMs / 1000),
    activeIntervalSeconds: Math.round(activeSleepMs / 1000),
    activeWindowSeconds: Math.round(activeWindowMs / 1000),
    lastHumanActivityAt: lastHumanActivityMs ? new Date(lastHumanActivityMs).toISOString() : null,
    lastSleepMs,
    reason: lastReason,
  };
}
