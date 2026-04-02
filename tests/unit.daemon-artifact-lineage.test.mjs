import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { claimAssignment } from "../src/daemon/assignment-ledger.js";
import { buildArtifactLineageIndex, listArtifactLineage } from "../src/daemon/artifact-lineage.js";
import { applyDaemonBudgetCheck } from "../src/daemon/budget-governor.js";
import {
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../src/daemon/error-worker.js";
import { openJiraIssue } from "../src/daemon/jira-lifecycle.js";
import { buildOperatorControlSnapshot } from "../src/daemon/operator-control.js";

async function seedLineageWorkItem(targetPath) {
  await appendAdminErrorEvent({
    targetPath,
    event: {
      service: "sentinelayer-api",
      endpoint: "/v1/runtime/runs",
      errorCode: "RUNTIME_TIMEOUT",
      severity: "P1",
      message: "seed lineage work item",
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

test("Unit daemon artifact lineage: build index links queue/assignment/jira/budget/operator artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-lineage-build-"));
  try {
    const workItemId = await seedLineageWorkItem(tempRoot);
    await claimAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "maya.markov@sentinelayer.local",
      stage: "analysis",
      runId: "loop_001",
      nowIso: "2026-04-02T00:00:00.000Z",
    });
    await openJiraIssue({
      targetPath: tempRoot,
      workItemId,
      issueKeyPrefix: "SL",
      actor: "maya.markov@sentinelayer.local",
      nowIso: "2026-04-02T00:00:12.000Z",
    });
    await applyDaemonBudgetCheck({
      targetPath: tempRoot,
      workItemId,
      budget: {
        maxTokens: 100,
        warningThresholdPercent: 80,
      },
      usage: {
        tokensUsed: 95,
      },
      nowIso: "2026-04-02T00:00:20.000Z",
    });
    await buildOperatorControlSnapshot({
      targetPath: tempRoot,
      nowIso: "2026-04-02T00:00:30.000Z",
    });

    const built = await buildArtifactLineageIndex({
      targetPath: tempRoot,
      nowIso: "2026-04-02T00:00:40.000Z",
    });
    assert.equal(built.summary.totalWorkItemsIndexed, 1);
    assert.equal(built.summary.jiraLinkedCount, 1);
    assert.equal(built.summary.budgetGuardedCount, 1);
    assert.equal(built.summary.operatorCoveredCount, 1);
    assert.equal(built.workItems[0].workItemId, workItemId);
    assert.equal(built.workItems[0].links.agentIdentity, "maya.markov@sentinelayer.local");
    assert.equal(built.workItems[0].links.jiraIssueKey.startsWith("SL-"), true);
    assert.equal(built.workItems[0].links.loopRunId, "loop_001");
    assert.equal(built.workItems[0].links.budgetLifecycleState, "WARNING_THRESHOLD");
    assert.equal(
      Array.isArray(built.workItems[0].artifacts.budgetRuns) &&
        built.workItems[0].artifacts.budgetRuns.length > 0,
      true
    );
    assert.equal(
      Array.isArray(built.workItems[0].artifacts.operatorSnapshots) &&
        built.workItems[0].artifacts.operatorSnapshots.length > 0,
      true
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon artifact lineage: list auto-builds and filters by work item/status", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-lineage-list-"));
  try {
    const workItemId = await seedLineageWorkItem(tempRoot);
    await claimAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "mark.rao@sentinelayer.local",
      stage: "triage",
      runId: "loop_002",
      nowIso: "2026-04-02T00:05:00.000Z",
    });
    const listed = await listArtifactLineage({
      targetPath: tempRoot,
      workItemId,
      statuses: ["ASSIGNED"],
      limit: 10,
      nowIso: "2026-04-02T00:05:30.000Z",
    });
    assert.equal(listed.totalCount, 1);
    assert.equal(listed.visibleCount, 1);
    assert.equal(listed.workItems[0].workItemId, workItemId);
    assert.equal(listed.workItems[0].workItemStatus, "ASSIGNED");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
