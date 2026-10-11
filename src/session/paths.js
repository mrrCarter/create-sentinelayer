import path from "node:path";
import process from "node:process";

// A session id names exactly one directory directly under <target>/.sentinelayer/sessions/.
// Every id in use fits: randomUUID() ids, run-derived billing ids such as
// omargate-<ms>-<hex>-<persona>-swarm-<n>-ai, chat ids such as 20261010-123456-k3j9x2, and API ids.
// No trailing '.': Windows drops it, so "abc." and "abc" would name the same directory.
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
// Windows device names, with or without an extension, are refused on every platform.
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const SESSION_ID_RULE =
  "sessionId must be 1-128 characters: letters, digits, '.', '_' or '-', starting with a letter or digit and not ending with '.'.";
export const SESSION_ID_RESERVED_RULE = "sessionId must not be a reserved device name.";
export const SESSION_ID_SEGMENT_RULE = "sessionId must name one directory directly under the sessions root.";

function sessionIdProblem(id) {
  if (!SESSION_ID_PATTERN.test(id)) return SESSION_ID_RULE;
  if (RESERVED_DEVICE_NAME.test(id)) return SESSION_ID_RESERVED_RULE;
  return "";
}

/** True when `value` is a session id as stored on disk (no trimming). */
export function isValidSessionId(value) {
  return typeof value === "string" && !sessionIdProblem(value);
}

/** The trimmed session id, or an error when it is empty, outside the allowlist or a device name. */
export function normalizeSessionId(sessionId) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) {
    throw new Error("sessionId is required.");
  }
  const problem = sessionIdProblem(normalized);
  if (problem) {
    throw new Error(problem);
  }
  return normalized;
}

/**
 * `<root>/<sessionId>`, refused unless the result is exactly one directory directly under `root`
 * and the id passes normalizeSessionId. The one-directory check runs first, on the raw id, so it
 * holds by itself whatever the allowlist admits.
 */
export function resolveSessionChildDir(root, sessionId) {
  const resolvedRoot = path.resolve(String(root || "."));
  const raw = String(sessionId || "").trim();
  if (!raw) {
    throw new Error("sessionId is required.");
  }
  const dir = path.join(resolvedRoot, raw);
  const relative = path.relative(resolvedRoot, dir);
  if (!relative || relative === ".." || /[\\/]/.test(relative) || path.isAbsolute(relative)) {
    throw new Error(SESSION_ID_SEGMENT_RULE);
  }
  normalizeSessionId(raw);
  return dir;
}

export function resolveSessionsRoot({ targetPath = process.cwd() } = {}) {
  return path.join(path.resolve(String(targetPath || ".")), ".sentinelayer", "sessions");
}

export function resolveSessionDir(sessionId, { targetPath = process.cwd() } = {}) {
  return resolveSessionChildDir(resolveSessionsRoot({ targetPath }), sessionId);
}

export function resolveSessionPaths(sessionId, { targetPath = process.cwd() } = {}) {
  const sessionDir = resolveSessionDir(sessionId, { targetPath });
  return {
    sessionId: normalizeSessionId(sessionId),
    sessionDir,
    metadataPath: path.join(sessionDir, "metadata.json"),
    streamPath: path.join(sessionDir, "stream.ndjson"),
    rotatedStreamPath: path.join(sessionDir, "stream.1.ndjson"),
    lockPath: path.join(sessionDir, ".stream.lock"),
    fileLocksPath: path.join(sessionDir, "file-locks.json"),
    fileLocksLockPath: path.join(sessionDir, ".file-locks.lock"),
    fileLeaseCapabilitiesPath: path.join(sessionDir, "file-lease-capabilities.json"),
    fileLeaseCapabilitiesLockPath: path.join(sessionDir, ".file-lease-capabilities.lock"),
    tasksPath: path.join(sessionDir, "tasks.json"),
    tasksLockPath: path.join(sessionDir, ".tasks.lock"),
    agentsDir: path.join(sessionDir, "agents"),
    runtimeRunsDir: path.join(sessionDir, "runtime-runs"),
    sentiDir: path.join(sessionDir, "senti"),
  };
}
