import { pollSessionEventsBefore } from "./sync.js";

const LISTENER_EVENT_TYPES = new Set([
  "session_listener_started",
  "session_listener_heartbeat",
  "session_listener_stopped",
]);

// A heartbeat older than this (and not explicitly stopped) means the
// listener likely died without a clean stop — show it as stale, not live.
const DEFAULT_STALE_AFTER_MS = 180_000;
const MAX_STALE_GRACE_MS = 60_000;
const DEFAULT_LISTENER_FETCH_LIMIT = 200;
const DEFAULT_LISTENER_FETCH_MAX_PAGES = 5;
const MAX_LISTENER_FETCH_MAX_PAGES = 25;

function normalizeString(value) {
  return String(value || "").trim();
}

function eventEpochMs(event) {
  const raw = normalizeString(event?.ts) || normalizeString(event?.timestamp);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function listenerStaleAfterMs({
  staleAfterMs,
  presenceKeepaliveSeconds,
  presenceIntervalSeconds,
  cadenceSeconds,
  idleIntervalSeconds,
  activeIntervalSeconds,
} = {}) {
  const fallbackMs = Math.max(1, Number(staleAfterMs) || DEFAULT_STALE_AFTER_MS);
  const keepaliveMs = presenceKeepaliveSeconds ? presenceKeepaliveSeconds * 1000 : null;
  const expectedIntervalSeconds =
    cadenceSeconds ||
    presenceIntervalSeconds ||
    idleIntervalSeconds ||
    activeIntervalSeconds ||
    null;
  const expectedIntervalMs = expectedIntervalSeconds ? expectedIntervalSeconds * 1000 : 0;

  if (keepaliveMs) {
    // The listener can only publish on a poll tick. Allow one bounded poll
    // interval after the advertised keepalive, not the old 2.5x keepalive
    // window that made dead listeners look live for several extra minutes.
    return keepaliveMs + Math.min(expectedIntervalMs || 0, MAX_STALE_GRACE_MS);
  }

  if (expectedIntervalMs) {
    return Math.max(fallbackMs, Math.round(expectedIntervalMs * 2.5));
  }

  return fallbackMs;
}

/**
 * Reduce a stream of session_listener_* events into one row per agent: who is
 * listening, at what cadence, and whether they're currently active or idle.
 * Pure + testable — the command layer just fetches events and renders this.
 */
export function summarizeListeners(events = [], { nowMs = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const latestByAgent = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const type = normalizeString(event?.event);
    if (!LISTENER_EVENT_TYPES.has(type)) continue;
    const agentId = normalizeString(event?.agent?.id) || normalizeString(readRecord(event?.payload).listenerId);
    if (!agentId) continue;
    const epoch = eventEpochMs(event) ?? 0;
    const existing = latestByAgent.get(agentId);
    if (!existing || epoch >= existing.epoch) {
      latestByAgent.set(agentId, { event, type, epoch });
    }
  }

  const rows = [];
  for (const [agentId, { event, type, epoch }] of latestByAgent) {
    const payload = readRecord(event.payload);
    const ageMs = epoch ? Math.max(0, nowMs - epoch) : null;
    const stopped = type === "session_listener_stopped";
    const active = Boolean(payload.active);
    const idleIntervalSeconds = positiveInt(payload.idleIntervalSeconds);
    const activeIntervalSeconds = positiveInt(payload.activeIntervalSeconds);
    const presenceKeepaliveSeconds = positiveInt(payload.presenceKeepaliveSeconds);
    const presenceIntervalSeconds = positiveInt(payload.presenceIntervalSeconds);
    const nextPollSeconds = positiveInt(payload.nextPollMs)
      ? Math.round(positiveInt(payload.nextPollMs) / 1000)
      : null;
    // The effective cadence right now: active window uses the fast interval,
    // otherwise the idle interval; fall back to the reported next poll.
    const cadenceSeconds = active
      ? activeIntervalSeconds || nextPollSeconds
      : idleIntervalSeconds || nextPollSeconds;
    const staleAfterForRowMs = listenerStaleAfterMs({
      staleAfterMs,
      presenceKeepaliveSeconds,
      presenceIntervalSeconds,
      cadenceSeconds,
      idleIntervalSeconds,
      activeIntervalSeconds,
    });
    let status;
    if (stopped) status = "stopped";
    else if (ageMs !== null && ageMs > staleAfterForRowMs) status = "stale";
    else status = active ? "active" : "idle";

    rows.push({
      agentId,
      displayName: normalizeString(event.agent?.displayName) || agentId,
      model: normalizeString(event.agent?.model),
      status,
      active,
      cadenceSeconds: cadenceSeconds ?? null,
      idleIntervalSeconds,
      activeIntervalSeconds,
      presenceIntervalSeconds,
      presenceKeepaliveSeconds,
      nextPollSeconds,
      staleAfterSeconds: Math.round(staleAfterForRowMs / 1000),
      lastSeenAt: epoch ? new Date(epoch).toISOString() : null,
      lastSeenAgoSeconds: ageMs !== null ? Math.round(ageMs / 1000) : null,
      lastHumanActivityAt: normalizeString(payload.lastHumanActivityAt) || null,
    });
  }

  // Live listeners first, then by most-recently-seen.
  const statusRank = { active: 0, idle: 1, stale: 2, stopped: 3 };
  rows.sort((a, b) => {
    const r = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (r !== 0) return r;
    return (b.lastSeenAt || "").localeCompare(a.lastSeenAt || "");
  });
  return rows;
}

/**
 * Fetch recent session events from the API and summarize the listeners.
 * `limit` controls the raw API page size. Busy rooms can push durable
 * keepalive heartbeats out of a single tail page, so we walk a small bounded
 * number of older pages while the tail contains no listener lifecycle events
 * and the sequence cursor advances.
 */
export async function fetchSessionListeners(
  sessionId,
  {
    targetPath = process.cwd(),
    limit = DEFAULT_LISTENER_FETCH_LIMIT,
    maxPages = DEFAULT_LISTENER_FETCH_MAX_PAGES,
    nowMs = Date.now,
    forceCircuitProbe = true,
    poll = pollSessionEventsBefore,
  } = {}
) {
  const pageLimit = Math.max(
    1,
    Math.min(DEFAULT_LISTENER_FETCH_LIMIT, positiveInt(limit) || DEFAULT_LISTENER_FETCH_LIMIT),
  );
  const maxPageCount = Math.max(
    1,
    Math.min(MAX_LISTENER_FETCH_MAX_PAGES, positiveInt(maxPages) || DEFAULT_LISTENER_FETCH_MAX_PAGES),
  );
  let beforeSequence = null;
  let latestResult = null;
  let allEvents = [];
  let pageCount = 0;
  let listenerEventCount = 0;
  let partial = false;
  let partialReason = "";

  for (let page = 0; page < maxPageCount; page += 1) {
    const result = await poll(sessionId, {
      targetPath,
      beforeSequence,
      limit: pageLimit,
      forceCircuitProbe,
    });
    pageCount += 1;

    if (!result?.ok) {
      if (!latestResult) {
        return {
          ok: false,
          reason: normalizeString(result?.reason) || "fetch_failed",
          listeners: [],
          pageCount,
          scannedEventCount: allEvents.length,
          listenerEventCount: 0,
          partial: false,
        };
      }
      partial = true;
      partialReason = normalizeString(result?.reason) || "partial_fetch";
      break;
    }

    latestResult = result;
    const pageEvents = Array.isArray(result.events) ? result.events : [];
    allEvents = [...pageEvents, ...allEvents];
    listenerEventCount += pageEvents.filter((event) =>
      LISTENER_EVENT_TYPES.has(normalizeString(event?.event))
    ).length;

    if (pageEvents.length < pageLimit) break;
    if (listenerEventCount > 0) break;

    const candidateBeforeSequence = Number(result.beforeSequence || 0);
    if (!Number.isFinite(candidateBeforeSequence) || candidateBeforeSequence <= 0) break;
    const currentBeforeSequence = Number(beforeSequence || 0);
    if (currentBeforeSequence > 0 && candidateBeforeSequence >= currentBeforeSequence) break;
    beforeSequence = Math.floor(candidateBeforeSequence);
  }

  const listeners = summarizeListeners(allEvents, { nowMs: nowMs() });
  return {
    ok: true,
    sessionId: normalizeString(sessionId),
    listeners,
    pageCount,
    scannedEventCount: allEvents.length,
    listenerEventCount,
    beforeSequence: latestResult?.beforeSequence || beforeSequence || null,
    partial,
    reason: partial ? partialReason : "",
  };
}

export function formatListenerLine(row) {
  const cadence = row.cadenceSeconds ? `${row.cadenceSeconds}s` : "—";
  const seen = row.lastSeenAgoSeconds === null ? "never" : `${row.lastSeenAgoSeconds}s ago`;
  const statusLabel =
    row.status === "active"
      ? "● active"
      : row.status === "idle"
        ? "○ idle"
        : row.status === "stale"
          ? "◌ stale"
          : "× stopped";
  const localProcessCount = Number(row.localProcessCount || 0);
  const localPids = Array.isArray(row.localProcessPids)
    ? row.localProcessPids.filter((pid) => Number.isInteger(Number(pid)) && Number(pid) > 0)
    : [];
  const local =
    localProcessCount > 1 && localPids.length > 0
      ? ` local_pids=${localPids.join(",")}`
      : "";
  return `${statusLabel.padEnd(10)} ${row.agentId.padEnd(24)} cadence=${cadence.padEnd(6)} last_seen=${seen}${local}`;
}
