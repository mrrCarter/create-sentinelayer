import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { validateAgentEvent } from "../src/events/schema.js";
import {
  detectStaleAgents,
  generateAgentId,
  heartbeatAgent,
  listAgents,
  registerAgent,
  unregisterAgent,
} from "../src/session/agent-registry.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-agent-registry-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

test("Unit session agent registry: register/heartbeat/list/stale detection", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-agents-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    assert.match(generateAgentId("Claude 3.7 Sonnet"), /^claude-[a-f0-9]{4}$/);
    assert.match(generateAgentId("gpt-5.4"), /^codex-[a-f0-9]{4}$/);

    const registered = await registerAgent(session.sessionId, {
      model: "Claude 3.7 Sonnet",
      role: "coder",
      targetPath: tempRoot,
    });
    assert.equal(registered.role, "coder");
    assert.equal(registered.status, "idle");
    assert.equal(registered.active, true);

    const persisted = JSON.parse(await readFile(registered.snapshotPath, "utf-8"));
    assert.equal(persisted.agentId, registered.agentId);
    assert.equal(persisted.sessionId, session.sessionId);
    assert.equal(persisted.role, "coder");

    const heartbeat = await heartbeatAgent(session.sessionId, registered.agentId, {
      status: "coding",
      detail: "Implementing registry wiring",
      file: "src/session/agent-registry.js",
      targetPath: tempRoot,
    });
    assert.equal(heartbeat.status, "coding");
    assert.equal(heartbeat.file, "src/session/agent-registry.js");
    assert.equal(heartbeat.detail, "Implementing registry wiring");
    assert.equal(Date.parse(heartbeat.lastActivityAt) >= Date.parse(registered.lastActivityAt), true);

    const activeAgents = await listAgents(session.sessionId, {
      targetPath: tempRoot,
      includeInactive: false,
    });
    assert.equal(activeAgents.length, 1);
    assert.equal(activeAgents[0].agentId, registered.agentId);
    assert.equal(activeAgents[0].status, "coding");

    const staleLater = detectStaleAgents(activeAgents, {
      idleThresholdSeconds: 90,
      nowIso: new Date(Date.parse(heartbeat.lastActivityAt) + 91_000).toISOString(),
    });
    assert.equal(staleLater.length, 1);
    assert.equal(staleLater[0].agentId, registered.agentId);
    assert.equal(staleLater[0].idleSeconds >= 90, true);

    const events = await readStream(session.sessionId, { tail: 10, targetPath: tempRoot });
    assert.equal(events.length >= 1, true);
    const joinEvent = events.find((event) => event.event === "agent_join");
    assert.ok(joinEvent);
    assert.equal(validateAgentEvent(joinEvent, { allowLegacy: false }), true);
    assert.equal(joinEvent.sessionId, session.sessionId);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session agent registry: unregister emits leave and inactives are filterable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-leave-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const registered = await registerAgent(session.sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const left = await unregisterAgent(session.sessionId, registered.agentId, {
      reason: "task_complete",
      targetPath: tempRoot,
    });
    assert.equal(left.active, false);
    assert.equal(left.leaveReason, "task_complete");
    assert.ok(left.leftAt);

    const activeAgents = await listAgents(session.sessionId, {
      targetPath: tempRoot,
      includeInactive: false,
    });
    assert.equal(activeAgents.length, 0);

    const allAgents = await listAgents(session.sessionId, { targetPath: tempRoot });
    assert.equal(allAgents.length, 1);
    assert.equal(allAgents[0].agentId, "codex-c3d4");
    assert.equal(allAgents[0].active, false);

    const events = await readStream(session.sessionId, { tail: 10, targetPath: tempRoot });
    const leaveEvent = events.find((event) => event.event === "agent_leave");
    assert.ok(leaveEvent);
    assert.equal(leaveEvent.payload.reason, "task_complete");
    assert.equal(validateAgentEvent(leaveEvent, { allowLegacy: false }), true);
    assert.equal(leaveEvent.sessionId, session.sessionId);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
