// Durable RESUME-cursor persistence for the sentid wake daemon (Wake-Up Bus L2).
//
// The dispatcher (dispatcher.js) tracks the highest monotonic seq it has
// committed in memory; this store persists that seq under the session's senti
// directory so a daemon restart re-seeds dispatcher.setCursor() and replays the
// backlog exactly once. Mirrors the conventions of sync-cursor.js (per-session
// JSON next to the stream; missing/malformed reads are treated as "from zero").
//
// Writes are atomic (temp file + rename) so a crash mid-write can never leave a
// truncated cursor that would silently skip or replay the wrong backlog.

import fsp from "node:fs/promises";
import path from "node:path";

import { resolveSessionPaths } from "./../paths.js";

function wakeCursorPath(sessionId, { targetPath } = {}) {
  const { sentiDir } = resolveSessionPaths(sessionId, { targetPath });
  return path.join(sentiDir, "wake-resume-cursor.json");
}

function normalizeSeq(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Read the persisted RESUME seq for a session. Returns 0 when no cursor has been
 * recorded, or when the file is missing, empty, or malformed — callers seed the
 * dispatcher from zero in that case (replay the whole available backlog once).
 *
 * @param {string} sessionId
 * @param {{ targetPath?: string }} [options]
 * @returns {Promise<number>}
 */
export async function readWakeCursor(sessionId, { targetPath } = {}) {
  if (!sessionId) return 0;
  try {
    const raw = await fsp.readFile(wakeCursorPath(sessionId, { targetPath }), "utf-8");
    const seq = normalizeSeq(JSON.parse(raw)?.seq);
    return seq ?? 0;
  } catch {
    // ENOENT or malformed -> treat as "from zero".
    return 0;
  }
}

/**
 * Persist the last-acked RESUME seq for a session (atomic temp + rename).
 * No-ops on an invalid seq rather than corrupting the stored cursor.
 *
 * @param {string} sessionId
 * @param {number} seq  non-negative integer high-water mark
 * @param {{ targetPath?: string }} [options]
 * @returns {Promise<number>} the seq written (or the unchanged value on no-op)
 */
export async function writeWakeCursor(sessionId, seq, { targetPath } = {}) {
  const normalized = normalizeSeq(seq);
  if (!sessionId || normalized === null) return 0; // no-op: nothing persisted this call
  const filePath = wakeCursorPath(sessionId, { targetPath });
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify({ seq: normalized, updatedAt: new Date().toISOString() });
  await fsp.writeFile(tmp, body, "utf-8");
  await fsp.rename(tmp, filePath);
  return normalized;
}

export default { readWakeCursor, writeWakeCursor };
