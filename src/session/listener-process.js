import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { isProcessAlive } from "./daemon-spawn.js";
import { resolveSessionPaths } from "./paths.js";

const LISTENER_DIR_NAME = "listeners";
const GLOBAL_LISTENER_DIR_NAME = "session-listeners";
const execFileAsync = promisify(execFile);

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

function normalizeCommandLine(value) {
  return normalizeString(value).toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandLineFlagValueMatches(commandLine, flagName, expectedValue) {
  const expected = normalizeString(expectedValue).toLowerCase();
  if (!expected) return { found: false, matches: true };
  const pattern = new RegExp(
    `(?:^|\\s)--${escapeRegExp(flagName)}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`,
    "gi",
  );
  let found = false;
  for (const match of commandLine.matchAll(pattern)) {
    found = true;
    const value = normalizeString(match[1] ?? match[2] ?? match[3]).toLowerCase();
    if (value === expected) {
      return { found: true, matches: true };
    }
  }
  return { found, matches: false };
}

function listenerCommandLineMatches(commandLine, { sessionId = "", agentId = "" } = {}) {
  const rawCommandLine = normalizeString(commandLine);
  const normalized = normalizeCommandLine(rawCommandLine);
  if (!normalized) return false;
  const normalizedSessionId = normalizeString(sessionId).toLowerCase();
  const normalizedAgentId = normalizeString(agentId).toLowerCase();
  const hasCliEntry =
    normalized.includes("sentinelayer-cli") ||
    /[\\/](?:sl|sentinelayer-cli)\.js\b/.test(normalized);
  const sessionFlagMatch = commandLineFlagValueMatches(rawCommandLine, "session", normalizedSessionId);
  const agentFlagMatch = commandLineFlagValueMatches(rawCommandLine, "agent", normalizedAgentId);
  return (
    hasCliEntry &&
    normalized.includes("session") &&
    normalized.includes("listen") &&
    (!normalizedSessionId ||
      (sessionFlagMatch.found
        ? sessionFlagMatch.matches
        : normalized.includes(normalizedSessionId))) &&
    (!normalizedAgentId ||
      (agentFlagMatch.found
        ? agentFlagMatch.matches
        : normalized.includes(normalizedAgentId)))
  );
}

function normalizeProcessRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      pid: Number(row?.pid ?? row?.ProcessId ?? row?.processId),
      commandLine: normalizeString(row?.commandLine ?? row?.CommandLine ?? row?.command ?? row?.args),
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.commandLine);
}

async function listWindowsProcesses() {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$rows = Get-CimInstance Win32_Process |",
    "Where-Object { $_.CommandLine -and ($_.CommandLine -match 'sentinelayer-cli|[\\\\/](sl|sentinelayer-cli)\\.js') } |",
    "Select-Object ProcessId,CommandLine;",
    "if ($rows) { $rows | ConvertTo-Json -Compress }",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 3000, maxBuffer: 10 * 1024 * 1024 },
  );
  const text = normalizeString(stdout);
  if (!text) return [];
  const parsed = JSON.parse(text);
  return normalizeProcessRows(Array.isArray(parsed) ? parsed : [parsed]);
}

async function listPosixProcesses() {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,command="], {
    timeout: 3000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), commandLine: normalizeString(match[2]) } : null;
    })
    .filter(Boolean);
}

async function listProcessTable() {
  try {
    return process.platform === "win32"
      ? await listWindowsProcesses()
      : await listPosixProcesses();
  } catch {
    return [];
  }
}

export async function listMatchingListenerProcesses(
  sessionId,
  agentId,
  {
    excludePid = process.pid,
    _listProcesses = listProcessTable,
  } = {},
) {
  const rows = normalizeProcessRows(await _listProcesses());
  const excluded = Number(excludePid);
  return rows.filter((row) =>
    row.pid !== excluded &&
    listenerCommandLineMatches(row.commandLine, { sessionId, agentId })
  );
}

async function readWindowsCommandLine(pid) {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}";`,
    "if ($p) { $p.CommandLine }",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 2000 },
  );
  return normalizeString(stdout);
}

async function readPosixCommandLine(pid) {
  if (process.platform === "linux") {
    try {
      const raw = await fsp.readFile(`/proc/${Number(pid)}/cmdline`);
      return normalizeString(raw.toString("utf8").replace(/\0/g, " "));
    } catch {
      // Fall through to ps(1), which also covers restricted /proc mounts.
    }
  }
  const { stdout } = await execFileAsync("ps", ["-p", String(Number(pid)), "-o", "command="], {
    timeout: 2000,
  });
  return normalizeString(stdout);
}

export async function readProcessCommandLine(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return "";
  try {
    return process.platform === "win32"
      ? await readWindowsCommandLine(numericPid)
      : await readPosixCommandLine(numericPid);
  } catch {
    return "";
  }
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

export function resolveGlobalListenerPidPath(
  sessionId,
  agentId,
  { homeDir = os.homedir() } = {},
) {
  return path.join(
    path.resolve(String(homeDir || os.homedir())),
    ".sentinelayer",
    GLOBAL_LISTENER_DIR_NAME,
    normalizeListenerProcessKey(sessionId),
    `${normalizeListenerProcessKey(agentId)}.json`,
  );
}

async function readPidRecordAtPath(pidPath) {
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

async function writePidRecordAtPath(pidPath, record) {
  await fsp.mkdir(path.dirname(pidPath), { recursive: true });
  await fsp.writeFile(pidPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

async function removePidRecordAtPath(pidPath, { onlyForPid = null } = {}) {
  if (onlyForPid != null) {
    const existing = await readPidRecordAtPath(pidPath);
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

export async function readListenerPidRecord(
  sessionId,
  agentId,
  { targetPath = process.cwd() } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  return readPidRecordAtPath(pidPath);
}

export async function readGlobalListenerPidRecord(
  sessionId,
  agentId,
  { homeDir = os.homedir() } = {},
) {
  const pidPath = resolveGlobalListenerPidPath(sessionId, agentId, { homeDir });
  return readPidRecordAtPath(pidPath);
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
    homeDir = os.homedir(),
  } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  const globalPidPath = resolveGlobalListenerPidPath(sessionId, agentId, { homeDir });
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
  const globalRecord = {
    ...record,
    recordScope: "global",
    localPidPath: pidPath,
  };
  await writePidRecordAtPath(globalPidPath, globalRecord);
  try {
    await writePidRecordAtPath(pidPath, record);
  } catch (error) {
    await removePidRecordAtPath(globalPidPath, { onlyForPid: pid }).catch(() => {});
    throw error;
  }
  return record;
}

export async function removeListenerPidRecord(
  sessionId,
  agentId,
  { targetPath = process.cwd(), onlyForPid = null, homeDir = os.homedir() } = {},
) {
  const pidPath = resolveListenerPidPath(sessionId, agentId, { targetPath });
  const globalPidPath = resolveGlobalListenerPidPath(sessionId, agentId, { homeDir });
  const localRemoved = await removePidRecordAtPath(pidPath, { onlyForPid });
  const globalRemoved = await removePidRecordAtPath(globalPidPath, { onlyForPid });
  return Boolean(localRemoved || globalRemoved);
}

async function listenerStatusFromRecord(
  record,
  {
    sessionId,
    agentId,
    recordScope,
    _readProcessCommandLine = readProcessCommandLine,
  } = {},
) {
  const alive = isProcessAlive(record.pid);
  if (!alive) {
    return {
      running: false,
      pid: null,
      stale: true,
      record,
      recordScope,
      listenerKey: normalizeListenerProcessKey(agentId),
    };
  }
  const commandLine = await _readProcessCommandLine(record.pid);
  if (!listenerCommandLineMatches(commandLine, { sessionId, agentId })) {
    return {
      running: false,
      pid: null,
      stale: true,
      reused: Boolean(commandLine),
      unverified: !commandLine,
      record,
      recordScope,
      listenerKey: normalizeListenerProcessKey(agentId),
      commandLine,
    };
  }
  return {
    running: true,
    pid: Number(record.pid),
    stale: false,
    record,
    recordScope,
    listenerKey: normalizeListenerProcessKey(agentId),
    commandLine,
  };
}

export async function getListenerProcessStatus(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    homeDir = os.homedir(),
    _readProcessCommandLine = readProcessCommandLine,
    _listProcesses = listProcessTable,
  } = {},
) {
  const records = [
    {
      record: await readGlobalListenerPidRecord(sessionId, agentId, { homeDir }),
      recordScope: "global",
    },
    {
      record: await readListenerPidRecord(sessionId, agentId, { targetPath }),
      recordScope: "local",
    },
  ];
  const staleStatuses = [];
  for (const entry of records) {
    if (!entry.record) continue;
    const status = await listenerStatusFromRecord(entry.record, {
      sessionId,
      agentId,
      recordScope: entry.recordScope,
      _readProcessCommandLine,
    });
    if (status.running) {
      return status;
    }
    staleStatuses.push(status);
  }
  const matchingProcesses = await listMatchingListenerProcesses(sessionId, agentId, {
    _listProcesses,
  });
  if (matchingProcesses.length > 0) {
    return {
      running: true,
      pid: matchingProcesses[0].pid,
      stale: false,
      record: null,
      recordScope: "process_scan",
      untracked: true,
      listenerKey: normalizeListenerProcessKey(agentId),
      commandLine: matchingProcesses[0].commandLine,
      matchingProcesses,
    };
  }
  if (staleStatuses.length === 0) {
    return {
      running: false,
      pid: null,
      stale: false,
      record: null,
      listenerKey: normalizeListenerProcessKey(agentId),
    };
  }
  return staleStatuses[0];
}

export async function stopMatchingListenerProcesses(
  sessionId,
  agentId,
  {
    excludePid = process.pid,
    timeoutMs = 3000,
    pollIntervalMs = 100,
    _listProcesses = listProcessTable,
  } = {},
) {
  const matches = await listMatchingListenerProcesses(sessionId, agentId, {
    excludePid,
    _listProcesses,
  });
  const results = [];
  for (const match of matches) {
    const result = await requestListenerProcessStop(match.pid, {
      timeoutMs,
      pollIntervalMs,
    });
    results.push({
      pid: match.pid,
      commandLine: match.commandLine,
      ...result,
    });
  }
  const failed = results.filter((result) => !result.stopped);
  return {
    matches,
    results,
    stoppedCount: results.filter((result) => result.stopped).length,
    failedCount: failed.length,
    failed,
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
