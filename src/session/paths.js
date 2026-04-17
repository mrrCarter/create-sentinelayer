import path from "node:path";
import process from "node:process";

function normalizeSessionId(sessionId) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) {
    throw new Error("sessionId is required.");
  }
  return normalized;
}

export function resolveSessionsRoot({ targetPath = process.cwd() } = {}) {
  return path.join(path.resolve(String(targetPath || ".")), ".sentinelayer", "sessions");
}

export function resolveSessionDir(sessionId, { targetPath = process.cwd() } = {}) {
  return path.join(resolveSessionsRoot({ targetPath }), normalizeSessionId(sessionId));
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
    agentsDir: path.join(sessionDir, "agents"),
    runtimeRunsDir: path.join(sessionDir, "runtime-runs"),
    sentiDir: path.join(sessionDir, "senti"),
  };
}
