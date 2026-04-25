/**
 * One-shot remote hydrator for the local NDJSON stream.
 *
 * Wraps `pollHumanMessages` (which speaks to the SentinelLayer API) with
 * a persisted cursor + `appendToStream`, so a CLI invocation can pull
 * web-posted messages into the local session log on demand. The
 * background daemon already does this on a poll loop; this module is
 * the synchronous counterpart that powers `slc session sync` and
 * `slc session read --remote`.
 */

import { pollHumanMessages } from "./sync.js";
import { appendToStream } from "./stream.js";
import { readSyncCursor, writeSyncCursor } from "./sync-cursor.js";

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

  const startCursor =
    typeof since === "string" || since === null
      ? since
      : await readSyncCursor(sessionId, { targetPath });

  const polled = await _poll(sessionId, {
    targetPath,
    since: startCursor,
  });

  if (!polled || !polled.ok) {
    return {
      ok: false,
      reason: polled?.reason || "poll_failed",
      relayed: 0,
      dropped: Array.isArray(polled?.dropped) ? polled.dropped.length : 0,
      cursor: typeof polled?.cursor === "string" ? polled.cursor : startCursor || null,
      persistedCursor: false,
    };
  }

  let relayed = 0;
  for (const event of polled.events || []) {
    try {
      await _append(sessionId, event, { targetPath });
      relayed += 1;
    } catch {
      // Append errors are observable via the stream but should not
      // abort the rest of the batch — partial relay is still progress.
    }
  }

  let persistedCursor = false;
  if (typeof polled.cursor === "string" && polled.cursor.trim()) {
    const result = await writeSyncCursor(sessionId, polled.cursor, { targetPath }).catch(() => null);
    persistedCursor = Boolean(result && result.written);
  }

  return {
    ok: true,
    reason: "",
    relayed,
    dropped: Array.isArray(polled.dropped) ? polled.dropped.length : 0,
    cursor: typeof polled.cursor === "string" ? polled.cursor : startCursor || null,
    persistedCursor,
  };
}
