import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { claimAssignment, listAssignments } from "../src/daemon/assignment-ledger.js";
import { applyDaemonBudgetCheck, evaluateDaemonBudget, listBudgetStates } from "../src/daemon/budget-governor.js";
import {
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../src/daemon/error-worker.js";

async function seedAssignedWorkItem(targetPath) {
  await appendAdminErrorEvent({
    targetPath,
    event: {
      service: "sentinelayer-api",
      endpoint: "/v1/runtime/runs",
      errorCode: "RUNTIME_TIMEOUT",
      severity: "P1",
      message: "seed budget governor event",
    },
  });
  await runErrorDaemonWorker({
    targetPath,
    maxEvents: 20,
  });
  const queue = await listErrorQueue({
    targetPath,
    limit: 20,
  });
  const workItemId = String(queue.items[0]?.workItemId || "");
  if (!workItemId) {
    throw new Error("Expected seeded work item.");
  }
  await claimAssignment({
    targetPath,
    workItemId,
    agentIdentity: "maya.markov@sentinelayer.local",
    stage: "analysis",
    runId: "run_budget_001",
  });
  return workItemId;
}

test("Unit daemon budget governor: evaluate emits warning and hard-limit states deterministically", () => {
  const warningEval = evaluateDaemonBudget({
    budget: {
      maxTokens: 1000,
      warningThresholdPercent: 80,
      quarantineGraceSeconds: 30,
    },
    usage: {
      tokensUsed: 850,
    },
    nowIso: "2026-04-02T00:00:00.000Z",
  });
  assert.equal(warningEval.lifecycleState, "WARNING_THRESHOLD");
  assert.equal(warningEval.action, "NONE");
  assert.equal(warningEval.warnings.some((warning) => warning.code === "TOKENS_NEAR_LIMIT"), true);

  const hardLimitEval = evaluateDaemonBudget({
    budget: {
      maxTokens: 1000,
      warningThresholdPercent: 80,
      quarantineGraceSeconds: 30,
    },
    usage: {
      tokensUsed: 1200,
    },
    nowIso: "2026-04-02T00:00:00.000Z",
  });
  assert.equal(hardLimitEval.lifecycleState, "HARD_LIMIT_QUARANTINED");
  assert.equal(hardLimitEval.action, "QUARANTINE");
  assert.equal(hardLimitEval.stopReasons.some((reason) => reason.code === "MAX_TOKENS_EXCEEDED"), true);
});

test("Unit daemon budget governor: hard-limit quarantine advances to kill after grace window", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-budget-governor-"));
  try {
    const workItemId = await seedAssignedWorkItem(tempRoot);

    const first = await applyDaemonBudgetCheck({
      targetPath: tempRoot,
      workItemId,
      budget: {
        maxTokens: 100,
        quarantineGraceSeconds: 30,
      },
      usage: {
        tokensUsed: 150,
      },
      nowIso: "2026-04-02T00:00:00.000Z",
    });
    assert.equal(first.action, "QUARANTINE");
    assert.equal(first.lifecycleState, "HARD_LIMIT_QUARANTINED");

    const blockedQueue = await listErrorQueue({
      targetPath: tempRoot,
      statuses: ["BLOCKED"],
      limit: 10,
    });
    assert.equal(blockedQueue.items.some((item) => item.workItemId === workItemId), true);

    const second = await applyDaemonBudgetCheck({
      targetPath: tempRoot,
      workItemId,
      budget: {
        maxTokens: 100,
        quarantineGraceSeconds: 30,
      },
      usage: {
        tokensUsed: 170,
      },
      nowIso: "2026-04-02T00:00:35.000Z",
    });
    assert.equal(second.action, "KILL");
    assert.equal(second.lifecycleState, "HARD_LIMIT_SQUASHED");

    const squashedQueue = await listErrorQueue({
      targetPath: tempRoot,
      statuses: ["SQUASHED"],
      limit: 10,
    });
    assert.equal(squashedQueue.items.some((item) => item.workItemId === workItemId), true);

    const assignment = await listAssignments({
      targetPath: tempRoot,
      statuses: ["SQUASHED"],
      limit: 10,
    });
    assert.equal(assignment.assignments.some((item) => item.workItemId === workItemId), true);

    const budgetState = await listBudgetStates({
      targetPath: tempRoot,
      workItemId,
      limit: 10,
    });
    assert.equal(budgetState.visibleCount, 1);
    assert.equal(budgetState.records[0].lifecycleState, "HARD_LIMIT_SQUASHED");
    assert.equal(budgetState.records[0].lastAction, "KILL");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
