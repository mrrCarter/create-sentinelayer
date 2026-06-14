import { pollSessionEventsBefore } from "./sync.js";

const LISTENER_EVENT_TYPES = new Set([
  "session_listener_started",
  "session_listener_heartbeat",
  "session_listener_stopped",
]);

// A heartbeat older than this (and not explicitly stopped) means the
// listener likely died without a clean stop — show it as stale, not live.
const DEFAULT_STALE_AFTER_MS = 180_000;

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
    const nextPollSeconds = positiveInt(payload.nextPollMs)
      ? Math.round(positiveInt(payload.nextPollMs) / 1000)
      : null;
    // The effective cadence right now: active window uses the fast interval,
    // otherwise the idle interval; fall back to the reported next poll.
    const cadenceSeconds = active
      ? activeIntervalSeconds || nextPollSeconds
      : idleIntervalSeconds || nextPollSeconds;
    let status;
    if (stopped) status = "stopped";
    else if (ageMs !== null && ageMs > staleAfterMs) status = "stale";
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
      nextPollSeconds,
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
 * `limit` controls how far back we look for heartbeats.
 */
export async function fetchSessionListeners(
  sessionId,
  { targetPath = process.cwd(), limit = 200, nowMs = Date.now, poll = pollSessionEventsBefore } = {}
) {
  const result = await poll(sessionId, { targetPath, limit });
  if (!result?.ok) {
    return { ok: false, reason: normalizeString(result?.reason) || "fetch_failed", listeners: [] };
  }
  const listeners = summarizeListeners(result.events || [], { nowMs: nowMs() });
  return { ok: true, sessionId: normalizeString(sessionId), listeners };
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
  return `${statusLabel.padEnd(10)} ${row.agentId.padEnd(24)} cadence=${cadence.padEnd(6)} last_seen=${seen}`;
}
