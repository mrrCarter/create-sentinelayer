import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { formatSentiDaemonStatusLine, registerSessionCommand } from "../src/commands/session.js";
import {
  getDaemonStatus,
  isProcessAlive,
  readDaemonPidRecord,
  removeDaemonPidRecord,
  resolveDaemonPidPath,
  sentiDaemonDisabled,
  spawnDetachedSentiDaemon,
  writeDaemonPidRecord,
} from "../src/session/daemon-spawn.js";
import { appendRotatingLogLine, installRotatingConsoleLog } from "../src/session/rotating-log.js";
import { createSession } from "../src/session/store.js";

const CLI_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "sentinelayer-cli.js"
);

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "daemon-spawn-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function spawnExitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
}

async function runSessionCommand(args = []) {
  const program = new Command();
  program.name("sl").exitOverride();
  registerSessionCommand(program);
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

test("Unit daemon-spawn: pid record round-trip and liveness status", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-pid-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });

    assert.equal(await readDaemonPidRecord(session.sessionId, { targetPath: tempRoot }), null);
    const noDaemon = await getDaemonStatus(session.sessionId, { targetPath: tempRoot });
    assert.deepEqual(
      { running: noDaemon.running, pid: noDaemon.pid, stale: noDaemon.stale },
      { running: false, pid: null, stale: false }
    );

    // Our own pid is definitionally alive.
    await writeDaemonPidRecord(session.sessionId, { targetPath: tempRoot, pid: process.pid });
    const alive = await getDaemonStatus(session.sessionId, { targetPath: tempRoot });
    assert.equal(alive.running, true);
    assert.equal(alive.pid, process.pid);

    // A pid that has exited reads as stale, not running.
    const deadPid = await spawnExitedPid();
    assert.equal(isProcessAlive(deadPid), false);
    await writeDaemonPidRecord(session.sessionId, { targetPath: tempRoot, pid: deadPid });
    const stale = await getDaemonStatus(session.sessionId, { targetPath: tempRoot });
    assert.equal(stale.running, false);
    assert.equal(stale.stale, true);

    // onlyForPid guards cleanup against removing another daemon's record.
    assert.equal(
      await removeDaemonPidRecord(session.sessionId, { targetPath: tempRoot, onlyForPid: process.pid }),
      false
    );
    assert.equal(
      await removeDaemonPidRecord(session.sessionId, { targetPath: tempRoot, onlyForPid: deadPid }),
      true
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: spawn guards (disabled env, missing id, already running)", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-guards-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });

    assert.equal(sentiDaemonDisabled({ SENTINELAYER_SKIP_SENTI_AUTOSTART: "1" }), true);
    assert.equal(sentiDaemonDisabled({ SENTINELAYER_SKIP_SENTI_DAEMON: "1" }), true);
    assert.equal(sentiDaemonDisabled({}), false);

    const missing = await spawnDetachedSentiDaemon({ sessionId: "", targetPath: tempRoot });
    assert.equal(missing.reason, "missing_session_id");

    const disabled = await spawnDetachedSentiDaemon({
      sessionId: session.sessionId,
      targetPath: tempRoot,
      env: { SENTINELAYER_SKIP_SENTI_AUTOSTART: "1" },
    });
    assert.deepEqual({ spawned: disabled.spawned, reason: disabled.reason }, { spawned: false, reason: "disabled" });

    await writeDaemonPidRecord(session.sessionId, { targetPath: tempRoot, pid: process.pid });
    const dedupe = await spawnDetachedSentiDaemon({
      sessionId: session.sessionId,
      targetPath: tempRoot,
      env: {},
    });
    assert.equal(dedupe.spawned, false);
    assert.equal(dedupe.reason, "already_running");
    assert.equal(dedupe.pid, process.pid);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: rotating log helper retains bounded backups", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-log-rotate-"));
  try {
    const logPath = path.join(tempRoot, "senti-daemon.log");
    await writeFile(logPath, "active-over-limit", "utf-8");
    await writeFile(`${logPath}.1`, "previous-one", "utf-8");
    await writeFile(`${logPath}.2`, "previous-two", "utf-8");

    const result = appendRotatingLogLine(logPath, "new-active-line", {
      maxBytes: 5,
      maxFiles: 3,
    });

    assert.equal(result.written, true);
    assert.equal(result.rotation.rotated, true);
    assert.equal(await readFile(logPath, "utf-8"), "new-active-line\n");
    assert.equal(await readFile(`${logPath}.1`, "utf-8"), "active-over-limit");
    assert.equal(await readFile(`${logPath}.2`, "utf-8"), "previous-one");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: rotating log helper redacts token-shaped output", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-log-redact-"));
  try {
    const logPath = path.join(tempRoot, "senti-daemon.log");
    const bearerToken = ["tok", "daemon", "secret", "1234567890"].join("_");
    const apiKey = ["sk", "daemon", "redact", "1234567890"].join("-");
    const jwt = ["eyJhbGciOiJIUzI1NiI", "eyJzdWIiOiIxMjMifQ", "sig"].join(".");

    appendRotatingLogLine(
      logPath,
      `Authorization: Bearer ${bearerToken} SENTINELAYER_TOKEN=${bearerToken} OPENAI_API_KEY=${apiKey} jwt=${jwt}`,
      { maxBytes: 1024, maxFiles: 2 },
    );

    const logText = await readFile(logPath, "utf-8");
    assert.equal(logText.includes(bearerToken), false);
    assert.equal(logText.includes(apiKey), false);
    assert.equal(logText.includes(jwt), false);
    assert.match(logText, /bearer \[REDACTED\]/i);
    assert.match(logText, /SENTINELAYER_TOKEN=\[REDACTED\]/);
    assert.match(logText, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.match(logText, /\[REDACTED_JWT\]/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: rotating console logger captures stderr without terminal tee", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-stderr-log-"));
  try {
    const logPath = path.join(tempRoot, "senti-daemon.log");
    const restore = installRotatingConsoleLog({
      logPath,
      maxBytes: 1024,
      maxFiles: 2,
      tee: false,
      now: () => new Date("2026-06-25T00:00:00.000Z"),
    });
    try {
      console.log("stdout tick");
      console.error("console error", { code: "boom" });
      process.stderr.write("raw stderr line\n");
    } finally {
      restore();
    }

    const logText = await readFile(logPath, "utf-8");
    assert.match(logText, /stdout tick/);
    assert.match(logText, /\[stderr\] console error \{ code: 'boom' \}/);
    assert.match(logText, /\[stderr\] raw stderr line/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: session daemon --once writes a bounded log file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-log-file-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });
    const output = await runSessionCommand([
      "session",
      "daemon",
      session.sessionId,
      "--path",
      tempRoot,
      "--once",
      "--log-file",
      "daemon-once.log",
      "--log-max-bytes",
      "1024",
      "--log-max-files",
      "2",
    ]);

    assert.match(output, /senti tick:/);
    const logText = await readFile(path.join(tempRoot, "daemon-once.log"), "utf-8");
    assert.match(logText, /senti tick:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: real detached daemon writes pid file, survives, and stops on SIGTERM", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-real-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });
    const childEnv = {
      ...process.env,
      SENTINELAYER_SKIP_REMOTE_SYNC: "1",
      SENTINELAYER_SKIP_SENTI_AUTOSTART: "",
      // The real bin runs the auth gate; an env token passes it (same
      // pattern as the e2e suite) and SKIP_REMOTE_SYNC keeps it offline.
      SENTINELAYER_TOKEN: "api_token_daemon_spawn_test",
    };

    const result = await spawnDetachedSentiDaemon({
      sessionId: session.sessionId,
      targetPath: tempRoot,
      cliPath: CLI_ENTRY,
      env: childEnv,
    });
    assert.equal(result.spawned, true, `expected spawn, got ${result.reason}`);
    assert.ok(result.pid > 0);

    // Generous window: on cold, loaded CI runners the child has to boot the
    // whole CLI module graph while sibling test processes compete for CPU.
    const pidPath = resolveDaemonPidPath(session.sessionId, { targetPath: tempRoot });
    const wrotePid = await waitFor(
      async () => {
        try {
          const record = JSON.parse(await readFile(pidPath, "utf-8"));
          return Number(record.pid) > 0 && isProcessAlive(record.pid);
        } catch {
          return false;
        }
      },
      { timeoutMs: 60000 }
    );
    const childLog = await readFile(result.logPath, "utf-8").catch(() => "(no log written)");
    assert.equal(
      wrotePid,
      true,
      `daemon child never wrote a live pid file. spawn=${JSON.stringify(result)} child log:\n${childLog}`
    );

    const status = await getDaemonStatus(session.sessionId, { targetPath: tempRoot });
    assert.equal(status.running, true);

    process.kill(status.pid, "SIGTERM");
    const stopped = await waitFor(async () => !isProcessAlive(status.pid), { timeoutMs: 30000 });
    assert.equal(stopped, true, "daemon did not stop after SIGTERM");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: session start output is force-new aware and reports daemon state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-start-output-"));
  try {
    await seedWorkspace(tempRoot);
    // Test env sets SENTINELAYER_SKIP_SENTI_AUTOSTART=1, so the daemon line
    // must surface the skip + the manual command instead of staying silent.
    const output = await runSessionCommand([
      "session",
      "start",
      "--path",
      tempRoot,
      "--title",
      "managed-room",
      "--force-new",
    ]);

    assert.ok(!output.includes("Pass --force-new to override"), "tip must not suggest a flag that was already passed");
    assert.ok(output.includes("fresh session minted (--force-new honored)"));
    assert.ok(output.includes("Dashboard: "));
    assert.ok(output.includes("Agents join with: "));
    assert.ok(output.includes("session is unmanaged"));
    assert.ok(output.includes("session daemon"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: --force is an honored alias of --force-new on session start", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-start-force-alias-"));
  try {
    await seedWorkspace(tempRoot);
    // The bug Carter hit: `sl session start --force` silently no-op'd because
    // only --force-new existed. --force must now behave identically.
    const output = await runSessionCommand([
      "session",
      "start",
      "--path",
      tempRoot,
      "--title",
      "alias-room",
      "--force",
    ]);
    assert.ok(
      output.includes("fresh session minted (--force-new honored)"),
      "--force must mint a fresh session like --force-new",
    );
    assert.ok(!output.includes("Pass --force-new to override"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon-spawn: status line formatting covers all daemon outcomes", () => {
  const spawned = formatSentiDaemonStatusLine(
    { spawned: true, pid: 4242, logPath: "/tmp/senti-daemon.log" },
    { cliCommand: "sl", sessionId: "abc" }
  );
  assert.equal(spawned.tone, "green");
  assert.ok(spawned.text.includes("pid 4242"));
  assert.ok(spawned.text.includes("survives this terminal"));

  const already = formatSentiDaemonStatusLine(
    { spawned: false, reason: "already_running", pid: 99 },
    { cliCommand: "sl", sessionId: "abc" }
  );
  assert.equal(already.tone, "green");
  assert.ok(already.text.includes("already managing"));

  const optOut = formatSentiDaemonStatusLine(
    { spawned: false, reason: "opt_out" },
    { cliCommand: "sl", sessionId: "abc" }
  );
  assert.equal(optOut.tone, "gray");
  assert.ok(optOut.text.includes("--no-daemon"));
  assert.ok(optOut.text.includes("sl session daemon abc"));

  const failed = formatSentiDaemonStatusLine(
    { spawned: false, reason: "spawn_failed: boom" },
    { cliCommand: "sl", sessionId: "abc" }
  );
  assert.equal(failed.tone, "yellow");
  assert.ok(failed.text.includes("spawn_failed: boom"));
});
