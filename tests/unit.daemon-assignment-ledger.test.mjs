import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  claimAssignment,
  heartbeatAssignment,
  listAssignments,
  reassignAssignment,
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

test("Unit daemon assignment ledger: concurrent claims serialize with a single winner", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-assignment-concurrent-"));
  try {
    const workItemId = await seedWorkItem(tempRoot, "/v1/admin/runtime", "LEDGER_RACE");
    const attempts = await Promise.allSettled([
      claimAssignment({
        targetPath: tempRoot,
        workItemId,
        agentIdentity: "agent.one@sentinelayer.local",
        leaseTtlSeconds: 600,
      }),
      claimAssignment({
        targetPath: tempRoot,
        workItemId,
        agentIdentity: "agent.two@sentinelayer.local",
        leaseTtlSeconds: 600,
      }),
    ]);

    const winners = attempts.filter((entry) => entry.status === "fulfilled");
    const losers = attempts.filter((entry) => entry.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(String(losers[0].reason?.message || ""), /currently leased/);

    const assignments = await listAssignments({
      targetPath: tempRoot,
      statuses: ["CLAIMED"],
      limit: 10,
    });
    assert.equal(assignments.visibleCount, 1);
    assert.equal(assignments.assignments[0].workItemId, workItemId);
    assert.equal(assignments.assignments[0].status, "CLAIMED");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
