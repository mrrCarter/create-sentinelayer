import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  getListenerProcessStatus,
  normalizeListenerProcessKey,
  readGlobalListenerPidRecord,
  readListenerPidRecord,
  removeListenerPidRecord,
  requestListenerProcessStop,
  resolveGlobalListenerPidPath,
  resolveListenerPidPath,
  writeListenerPidRecord,
} from "../src/session/listener-process.js";
import { createSession } from "../src/session/store.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "listener-process-fixture", version: "1.0.0" }, null, 2),
    "utf-8",
  );
}

async function spawnExitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
}

function listenerCommandLine({ sessionId = "sess", agentId = "Codex" } = {}) {
  return [
    process.execPath,
    path.join("node_modules", "sentinelayer-cli", "bin", "sl.js"),
    "session",
    "listen",
    "--session",
    sessionId,
    "--agent",
    agentId,
  ].join(" ");
}

test("Unit listener-process: pid record round-trip and stale detection", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listener-pid-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });

    assert.equal(normalizeListenerProcessKey("Codex Product/0344"), "codex-product-0344");
    assert.match(
      resolveListenerPidPath(session.sessionId, "Codex Product/0344", { targetPath: tempRoot }),
      /codex-product-0344\.json$/,
    );

    const initial = await getListenerProcessStatus(session.sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
    });
    assert.deepEqual(
      { running: initial.running, pid: initial.pid, stale: initial.stale },
      { running: false, pid: null, stale: false },
    );

    await writeListenerPidRecord(session.sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      pid: process.pid,
      listenerId: "listener-codex-test",
      transport: "poll",
      intervalSeconds: 60,
      activeIntervalSeconds: 30,
      presenceIntervalSeconds: 60,
    });
    const alive = await getListenerProcessStatus(session.sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _readProcessCommandLine: async () =>
        listenerCommandLine({ sessionId: session.sessionId, agentId: "Codex" }),
    });
    assert.equal(alive.running, true);
    assert.equal(alive.pid, process.pid);
    assert.equal(alive.record.listenerId, "listener-codex-test");
    assert.equal(alive.stale, false);

    const reused = await getListenerProcessStatus(session.sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      _readProcessCommandLine: async () => `${process.execPath} unrelated-worker.js`,
    });
    assert.equal(reused.running, false);
    assert.equal(reused.stale, true);
    assert.equal(reused.reused, true);
    assert.equal(reused.pid, null);

    const deadPid = await spawnExitedPid();
    await writeListenerPidRecord(session.sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
      pid: deadPid,
    });
    const stale = await getListenerProcessStatus(session.sessionId, "Codex", {
      targetPath: tempRoot,
      homeDir: tempRoot,
    });
    assert.equal(stale.running, false);
    assert.equal(stale.stale, true);

    assert.equal(
      await removeListenerPidRecord(session.sessionId, "Codex", {
        targetPath: tempRoot,
        homeDir: tempRoot,
        onlyForPid: process.pid,
      }),
      false,
    );
    assert.ok(
      await readListenerPidRecord(session.sessionId, "Codex", {
        targetPath: tempRoot,
      }),
    );
    assert.ok(
      await readGlobalListenerPidRecord(session.sessionId, "Codex", {
        homeDir: tempRoot,
      }),
    );
    assert.equal(
      await removeListenerPidRecord(session.sessionId, "Codex", {
        targetPath: tempRoot,
        homeDir: tempRoot,
        onlyForPid: deadPid,
      }),
      true,
    );
    assert.equal(
      await readListenerPidRecord(session.sessionId, "Codex", { targetPath: tempRoot }),
      null,
    );
    assert.equal(
      await readGlobalListenerPidRecord(session.sessionId, "Codex", { homeDir: tempRoot }),
      null,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit listener-process: global pid record blocks duplicates across worktrees", async () => {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listener-home-"));
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listener-first-"));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listener-second-"));
  try {
    await seedWorkspace(firstRoot);
    await seedWorkspace(secondRoot);
    const sessionId = "cross-worktree-session";
    const agentId = "Codex";
    assert.match(
      resolveGlobalListenerPidPath(sessionId, agentId, { homeDir: homeRoot }),
      /cross-worktree-session[\\/]codex\.json$/,
    );

    await writeListenerPidRecord(sessionId, agentId, {
      targetPath: firstRoot,
      homeDir: homeRoot,
      pid: process.pid,
      listenerId: "listener-first-root",
      transport: "poll",
    });

    const fromSecondRoot = await getListenerProcessStatus(sessionId, agentId, {
      targetPath: secondRoot,
      homeDir: homeRoot,
      _readProcessCommandLine: async () => listenerCommandLine({ sessionId, agentId }),
    });
    assert.equal(fromSecondRoot.running, true);
    assert.equal(fromSecondRoot.pid, process.pid);
    assert.equal(fromSecondRoot.recordScope, "global");
    assert.equal(fromSecondRoot.record.listenerId, "listener-first-root");
    assert.equal(path.resolve(fromSecondRoot.record.targetPath), path.resolve(firstRoot));

    assert.equal(
      await readListenerPidRecord(sessionId, agentId, { targetPath: secondRoot }),
      null,
    );
    assert.ok(await readGlobalListenerPidRecord(sessionId, agentId, { homeDir: homeRoot }));

    assert.equal(
      await removeListenerPidRecord(sessionId, agentId, {
        targetPath: secondRoot,
        homeDir: homeRoot,
        onlyForPid: process.pid,
      }),
      true,
    );
    assert.equal(
      await readGlobalListenerPidRecord(sessionId, agentId, { homeDir: homeRoot }),
      null,
    );
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("Unit listener-process: force stop requests SIGTERM and waits for exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    const result = await requestListenerProcessStop(child.pid, {
      timeoutMs: 5000,
      pollIntervalMs: 50,
    });
    assert.equal(result.requested, true);
    assert.equal(result.stopped, true);
  } finally {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Already stopped.
      }
    }
  }
});
