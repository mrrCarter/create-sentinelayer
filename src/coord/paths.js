// Filesystem layout for the cross-persona LOCK/ACK/RELEASE handshake (#A9).
//
// All state lives under `.sentinel/` at the target repo root. This is
// intentionally *not* `.sentinelayer/sessions/<id>/` (which scopes file locks
// to a single Senti session) because the handshake is a cross-session
// coordination primitive: when Omar Gate 2.0 verifies a PR, it reads the
// same lock files the personas wrote without needing to know their session id.

import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

const SENTINEL_ROOT = ".sentinel";
const LOCKS_SUBDIR = "locks";
const EVENTS_FILE = "events.jsonl";
const WAITS_FILE = "waits.json";
const MUTEX_LOCK = ".lock-mutex.lock";
const EVENTS_LOCK = ".events.lock";
const WAITS_LOCK = ".waits.lock";

export function resolveSentinelDir({ targetPath = process.cwd() } = {}) {
  return path.join(path.resolve(String(targetPath || ".")), SENTINEL_ROOT);
}

export function resolveLocksDir({ targetPath = process.cwd() } = {}) {
  return path.join(resolveSentinelDir({ targetPath }), LOCKS_SUBDIR);
}

export function resolveEventsPath({ targetPath = process.cwd() } = {}) {
  return path.join(resolveSentinelDir({ targetPath }), EVENTS_FILE);
}

export function resolveWaitsPath({ targetPath = process.cwd() } = {}) {
  return path.join(resolveSentinelDir({ targetPath }), WAITS_FILE);
}

export function resolveMutexLockPath({ targetPath = process.cwd() } = {}) {
  return path.join(resolveSentinelDir({ targetPath }), MUTEX_LOCK);
}

export function resolveEventsLockPath({ targetPath = process.cwd() } = {}) {
  return path.join(resolveSentinelDir({ targetPath }), EVENTS_LOCK);
}

export function resolveWaitsLockPath({ targetPath = process.cwd() } = {}) {
  return path.join(resolveSentinelDir({ targetPath }), WAITS_LOCK);
}

// Normalize the caller's intended file path into a stable, repo-relative,
// posix-style string. Absolute paths are relativized against targetPath so
// the same file produces the same hash across macOS/Linux/Windows workers.
export function normalizeLockPath(filePath, { targetPath = process.cwd() } = {}) {
  const raw = String(filePath || "").trim();
  if (!raw) {
    throw new Error("path is required.");
  }
  const resolvedTarget = path.resolve(String(targetPath || "."));
  let normalized;
  if (path.isAbsolute(raw)) {
    normalized = path.relative(resolvedTarget, path.resolve(raw));
  } else {
    normalized = raw;
  }
  normalized = normalized.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error("path must be inside the target directory.");
  }
  return normalized;
}

export function hashLockKey(normalizedPath) {
  const value = String(normalizedPath || "").trim();
  if (!value) {
    throw new Error("normalizedPath is required.");
  }
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function lockFileFor(normalizedPath, { targetPath = process.cwd() } = {}) {
  return path.join(
    resolveLocksDir({ targetPath }),
    `${hashLockKey(normalizedPath)}.lock.json`
  );
}
