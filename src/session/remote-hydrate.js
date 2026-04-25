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

import { pollHumanMessages, pollSessionEvents } from "./sync.js";
import { appendToStream } from "./stream.js";
import { readSyncCursor, writeSyncCursor } from "./sync-cursor.js";

const EVENTS_CURSOR_SUFFIX = "events";

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
  const merged = [];
  for (const e of humanResult?.events || []) {
    const c = (e && typeof e === "object" && typeof e.cursor === "string") ? e.cursor : "";
    if (c && seenCursors.has(c)) continue;
    if (c) seenCursors.add(c);
    merged.push(e);
  }
  for (const e of eventsResult?.events || []) {
    const c = (e && typeof e === "object" && typeof e.cursor === "string") ? e.cursor : "";
    if (c && seenCursors.has(c)) continue;
    if (c) seenCursors.add(c);
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
  for (const event of merged) {
    try {
      await _append(sessionId, event, { targetPath });
      relayed += 1;
    } catch {
      // Append errors are observable via the stream but should not
      // abort the rest of the batch — partial relay is still progress.
    }
  }

  let persistedCursor = false;
  if (typeof humanResult?.cursor === "string" && humanResult.cursor.trim()) {
    const result = await writeSyncCursor(sessionId, humanResult.cursor, { targetPath }).catch(() => null);
    persistedCursor = Boolean(result && result.written);
  }
  if (typeof eventsResult?.cursor === "string" && eventsResult.cursor.trim()) {
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
  };
}
