/**
 * Per-session sync cursor persistence.
 *
 * The daemon keeps the human-message poll cursor in memory; one-shot CLI
 * commands (`slc session sync`, `slc session read --remote`) need a
 * cursor that survives across invocations so successive runs only fetch
 * what is new. We persist the cursor next to the stream NDJSON in the
 * session directory.
 */

import fsp from "node:fs/promises";
import path from "node:path";

import { resolveSessionDir } from "./paths.js";

function cursorPath(sessionId, { targetPath } = {}) {
  return path.join(resolveSessionDir(sessionId, { targetPath }), "remote-sync-cursor.json");
}

/**
 * Read the persisted human-message cursor for a session. Returns `null`
 * when no cursor has been recorded yet, or when the file is missing,
 * empty, or malformed — callers should treat that as "first sync".
 *
 * @param {string} sessionId
 * @param {{targetPath?: string}} [options]
 * @returns {Promise<string|null>}
 */
export async function readSyncCursor(sessionId, { targetPath } = {}) {
  if (!sessionId) return null;
  const filePath = cursorPath(sessionId, { targetPath });
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const cursor = typeof parsed?.cursor === "string" ? parsed.cursor.trim() : "";
    return cursor || null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return null;
  }
}

/**
 * Persist the human-message cursor for a session. No-op when cursor is
 * empty so we never overwrite a real value with an empty one.
 *
 * @param {string} sessionId
 * @param {string|null|undefined} cursor
 * @param {{targetPath?: string}} [options]
 * @returns {Promise<{written: boolean, path: string}>}
 */
export async function writeSyncCursor(sessionId, cursor, { targetPath } = {}) {
  const filePath = cursorPath(sessionId, { targetPath });
  const normalized = typeof cursor === "string" ? cursor.trim() : "";
  if (!sessionId || !normalized) {
    return { written: false, path: filePath };
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload = { cursor: normalized, updatedAt: new Date().toISOString() };
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return { written: true, path: filePath };
}
