/**
 * One-shot remote hydrator for the local NDJSON stream.
 *
 * Pulls events from the SentinelLayer API (BOTH human-posted messages
 * AND agent-posted events) and appends them to the local session log
 * with a persisted cursor. Powers `slc session sync` and
 * `slc session read --remote`. The background daemon does the same thing
 * on a poll loop; this is the synchronous counterpart.
 *
 * Why two pollers: Carter caught a multi-agent design bug in the
 * standup session — agents polling via `pollHumanMessages` only saw
 * web-posted human messages, never each other's `session_message` /
 * `agent_response` events. Codex and claude talked past each other
 * for hours ("Apologies — I missed your 5 updates"). Fix: also poll
 * the durable `/sessions/{id}/events` endpoint (added in API #467)
 * which returns ALL events. Per-source cursors keep the two pollers
 * independent so a stuck human-message read doesn't block agent-event
 * sync, and vice-versa.
 */

import { listSessionsFromApi, pollHumanMessages, pollSessionEvents } from "./sync.js";
import { appendToStream } from "./stream.js";
import { createSession, getSession } from "./store.js";
import { readSyncCursor, writeSyncCursor } from "./sync-cursor.js";

const EVENTS_CURSOR_SUFFIX = "events";

function eventRelayKey(event = {}) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.cursor === "string" && event.cursor.trim()) {
    return `cursor:${event.cursor.trim()}`;
  }
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
  if (messageId) {
    return `message:${messageId}`;
  }
  try {
    return `fingerprint:${JSON.stringify({
      event: event.event || event.type || "",
      agent: event.agent?.id || event.agentId || "",
      payload,
      ts: event.ts || event.timestamp || event.at || "",
    })}`;
  } catch {
    return "";
  }
}

async function ensureLocalSessionShell(sessionId, { targetPath = process.cwd() } = {}) {
  const existing = await getSession(sessionId, { targetPath });
  if (existing) {
    return { materialized: false, session: existing };
  }
  let remoteStatus = "";
  const remoteList = await listSessionsFromApi({
    targetPath,
    includeArchived: true,
    limit: 200,
  }).catch(() => null);
  if (remoteList?.ok) {
    const match = (remoteList.sessions || []).find((entry) => entry?.sessionId === sessionId);
    remoteStatus = String(match?.archiveStatus || match?.status || "").trim().toLowerCase();
  }
  const created = await createSession({
    targetPath,
    sessionId,
    title: `remote-${String(sessionId).slice(0, 8)}`,
  });
  return { materialized: true, session: created, remoteStatus };
}

function sourceFullyRelayed(events = [], successfulKeys = new Set()) {
  const relayedEvents = Array.isArray(events) ? events : [];
  if (relayedEvents.length === 0) return true;
  return relayedEvents.every((event) => {
    const key = eventRelayKey(event);
    return key && successfulKeys.has(key);
  });
}

function markPostKillEvent(event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return event;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : {};
  return {
    ...event,
    _post_kill: true,
    payload: {
      ...payload,
      _post_kill: true,
    },
  };
}

/**
 * Fetch new human messages for a session, append them to the local
 * stream, and advance the persisted cursor. Returns a structured
 * summary the CLI can render directly. Failures degrade — we never
 * throw out of this helper for transient/auth issues so wrappers can
 * still serve a local-only read.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} [params.targetPath]
 * @param {string|null} [params.since]   - Override persisted cursor.
 * @param {Function}    [params._poll]   - Test seam.
 * @param {Function}    [params._append] - Test seam.
 * @returns {Promise<{ok: boolean, reason: string, relayed: number, dropped: number, cursor: string|null, persistedCursor: boolean}>}
 */
export async function hydrateSessionFromRemote({
  sessionId,
  targetPath = process.cwd(),
  since = undefined,
  _poll = pollHumanMessages,
  _pollEvents = pollSessionEvents,
  _append = appendToStream,
  _ensureLocalSession = ensureLocalSessionShell,
} = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    return {
      ok: false,
      reason: "invalid_session_id",
      relayed: 0,
      dropped: 0,
      cursor: null,
      persistedCursor: false,
    };
  }

  // Per-source cursors. The legacy human-message cursor is in the
  // session's metadata file; the new agent-events cursor is in a
  // sibling slot. Keeping them separate prevents a stuck/truncated
  // poll on one source from poisoning the other.
  const humanCursor =
    typeof since === "string" || since === null
      ? since
      : await readSyncCursor(sessionId, { targetPath });
  const eventsCursor =
    typeof since === "string" || since === null
      ? since
      : await readSyncCursor(sessionId, { targetPath, suffix: EVENTS_CURSOR_SUFFIX });

  // Run both pollers in parallel — they hit different endpoints and
  // are independent. A human-only poll stays fast even when the
  // events poll is heavy.
  const [humanResult, eventsResult] = await Promise.all([
    _poll(sessionId, { targetPath, since: humanCursor }),
    _pollEvents(sessionId, { targetPath, since: eventsCursor }),
  ]);

  // Dedup across sources — both endpoints can return the same event
  // (e.g. a human relay event). Cursor values are unique per event.
  const seenCursors = new Set();
  const seenKeys = new Set();
  const merged = [];
  for (const e of humanResult?.events || []) {
    const c = (e && typeof e === "object" && typeof e.cursor === "string") ? e.cursor : "";
    if (c && seenCursors.has(c)) continue;
    const key = eventRelayKey(e);
    if (key && seenKeys.has(key)) continue;
    if (c) seenCursors.add(c);
    if (key) seenKeys.add(key);
    merged.push(e);
  }
  for (const e of eventsResult?.events || []) {
    const c = (e && typeof e === "object" && typeof e.cursor === "string") ? e.cursor : "";
    if (c && seenCursors.has(c)) continue;
    const key = eventRelayKey(e);
    if (key && seenKeys.has(key)) continue;
    if (c) seenCursors.add(c);
    if (key) seenKeys.add(key);
    merged.push(e);
  }

  // If BOTH pollers failed, surface the human-message failure (the
  // legacy contract) so existing callers see no behavior change. If
  // only one fails, treat the relay as partial-but-successful.
  if (!humanResult?.ok && !eventsResult?.ok) {
    return {
      ok: false,
      reason: humanResult?.reason || eventsResult?.reason || "poll_failed",
      relayed: 0,
      dropped: Array.isArray(humanResult?.dropped) ? humanResult.dropped.length : 0,
      cursor:
        typeof humanResult?.cursor === "string" ? humanResult.cursor : humanCursor || null,
      persistedCursor: false,
    };
  }

  let relayed = 0;
  let materializedLocalSession = false;
  let remoteStatus = "";
  const successfulRelayKeys = new Set();
  if (merged.length > 0) {
    try {
      const localSession = await _ensureLocalSession(sessionId, { targetPath });
      materializedLocalSession = Boolean(localSession?.materialized);
      remoteStatus = String(localSession?.remoteStatus || "").trim().toLowerCase();
    } catch {
      // Keep the old degraded behavior: append attempts below will
      // fail visibly in the returned counters, but remote polling still
      // returns a structured result.
    }
  }
  const appendEvents =
    remoteStatus && !["active", "pending"].includes(remoteStatus)
      ? merged.map((event) => markPostKillEvent(event))
      : merged;
  for (const event of appendEvents) {
    try {
      await _append(sessionId, event, { targetPath });
      relayed += 1;
      const key = eventRelayKey(event);
      if (key) successfulRelayKeys.add(key);
    } catch {
      // Append errors are observable via the stream but should not
      // abort the rest of the batch — partial relay is still progress.
    }
  }

  let persistedCursor = false;
  const humanCursorSafe = sourceFullyRelayed(humanResult?.events || [], successfulRelayKeys);
  const eventsCursorSafe = sourceFullyRelayed(eventsResult?.events || [], successfulRelayKeys);
  if (humanCursorSafe && typeof humanResult?.cursor === "string" && humanResult.cursor.trim()) {
    const result = await writeSyncCursor(sessionId, humanResult.cursor, { targetPath }).catch(() => null);
    persistedCursor = Boolean(result && result.written);
  }
  if (eventsCursorSafe && typeof eventsResult?.cursor === "string" && eventsResult.cursor.trim()) {
    await writeSyncCursor(sessionId, eventsResult.cursor, {
      targetPath,
      suffix: EVENTS_CURSOR_SUFFIX,
    }).catch(() => null);
  }

  return {
    ok: true,
    reason: "",
    relayed,
    dropped: Array.isArray(humanResult?.dropped) ? humanResult.dropped.length : 0,
    cursor: typeof humanResult?.cursor === "string" ? humanResult.cursor : humanCursor || null,
    persistedCursor,
    humanRelayed: (humanResult?.events || []).length,
    eventsRelayed: (eventsResult?.events || []).length,
    eventsCursor:
      typeof eventsResult?.cursor === "string" ? eventsResult.cursor : eventsCursor || null,
    materializedLocalSession,
    localAppendComplete: humanCursorSafe && eventsCursorSafe,
    remoteStatus: remoteStatus || null,
  };
}
