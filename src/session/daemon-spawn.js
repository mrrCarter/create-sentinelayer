import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveSessionPaths } from "./paths.js";
import {
  appendRotatingLogLine,
  normalizeRotatingLogOptions,
} from "./rotating-log.js";

const PID_FILE_NAME = "senti-daemon.json";
const LOG_FILE_NAME = "senti-daemon.log";

function normalizeString(value) {
  return String(value || "").trim();
}

export function sentiDaemonDisabled(env = process.env) {
  return (
    normalizeString(env.SENTINELAYER_SKIP_SENTI_AUTOSTART) === "1" ||
    normalizeString(env.SENTINELAYER_SKIP_SENTI_DAEMON) === "1"
  );
}

export function resolveDaemonPidPath(sessionId, { targetPath = process.cwd() } = {}) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  return path.join(paths.sessionDir, PID_FILE_NAME);
}

export function resolveDaemonLogPath(sessionId, { targetPath = process.cwd() } = {}) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  return path.join(paths.sessionDir, LOG_FILE_NAME);
}

export function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

export async function readDaemonPidRecord(sessionId, { targetPath = process.cwd() } = {}) {
  const pidPath = resolveDaemonPidPath(sessionId, { targetPath });
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

export async function writeDaemonPidRecord(
  sessionId,
  { targetPath = process.cwd(), pid = process.pid, tickIntervalMs = 30000 } = {}
) {
  const pidPath = resolveDaemonPidPath(sessionId, { targetPath });
  const record = {
    pid: Number(pid),
    sessionId: normalizeString(sessionId),
    targetPath: path.resolve(String(targetPath || ".")),
    tickIntervalMs: Number(tickIntervalMs) || 30000,
    startedAt: new Date().toISOString(),
  };
  await fsp.mkdir(path.dirname(pidPath), { recursive: true });
  await fsp.writeFile(pidPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return record;
}

export async function removeDaemonPidRecord(
  sessionId,
  { targetPath = process.cwd(), onlyForPid = null } = {}
) {
  const pidPath = resolveDaemonPidPath(sessionId, { targetPath });
  if (onlyForPid != null) {
    const existing = await readDaemonPidRecord(sessionId, { targetPath });
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

/**
 * Whether a detached Senti daemon is currently managing the session.
 * Stale pid files (machine reboot, hard kill on Windows) are reported as
 * not running so the caller can safely respawn over them.
 */
export async function getDaemonStatus(sessionId, { targetPath = process.cwd() } = {}) {
  const record = await readDaemonPidRecord(sessionId, { targetPath });
  if (!record) {
    return { running: false, pid: null, stale: false, record: null };
  }
  const alive = isProcessAlive(record.pid);
  return {
    running: alive,
    pid: alive ? Number(record.pid) : null,
    stale: !alive,
    record,
  };
}

// The daemon is ALWAYS this package's own CLI entry, never "whatever script is running".
// It used to be process.argv[1]: under a test runner that is the TEST FILE, so the "daemon"
// re-ran the tests, and every bootstrapped session spawned more detached copies of them.
// On 2026-09-29 one such run became a detached fork bomb that took the machine down and
// created thousands of sessions on the API.
const CLI_ENTRY_PATH = fileURLToPath(new URL("../../bin/sl.js", import.meta.url));

export function resolveCliEntryPath() {
  return CLI_ENTRY_PATH;
}

// Under the node test runner (it sets NODE_TEST_CONTEXT in every test process), a detached
// daemon outlives the test that started it. One is spawned only when the test names the
// entry itself (cliPath), deliberately; never as a side effect of code under test.
function underTestRunner() {
  return normalizeString(process.env.NODE_TEST_CONTEXT) !== "";
}

/**
 * Spawn `sl session daemon <id>` as a detached background process so the
 * session stays managed (greetings, recaps, checkpoints, mention routing)
 * after the creating terminal exits. Deduped via the session's pid file;
 * output goes to senti-daemon.log in the session directory.
 *
 * Never throws: returns { spawned, pid, reason, logPath } so callers can
 * report status without ever failing session creation.
 */
export async function spawnDetachedSentiDaemon({
  sessionId,
  targetPath = process.cwd(),
  cliPath = "",
  env = process.env,
  logMaxBytes = env.SENTINELAYER_SENTI_LOG_MAX_BYTES,
  logMaxFiles = env.SENTINELAYER_SENTI_LOG_MAX_FILES,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return { spawned: false, pid: null, reason: "missing_session_id", logPath: "" };
  }
  if (sentiDaemonDisabled(env)) {
    return { spawned: false, pid: null, reason: "disabled", logPath: "" };
  }

  const status = await getDaemonStatus(normalizedSessionId, { targetPath });
  if (status.running) {
    return {
      spawned: false,
      pid: status.pid,
      reason: "already_running",
      logPath: resolveDaemonLogPath(normalizedSessionId, { targetPath }),
    };
  }

  if (!normalizeString(cliPath) && underTestRunner()) {
    return { spawned: false, pid: null, reason: "test_runner", logPath: "" };
  }

  const entryPath = normalizeString(cliPath) || resolveCliEntryPath();
  if (!entryPath) {
    return { spawned: false, pid: null, reason: "cli_entry_unresolved", logPath: "" };
  }

  const logPath = resolveDaemonLogPath(normalizedSessionId, { targetPath });
  const logOptions = normalizeRotatingLogOptions({ maxBytes: logMaxBytes, maxFiles: logMaxFiles });
  try {
    appendRotatingLogLine(
      logPath,
      `${new Date().toISOString()} spawning Senti daemon for ${normalizedSessionId}`,
      logOptions,
    );
    const child = spawn(
      process.execPath,
      [
        entryPath,
        "session",
        "daemon",
        normalizedSessionId,
        "--path",
        path.resolve(String(targetPath || ".")),
        "--log-file",
        logPath,
        "--log-max-bytes",
        String(logOptions.maxBytes),
        "--log-max-files",
        String(logOptions.maxFiles),
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        env,
      }
    );
    child.unref();
    return {
      spawned: true,
      pid: child.pid ?? null,
      reason: "spawned",
      logPath,
      logMaxBytes: logOptions.maxBytes,
      logMaxFiles: logOptions.maxFiles,
    };
  } catch (error) {
    return {
      spawned: false,
      pid: null,
      reason: `spawn_failed: ${normalizeString(error?.message) || "unknown"}`,
      logPath,
    };
  }
}
