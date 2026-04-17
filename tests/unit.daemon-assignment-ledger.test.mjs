import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  claimAssignment,
  heartbeatLease,
  heartbeatAssignment,
  leaseWorkItem,
  listAssignments,
  reassignLease,
  reassignAssignment,
  releaseLease,
  releaseAssignment,
} from "../src/daemon/assignment-ledger.js";
import {
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../src/daemon/error-worker.js";

async function seedWorkItem(targetPath, endpoint, errorCode) {
  await appendAdminErrorEvent({
    targetPath,
    event: {
      service: "sentinelayer-api",
      endpoint,
      errorCode,
      severity: "P2",
      message: "seed error",
    },
  });
  await runErrorDaemonWorker({
    targetPath,
    maxEvents: 20,
  });
  const queued = await listErrorQueue({
    targetPath,
    limit: 10,
  });
  const item = queued.items.find((entry) => entry.endpoint === endpoint);
  if (!item) {
    throw new Error(`Expected seeded queue item for endpoint '${endpoint}'.`);
  }
  return item.workItemId;
}

test("Unit daemon assignment ledger: claim heartbeat reassign release lifecycle updates queue + ledger", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-assignment-ledger-"));
  try {
    const workItemId = await seedWorkItem(tempRoot, "/v1/runtime/runs", "RUNTIME_TIMEOUT");

    const claimed = await claimAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "maya.markov@sentinelayer.local",
      leaseTtlSeconds: 900,
      stage: "triage",
      runId: "run_001",
      jiraIssueKey: "SL-101",
      budgetSnapshot: { maxTokens: 30000, maxRuntimeMs: 1200000 },
    });
    assert.equal(claimed.assignment.status, "CLAIMED");
    assert.equal(claimed.assignment.assignedAgentIdentity, "maya.markov@sentinelayer.local");

    const heartbeat = await heartbeatAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "maya.markov@sentinelayer.local",
      stage: "analysis",
      runId: "run_002",
    });
    assert.equal(heartbeat.assignment.status, "IN_PROGRESS");
    assert.equal(heartbeat.assignment.stage, "analysis");
    assert.equal(heartbeat.assignment.runId, "run_002");

    const reassigned = await reassignAssignment({
      targetPath: tempRoot,
      workItemId,
      fromAgentIdentity: "maya.markov@sentinelayer.local",
      toAgentIdentity: "mark.rao@sentinelayer.local",
      stage: "fix",
      runId: "run_003",
      jiraIssueKey: "SL-101",
    });
    assert.equal(reassigned.assignment.status, "CLAIMED");
    assert.equal(reassigned.assignment.assignedAgentIdentity, "mark.rao@sentinelayer.local");
    assert.equal(reassigned.assignment.stage, "fix");

    const released = await releaseAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "mark.rao@sentinelayer.local",
      status: "DONE",
      reason: "Fix merged",
    });
    assert.equal(released.assignment.status, "DONE");
    assert.equal(released.assignment.releaseReason, "Fix merged");

    const listDone = await listAssignments({
      targetPath: tempRoot,
      statuses: ["DONE"],
      agentIdentity: "mark.rao@sentinelayer.local",
    });
    assert.equal(listDone.visibleCount, 1);
    assert.equal(listDone.assignments[0].workItemId, workItemId);
    assert.equal(listDone.assignments[0].status, "DONE");

    const queueDone = await listErrorQueue({
      targetPath: tempRoot,
      statuses: ["DONE"],
      limit: 10,
    });
    assert.equal(queueDone.items.length, 1);
    assert.equal(queueDone.items[0].workItemId, workItemId);
    assert.equal(queueDone.items[0].status, "DONE");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon assignment ledger: claim rejects active lease collisions", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-assignment-conflict-"));
  try {
    const workItemId = await seedWorkItem(tempRoot, "/v1/admin/error-log", "STREAM_DROP");
    await claimAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "agent.alpha@sentinelayer.local",
      leaseTtlSeconds: 1200,
    });

    await assert.rejects(
      () =>
        claimAssignment({
          targetPath: tempRoot,
          workItemId,
          agentIdentity: "agent.beta@sentinelayer.local",
          leaseTtlSeconds: 1200,
        }),
      /currently leased/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon assignment ledger: session-scoped leaseWorkItem and reassignLease round-trip", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-assignment-session-"));
  try {
    const workItemId = await seedWorkItem(tempRoot, "/v1/sessions/stream", "STREAM_BACKPRESSURE");

    const leased = await leaseWorkItem({
      targetPath: tempRoot,
      sessionId: "session-alpha",
      workItemId,
      agentIdentity: "agent.alpha@sentinelayer.local",
      leaseTtlMs: 180_000,
      stage: "triage",
      runId: "run_session_1",
    });
    assert.equal(leased.assignment.sessionId, "session-alpha");
    assert.equal(leased.assignment.status, "CLAIMED");

    const heartbeat = await heartbeatLease({
      targetPath: tempRoot,
      sessionId: "session-alpha",
      workItemId,
      agentIdentity: "agent.alpha@sentinelayer.local",
      leaseTtlMs: 180_000,
      stage: "analysis",
      runId: "run_session_2",
    });
    assert.equal(heartbeat.assignment.status, "IN_PROGRESS");
    assert.equal(heartbeat.assignment.stage, "analysis");

    const reassigned = await reassignLease({
      targetPath: tempRoot,
      sessionId: "session-alpha",
      workItemId,
      from: "agent.alpha@sentinelayer.local",
      to: "agent.beta@sentinelayer.local",
      leaseTtlMs: 120_000,
      stage: "fix",
      runId: "run_session_3",
    });
    assert.equal(reassigned.assignment.assignedAgentIdentity, "agent.beta@sentinelayer.local");
    assert.equal(reassigned.assignment.sessionId, "session-alpha");
    assert.equal(reassigned.assignment.status, "CLAIMED");

    const released = await releaseLease({
      targetPath: tempRoot,
      sessionId: "session-alpha",
      workItemId,
      agentIdentity: "agent.beta@sentinelayer.local",
      status: "DONE",
      reason: "session complete",
    });
    assert.equal(released.assignment.status, "DONE");
    assert.equal(released.assignment.sessionId, "session-alpha");

    const sessionMatches = await listAssignments({
      targetPath: tempRoot,
      sessionId: "session-alpha",
      statuses: ["DONE"],
      limit: 10,
    });
    assert.equal(sessionMatches.visibleCount, 1);
    assert.equal(sessionMatches.assignments[0].workItemId, workItemId);

    const wrongSessionMatches = await listAssignments({
      targetPath: tempRoot,
      sessionId: "session-beta",
      limit: 10,
    });
    assert.equal(wrongSessionMatches.visibleCount, 0);

    await assert.rejects(
      () =>
        heartbeatLease({
          targetPath: tempRoot,
          sessionId: "session-beta",
          workItemId,
          agentIdentity: "agent.beta@sentinelayer.local",
        }),
      /bound to session/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
