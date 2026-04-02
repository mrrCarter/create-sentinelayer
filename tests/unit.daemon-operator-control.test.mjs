import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { claimAssignment, listAssignments } from "../src/daemon/assignment-ledger.js";
import { applyDaemonBudgetCheck } from "../src/daemon/budget-governor.js";
import {
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../src/daemon/error-worker.js";
import { listJiraIssues, openJiraIssue } from "../src/daemon/jira-lifecycle.js";
import { applyOperatorStopControl, buildOperatorControlSnapshot } from "../src/daemon/operator-control.js";

async function seedWorkItem(targetPath) {
  await appendAdminErrorEvent({
    targetPath,
    event: {
      service: "sentinelayer-api",
      endpoint: "/v1/runtime/runs",
      errorCode: "RUNTIME_TIMEOUT",
      severity: "P1",
      message: "seed operator control work item",
    },
  });
  await runErrorDaemonWorker({
    targetPath,
    maxEvents: 20,
    nowIso: "2026-04-02T00:00:10.000Z",
  });
  const queue = await listErrorQueue({
    targetPath,
    limit: 20,
  });
  const workItemId = String(queue.items[0]?.workItemId || "");
  if (!workItemId) {
    throw new Error("Expected seeded work item.");
  }
  return workItemId;
}

test("Unit daemon operator control: snapshot includes budget-health color and session timers", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-operator-snapshot-"));
  try {
    const workItemId = await seedWorkItem(tempRoot);
    await claimAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "maya.markov@sentinelayer.local",
      stage: "analysis",
      runId: "run_operator_001",
      nowIso: "2026-04-02T00:00:00.000Z",
    });
    await openJiraIssue({
      targetPath: tempRoot,
      workItemId,
      issueKeyPrefix: "SL",
      actor: "maya.markov@sentinelayer.local",
      nowIso: "2026-04-02T00:00:15.000Z",
    });
    await applyDaemonBudgetCheck({
      targetPath: tempRoot,
      workItemId,
      budget: {
        maxTokens: 100,
        warningThresholdPercent: 80,
      },
      usage: {
        tokensUsed: 90,
      },
      nowIso: "2026-04-02T00:00:20.000Z",
    });

    const snapshot = await buildOperatorControlSnapshot({
      targetPath: tempRoot,
      limit: 20,
      nowIso: "2026-04-02T00:00:30.000Z",
    });
    assert.equal(snapshot.visibleWorkItems, 1);
    assert.equal(snapshot.workItems[0].workItemId, workItemId);
    assert.equal(snapshot.workItems[0].budgetLifecycleState, "WARNING_THRESHOLD");
    assert.equal(snapshot.workItems[0].budgetHealthColor, "YELLOW");
    assert.equal(snapshot.workItems[0].sessionElapsedSeconds, 30);
    assert.equal(snapshot.workItems[0].assignedAgentIdentity, "maya.markov@sentinelayer.local");
    assert.equal(snapshot.agentRoster.length, 1);
    assert.equal(snapshot.agentRoster[0].agentIdentity, "maya.markov@sentinelayer.local");
    assert.equal(snapshot.agentRoster[0].activeWorkItemCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon operator control: stop requires confirm and updates queue/assignment/jira lifecycle", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-operator-stop-"));
  try {
    const workItemId = await seedWorkItem(tempRoot);
    await claimAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "maya.markov@sentinelayer.local",
      stage: "fix",
      runId: "run_operator_002",
      nowIso: "2026-04-02T00:01:00.000Z",
    });
    await openJiraIssue({
      targetPath: tempRoot,
      workItemId,
      issueKeyPrefix: "SL",
      actor: "maya.markov@sentinelayer.local",
      nowIso: "2026-04-02T00:01:05.000Z",
    });

    await assert.rejects(
      () =>
        applyOperatorStopControl({
          targetPath: tempRoot,
          workItemId,
          mode: "QUARANTINE",
          reason: "manual stop",
          actor: "omar-operator",
          confirm: false,
          nowIso: "2026-04-02T00:01:10.000Z",
        }),
      /requires --confirm/
    );

    const blocked = await applyOperatorStopControl({
      targetPath: tempRoot,
      workItemId,
      mode: "QUARANTINE",
      reason: "manual quarantine",
      actor: "omar-operator",
      confirm: true,
      nowIso: "2026-04-02T00:01:15.000Z",
    });
    assert.equal(blocked.targetStatus, "BLOCKED");
    assert.equal(blocked.jiraCommented, true);

    const blockedQueue = await listErrorQueue({
      targetPath: tempRoot,
      statuses: ["BLOCKED"],
      limit: 10,
    });
    assert.equal(blockedQueue.items.some((item) => item.workItemId === workItemId), true);
    const blockedAssignments = await listAssignments({
      targetPath: tempRoot,
      statuses: ["BLOCKED"],
      limit: 10,
    });
    assert.equal(blockedAssignments.assignments.some((item) => item.workItemId === workItemId), true);

    const squashed = await applyOperatorStopControl({
      targetPath: tempRoot,
      workItemId,
      mode: "SQUASH",
      reason: "manual squash",
      actor: "omar-operator",
      confirm: true,
      nowIso: "2026-04-02T00:01:45.000Z",
    });
    assert.equal(squashed.targetStatus, "SQUASHED");
    const squashedQueue = await listErrorQueue({
      targetPath: tempRoot,
      statuses: ["SQUASHED"],
      limit: 10,
    });
    assert.equal(squashedQueue.items.some((item) => item.workItemId === workItemId), true);

    const jira = await listJiraIssues({
      targetPath: tempRoot,
      workItemId,
      limit: 10,
    });
    assert.equal(jira.issues.length, 1);
    const operatorComments = jira.issues[0].comments.filter((comment) => comment.type === "operator_stop");
    assert.equal(operatorComments.length >= 1, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
