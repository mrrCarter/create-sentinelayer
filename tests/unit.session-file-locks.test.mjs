import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { registerAgent } from "../src/session/agent-registry.js";
import {
  checkFileLock,
  listFileLocks,
  lockFile,
  releaseFileLocksForAgent,
  unlockFile,
} from "../src/session/file-locks.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-file-locks-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
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

  return logs.join("\n").trim();
}

test("Unit session file locks: lock acquire is exclusive and second attempt returns heldBy + since", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-lock-exclusive-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const first = await lockFile(session.sessionId, "codex-c3d4", "src/routes/auth.js", {
      intent: "implementing JWT middleware",
      targetPath: tempRoot,
      nowIso: "2026-04-17T11:30:00.000Z",
    });
    assert.equal(first.locked, true);
    assert.equal(first.file, "src/routes/auth.js");
    assert.equal(first.lock.agentId, "codex-c3d4");

    const second = await lockFile(session.sessionId, "claude-a1b2", "src/routes/auth.js", {
      intent: "reviewing auth route",
      targetPath: tempRoot,
      nowIso: "2026-04-17T11:32:10.000Z",
    });
    assert.equal(second.locked, false);
    assert.equal(second.heldBy, "codex-c3d4");
    assert.match(String(second.since || ""), /m ago$/);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const lockEvents = stream.filter((event) => event.event === "file_lock");
    assert.equal(lockEvents.length, 1);
    assert.equal(lockEvents[0].payload.file, "src/routes/auth.js");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file locks: expired locks are cleared and expiration is observable via stream event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-lock-expire-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await lockFile(session.sessionId, "codex-c3d4", "src/routes/auth.js", {
      intent: "temporary patch",
      ttlSeconds: 1,
      targetPath: tempRoot,
      nowIso: "2026-04-17T11:31:00.000Z",
    });

    const lock = await checkFileLock(session.sessionId, "src/routes/auth.js", {
      targetPath: tempRoot,
      nowIso: "2026-04-17T11:31:03.000Z",
    });
    assert.equal(lock, null);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const expiredEvent = stream.find((event) => event.event === "file_lock_expired");
    assert.ok(expiredEvent);
    assert.equal(expiredEvent.payload.file, "src/routes/auth.js");
    assert.equal(expiredEvent.payload.heldBy, "codex-c3d4");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file locks: unlock emits file_unlock event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-lock-unlock-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await lockFile(session.sessionId, "codex-c3d4", "src/routes/auth.js", {
      intent: "implementing fix",
      targetPath: tempRoot,
      nowIso: "2026-04-17T11:34:00.000Z",
    });

    const unlocked = await unlockFile(session.sessionId, "codex-c3d4", "src/routes/auth.js", {
      reason: "done",
      targetPath: tempRoot,
      nowIso: "2026-04-17T11:34:30.000Z",
    });
    assert.equal(unlocked.unlocked, true);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const unlockEvent = stream.find((event) => event.event === "file_unlock");
    assert.ok(unlockEvent);
    assert.equal(unlockEvent.payload.file, "src/routes/auth.js");
    assert.equal(unlockEvent.payload.reason, "done");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file locks: session kill releases locks held by the killed agent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-lock-kill-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await registerAgent(session.sessionId, {
      targetPath: tempRoot,
      agentId: "codex-c3d4",
      role: "coder",
      model: "gpt-5.4",
    });
    await lockFile(session.sessionId, "codex-c3d4", "src/routes/auth.js", {
      intent: "middleware refactor",
      targetPath: tempRoot,
    });
    await lockFile(session.sessionId, "codex-c3d4", "src/middleware/validate.js", {
      intent: "input validation",
      targetPath: tempRoot,
    });

    const killOutput = await runSessionCommand([
      "session",
      "kill",
      "--session",
      session.sessionId,
      "--agent",
      "codex-c3d4",
      "--path",
      tempRoot,
      "--json",
    ]);
    const killPayload = JSON.parse(killOutput);
    assert.equal(killPayload.command, "session kill");
    assert.equal(Number(killPayload.lockRevocations || 0) >= 2, true);

    const activeLocks = await listFileLocks(session.sessionId, {
      targetPath: tempRoot,
      emitExpiredEvents: false,
    });
    assert.equal(activeLocks.length, 0);

    const stream = await readStream(session.sessionId, { tail: 40, targetPath: tempRoot });
    const unlockEvents = stream.filter(
      (event) =>
        event.event === "file_unlock" &&
        event.payload.heldBy === "codex-c3d4" &&
        String(event.payload.reason || "").startsWith("agent_killed:")
    );
    assert.equal(unlockEvents.length, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file locks: releaseFileLocksForAgent is idempotent when no locks remain", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-lock-release-idempotent-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const released = await releaseFileLocksForAgent(session.sessionId, "codex-c3d4", {
      targetPath: tempRoot,
    });
    assert.equal(released.releasedCount, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
