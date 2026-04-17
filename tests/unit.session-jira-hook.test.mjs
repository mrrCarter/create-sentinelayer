import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import {
  commentJiraIssue,
  emitJiraLifecycleEvent,
  startJiraLifecycle,
  transitionJiraIssue,
} from "../src/daemon/jira-lifecycle.js";
import { appendAdminErrorEvent, listErrorQueue, runErrorDaemonWorker } from "../src/daemon/error-worker.js";
import { validateAgentEvent } from "../src/events/schema.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-jira-hook-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

async function seedWorkItem(targetPath, endpoint, errorCode) {
  await appendAdminErrorEvent({
    targetPath,
    event: {
      service: "sentinelayer-api",
      endpoint,
      errorCode,
      severity: "P1",
      message: "seed daemon jira hook event",
    },
  });
  await runErrorDaemonWorker({
    targetPath,
    maxEvents: 50,
  });
  const queued = await listErrorQueue({
    targetPath,
    limit: 20,
  });
  const item = queued.items.find((entry) => entry.endpoint === endpoint && entry.errorCode === errorCode);
  if (!item) {
    throw new Error(`Failed to seed queue work item for ${endpoint} ${errorCode}`);
  }
  return item.workItemId;
}

test("Unit session jira hook: emitJiraLifecycleEvent writes canonical envelope to session stream", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-jira-emit-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const emitted = await emitJiraLifecycleEvent(session.sessionId, {
      phase: "checkpoint",
      ticketKey: "SLD-123",
      workItemId: "wi_123",
      payload: { status: "OPEN", note: "checkpoint update" },
      targetPath: tempRoot,
    });
    assert.equal(validateAgentEvent(emitted, { allowLegacy: false }), true);
    assert.equal(emitted.event, "jira_lifecycle");
    assert.equal(emitted.sessionId, session.sessionId);
    assert.equal(emitted.payload.phase, "checkpoint");
    assert.equal(emitted.payload.ticketKey, "SLD-123");
    assert.equal(emitted.payload.workItemId, "wi_123");
    assert.equal(emitted.agent.id, "omar-orchestrator");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session jira hook: start/comment/transition emit lifecycle phases into session stream", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-jira-flow-"));
  try {
    await seedWorkspace(tempRoot);
    const workItemId = await seedWorkItem(tempRoot, "/v1/runtime/runs", "RUNTIME_TIMEOUT");
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const started = await startJiraLifecycle({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      workItemId,
      actor: "omar-daemon",
      planMessage: "1) inspect stack 2) patch timeout guard 3) rerun checks",
      issueKeyPrefix: "SL",
    });
    await commentJiraIssue({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      workItemId,
      issueKey: started.issue.issueKey,
      actor: "omar-daemon",
      type: "checkpoint",
      message: "Patch prepared and tests running.",
    });
    await transitionJiraIssue({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      workItemId,
      issueKey: started.issue.issueKey,
      toStatus: "BLOCKED",
      actor: "omar-daemon",
      reason: "waiting for dependency rollout",
    });
    await transitionJiraIssue({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      workItemId,
      issueKey: started.issue.issueKey,
      toStatus: "DONE",
      actor: "omar-daemon",
      reason: "dependency rollout completed",
    });

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const lifecycleEvents = stream.filter((event) => event.event === "jira_lifecycle");
    assert.equal(lifecycleEvents.length, 6);
    const phases = lifecycleEvents.map((event) => event.payload.phase);
    assert.deepEqual(phases, [
      "create",
      "plan_comment",
      "in_progress",
      "checkpoint",
      "blocked",
      "resolved",
    ]);

    for (const event of lifecycleEvents) {
      assert.equal(validateAgentEvent(event, { allowLegacy: false }), true);
      assert.equal(event.sessionId, session.sessionId);
      assert.equal(event.agent.id, "omar-orchestrator");
      assert.equal(event.payload.ticketKey, started.issue.issueKey);
      assert.equal(event.payload.workItemId, workItemId);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
