import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { claimAssignment, listAssignments } from "../src/daemon/assignment-ledger.js";
import {
  commentJiraIssue,
  listJiraIssues,
  openJiraIssue,
  startJiraLifecycle,
  transitionJiraIssue,
} from "../src/daemon/jira-lifecycle.js";
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
      severity: "P1",
      message: "seed daemon jira event",
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

test("Unit daemon jira lifecycle: start/comment/transition updates issue state and assignment linkage", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-jira-lifecycle-"));
  try {
    const workItemId = await seedWorkItem(tempRoot, "/v1/runtime/runs", "RUNTIME_TIMEOUT");
    await claimAssignment({
      targetPath: tempRoot,
      workItemId,
      agentIdentity: "maya.markov@sentinelayer.local",
      stage: "triage",
      runId: "run_1",
    });

    const started = await startJiraLifecycle({
      targetPath: tempRoot,
      workItemId,
      actor: "maya.markov@sentinelayer.local",
      assignee: "maya.markov@sentinelayer.local",
      planMessage: "1) inspect stack 2) patch timeout guard 3) rerun checks",
      issueKeyPrefix: "SL",
      labels: ["daemon", "runtime"],
    });
    assert.equal(started.issue.status, "IN_PROGRESS");
    assert.equal(started.issue.assignee, "maya.markov@sentinelayer.local");
    assert.equal(started.transition.to, "IN_PROGRESS");
    assert.equal(started.comment.type, "plan");
    assert.equal(started.created, true);

    const assignment = await listAssignments({
      targetPath: tempRoot,
      workItemId,
      limit: 10,
    });
    assert.equal(assignment.visibleCount, 1);
    assert.equal(
      String(assignment.assignments[0].jiraIssueKey || "").startsWith("SL-"),
      true
    );

    const checkpoint = await commentJiraIssue({
      targetPath: tempRoot,
      workItemId,
      actor: "maya.markov@sentinelayer.local",
      type: "checkpoint",
      message: "Patch prepared and tests running.",
    });
    assert.equal(checkpoint.comment.type, "checkpoint");
    assert.equal(checkpoint.issue.comments.length >= 2, true);

    const transitioned = await transitionJiraIssue({
      targetPath: tempRoot,
      workItemId,
      toStatus: "DONE",
      actor: "maya.markov@sentinelayer.local",
      reason: "Fix merged and validated.",
    });
    assert.equal(transitioned.issue.status, "DONE");
    assert.equal(transitioned.transition.to, "DONE");

    const listedDone = await listJiraIssues({
      targetPath: tempRoot,
      statuses: ["DONE"],
      limit: 10,
    });
    assert.equal(listedDone.visibleCount, 1);
    assert.equal(listedDone.issues[0].workItemId, workItemId);
    assert.equal(listedDone.issues[0].status, "DONE");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon jira lifecycle: open reuses existing issue for same work item", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-jira-reuse-"));
  try {
    const workItemId = await seedWorkItem(tempRoot, "/v1/admin/error-log", "ERROR_STREAM_BACKPRESSURE");
    const first = await openJiraIssue({
      targetPath: tempRoot,
      workItemId,
      issueKeyPrefix: "SLD",
    });
    assert.equal(first.created, true);

    const second = await openJiraIssue({
      targetPath: tempRoot,
      workItemId,
      summary: "should not replace existing issue",
      issueKeyPrefix: "SLD",
    });
    assert.equal(second.created, false);
    assert.equal(second.issue.issueKey, first.issue.issueKey);

    const listed = await listJiraIssues({
      targetPath: tempRoot,
      workItemId,
    });
    assert.equal(listed.visibleCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
