import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { isProcessAlive } from "./daemon-spawn.js";
import { resolveSessionPaths } from "./paths.js";

const LISTENER_DIR_NAME = "listeners";

function normalizeString(value) {
  return String(value || "").trim();
}

export function normalizeListenerProcessKey(agentId = "") {
  return (
    normalizeString(agentId)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

export function resolveListenerPidPath(
  sessionId,
  agentId,
  { targetPath = process.cwd() } = {},
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  return path.join(
    paths.sessionDir,
    LISTENER_DIR_NAME,
    `${normalizeListenerProcessKey(agentId)}.json`,
  );
}

export async function readListenerPidRecord(
  sessionId,
  agentId,
  { targetPath = process.cwd() } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  try {
    const raw = await fsp.readFile(pidPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeListenerPidRecord(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    pid = process.pid,
    listenerId = "",
    transport = "",
    intervalSeconds = null,
    activeIntervalSeconds = null,
    presenceIntervalSeconds = null,
    logFile = "",
  } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  const record = {
    pid: Number(pid),
    sessionId: normalizeString(sessionId),
    agentId: normalizeString(agentId),
    listenerKey: normalizeListenerProcessKey(agentId),
    listenerId: normalizeString(listenerId),
    targetPath: path.resolve(String(targetPath || ".")),
    transport: normalizeString(transport) || undefined,
    intervalSeconds: Number(intervalSeconds) || undefined,
    activeIntervalSeconds: Number(activeIntervalSeconds) || undefined,
    presenceIntervalSeconds: Number(presenceIntervalSeconds) || undefined,
    logFile: normalizeString(logFile) || undefined,
    startedAt: new Date().toISOString(),
  };
  await fsp.mkdir(path.dirname(pidPath), { recursive: true });
  await fsp.writeFile(pidPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return record;
}

export async function removeListenerPidRecord(
  sessionId,
  agentId,
  { targetPath = process.cwd(), onlyForPid = null } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  if (onlyForPid != null) {
    const existing = await readListenerPidRecord(sessionId, agentId, { targetPath });
    if (existing && Number(existing.pid) !== Number(onlyForPid)) {
      return false;
    }
  }
  try {
    await fsp.unlink(pidPath);
    return true;
  } catch {
    return false;
  }
}

export async function getListenerProcessStatus(
  sessionId,
  agentId,
  { targetPath = process.cwd() } = {},
) {
  const record = await readListenerPidRecord(sessionId, agentId, { targetPath });
  if (!record) {
    return {
      running: false,
      pid: null,
      stale: false,
      record: null,
      listenerKey: normalizeListenerProcessKey(agentId),
    };
  }
  const alive = isProcessAlive(record.pid);
  return {
    running: alive,
    pid: alive ? Number(record.pid) : null,
    stale: !alive,
    record,
    listenerKey: normalizeListenerProcessKey(agentId),
  };
}

export async function requestListenerProcessStop(
  pid,
  { signal = "SIGTERM", timeoutMs = 3000, pollIntervalMs = 100 } = {},
) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { requested: false, stopped: true, reason: "invalid_pid" };
  }
  if (numericPid === process.pid) {
    return { requested: false, stopped: false, reason: "self" };
  }
  if (!isProcessAlive(numericPid)) {
    return { requested: false, stopped: true, reason: "not_running" };
  }

  try {
    process.kill(numericPid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { requested: false, stopped: true, reason: "not_running" };
    }
    return {
      requested: false,
      stopped: false,
      reason: normalizeString(error?.code) || "signal_failed",
    };
  }

  const deadlineMs = Date.now() + Math.max(1, Number(timeoutMs) || 3000);
  const sleepMs = Math.max(10, Number(pollIntervalMs) || 100);
  while (Date.now() < deadlineMs) {
    if (!isProcessAlive(numericPid)) {
      return { requested: true, stopped: true, reason: "stopped" };
    }
    await sleep(sleepMs);
  }
  return { requested: true, stopped: false, reason: "timeout" };
}
