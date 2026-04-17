import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { listAssignments } from "../src/daemon/assignment-ledger.js";
import { createAgentEvent, validateAgentEvent } from "../src/events/schema.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { startSenti, stopSenti } from "../src/session/daemon.js";
import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";
import { assignTask, listSessionTasks } from "../src/session/tasks.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-tasks-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const ready = true;\n", "utf-8");
}

async function waitForStreamEvent(
  sessionId,
  targetPath,
  predicate,
  { timeoutMs = 3000, pollMs = 40 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readStream(sessionId, { tail: 200, targetPath });
    const match = events.find(predicate);
    if (match) {
      return match;
    }
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for stream event.");
}

test("Unit session tasks: assign -> accepted -> completed round-trip emits canonical task events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-tasks-roundtrip-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;

    await registerAgent(sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await registerAgent(sessionId, {
      agentId: "claude-a1b2",
      model: "Claude 3.7 Sonnet",
      role: "reviewer",
      targetPath: tempRoot,
    });
    await startSenti(sessionId, {
      targetPath: tempRoot,
      autoStart: false,
    });

    await appendToStream(
      sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex-c3d4",
        sessionId,
        payload: {
          message:
            "assign: @claude-a1b2 [P2] Fix P2 findings from last scan. Files: src/routes/auth.js, src/middleware/validate.js",
        },
      }),
      {
        targetPath: tempRoot,
      }
    );

    const assignedEvent = await waitForStreamEvent(
      sessionId,
      tempRoot,
      (event) => event.event === "task_assign"
    );
    assert.equal(validateAgentEvent(assignedEvent, { allowLegacy: false }), true);
    assert.equal(assignedEvent.agent.id, "codex-c3d4");
    assert.equal(assignedEvent.payload.to, "claude-a1b2");
    assert.equal(assignedEvent.payload.priority, "P2");
    const taskId = String(assignedEvent.payload.taskId || "").trim();
    const workItemId = String(assignedEvent.payload.workItemId || "").trim();
    assert.ok(taskId);
    assert.ok(workItemId);

    await appendToStream(
      sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "claude-a1b2",
        sessionId,
        payload: {
          message: "accepted: taking P2 fix assignment from codex-c3d4",
        },
      }),
      {
        targetPath: tempRoot,
      }
    );

    const acceptedEvent = await waitForStreamEvent(
      sessionId,
      tempRoot,
      (event) => event.event === "task_accepted" && event.payload.taskId === taskId
    );
    assert.equal(validateAgentEvent(acceptedEvent, { allowLegacy: false }), true);
    assert.equal(acceptedEvent.agent.id, "claude-a1b2");

    await appendToStream(
      sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "claude-a1b2",
        sessionId,
        payload: {
          message: "done: P2 fixes complete, pushed to fix/auth-hardening",
        },
      }),
      {
        targetPath: tempRoot,
      }
    );

    const completedEvent = await waitForStreamEvent(
      sessionId,
      tempRoot,
      (event) => event.event === "task_completed" && event.payload.taskId === taskId
    );
    assert.equal(validateAgentEvent(completedEvent, { allowLegacy: false }), true);
    assert.equal(completedEvent.agent.id, "claude-a1b2");

    const completedTasks = await listSessionTasks(sessionId, {
      targetPath: tempRoot,
      status: "COMPLETED",
      limit: 20,
    });
    assert.equal(completedTasks.visibleCount, 1);
    assert.equal(completedTasks.tasks[0].taskId, taskId);
    assert.equal(completedTasks.tasks[0].workItemId, workItemId);
    assert.equal(completedTasks.tasks[0].status, "COMPLETED");

    const doneLeases = await listAssignments({
      targetPath: tempRoot,
      sessionId,
      statuses: ["DONE"],
      limit: 20,
    });
    const done = doneLeases.assignments.find((item) => item.workItemId === workItemId) || null;
    assert.ok(done);
    assert.equal(done.sessionId, sessionId);
    assert.equal(done.assignedAgentIdentity, "claude-a1b2");
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session tasks: wildcard assign routes to least-busy agent matching role filter", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-tasks-wildcard-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;

    await registerAgent(sessionId, {
      agentId: "lead-r1f2",
      model: "gpt-5.4",
      role: "reviewer",
      targetPath: tempRoot,
    });
    await registerAgent(sessionId, {
      agentId: "codex-a1b2",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await registerAgent(sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await registerAgent(sessionId, {
      agentId: "qa-z9y8",
      model: "gpt-5.4-mini",
      role: "tester",
      targetPath: tempRoot,
    });
    await startSenti(sessionId, {
      targetPath: tempRoot,
      autoStart: false,
    });

    await appendToStream(
      sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "lead-r1f2",
        sessionId,
        payload: {
          message: "assign: @codex-a1b2 [P2] First coding assignment",
        },
      }),
      { targetPath: tempRoot }
    );
    await waitForStreamEvent(
      sessionId,
      tempRoot,
      (event) => event.event === "task_assign" && event.payload.to === "codex-a1b2"
    );

    await appendToStream(
      sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "lead-r1f2",
        sessionId,
        payload: {
          message: "assign: @*:coder [P2] Second coding assignment via wildcard",
        },
      }),
      { targetPath: tempRoot }
    );

    const wildcardEvent = await waitForStreamEvent(
      sessionId,
      tempRoot,
      (event) =>
        event.event === "task_assign" &&
        event.payload.requestedTo === "*" &&
        event.payload.task.includes("Second coding assignment")
    );
    assert.equal(validateAgentEvent(wildcardEvent, { allowLegacy: false }), true);
    assert.equal(wildcardEvent.payload.to, "codex-c3d4");
    assert.equal(wildcardEvent.payload.roleFilter, "coder");
    assert.equal(wildcardEvent.payload.wildcardRouted, true);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session tasks: assignment lease in daemon ledger reflects task work item binding", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-tasks-lease-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });

    const assigned = await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "codex-c3d4",
      task: "Fix input validation regression in auth middleware. Files: src/auth.js",
      priority: "P1",
      context: {
        omarRunId: "omar-run-123",
      },
      targetPath: tempRoot,
    });
    assert.equal(assigned.task.status, "PENDING");
    assert.ok(assigned.task.workItemId);

    const activeLeases = await listAssignments({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      statuses: ["CLAIMED", "IN_PROGRESS"],
      limit: 20,
    });
    const boundLease =
      activeLeases.assignments.find((item) => item.workItemId === assigned.task.workItemId) || null;
    assert.ok(boundLease);
    assert.equal(boundLease.sessionId, session.sessionId);
    assert.equal(boundLease.assignedAgentIdentity, "codex-c3d4");
    assert.equal(boundLease.status, "CLAIMED");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
