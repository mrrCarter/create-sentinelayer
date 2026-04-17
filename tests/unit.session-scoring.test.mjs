import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { createAgentEvent } from "../src/events/schema.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { buildAgentAnalyticsSnapshot, computeAgentScore, rankAgentsByScore } from "../src/session/scoring.js";
import { createSession } from "../src/session/store.js";
import { appendToStream } from "../src/session/stream.js";
import { acceptTask, assignTask, completeTask } from "../src/session/tasks.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-scoring-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const ready = true;\n", "utf-8");
}

test("Unit session scoring: computeAgentScore uses completion, reliability, and HITL accuracy metrics", () => {
  const score = computeAgentScore("coder-a1", {
    findings: 8,
    costUsd: 1,
    avgResponseTimeMs: 800,
    tasksAssigned: 6,
    tasksCompleted: 5,
    fileConflicts: 0,
    stuckDetections: 0,
    findingsConfirmed: 4,
    findingsTotal: 5,
  });

  assert.equal(score.agentId, "coder-a1");
  assert.equal(score.taskCompletionRate > 0.8, true);
  assert.equal(score.reviewAccuracy, 0.8);
  assert.equal(score.conflictsCreated, 0);
  assert.equal(score.stuckCount, 0);
  assert.equal(score.overallScore > 0.6, true);
});

test("Unit session scoring: analytics snapshot captures HITL adjudication truth signals", () => {
  const nowIso = new Date().toISOString();
  const events = [
    createAgentEvent({
      event: "session_message",
      agentId: "coder-a1",
      sessionId: "sess-demo",
      payload: {
        message: "finding: [P2] Auth route missing strict validation.",
      },
      ts: nowIso,
    }),
    createAgentEvent({
      event: "hitl_verdict_recorded",
      agentId: "lead-r1f2",
      sessionId: "sess-demo",
      payload: {
        channel: "hitl",
        reviewerId: "coder-a1",
        truth: true,
      },
      ts: new Date(Date.parse(nowIso) + 1000).toISOString(),
    }),
    createAgentEvent({
      event: "hitl_verdict_recorded",
      agentId: "lead-r1f2",
      sessionId: "sess-demo",
      payload: {
        channel: "hitl",
        reviewerId: "coder-a1",
        truth: false,
      },
      ts: new Date(Date.parse(nowIso) + 2000).toISOString(),
    }),
  ];

  const snapshot = buildAgentAnalyticsSnapshot({
    events,
    tasks: [],
    activeAssignments: [],
    nowIso,
  });
  assert.equal(snapshot["coder-a1"].findings, 1);
  assert.equal(snapshot["coder-a1"].findingsTotal, 2);
  assert.equal(snapshot["coder-a1"].findingsConfirmed, 1);
});

test("Unit session scoring: wildcard assignment routes to highest-scoring available agent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-scoring-route-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await registerAgent(session.sessionId, {
      agentId: "lead-r1f2",
      model: "gpt-5.4-mini",
      role: "reviewer",
      targetPath: tempRoot,
    });
    await registerAgent(session.sessionId, {
      agentId: "coder-a1",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await registerAgent(session.sessionId, {
      agentId: "coder-b2",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });

    const doneA = await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "coder-a1",
      task: "[P2] Patch auth null-guard regression",
      targetPath: tempRoot,
    });
    await acceptTask(session.sessionId, "coder-a1", doneA.task.taskId, {
      note: "starting now",
      targetPath: tempRoot,
    });
    await completeTask(session.sessionId, "coder-a1", doneA.task.taskId, {
      result: "patched and tested",
      targetPath: tempRoot,
    });

    await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "coder-b2",
      task: "[P2] Update stale docs for auth edge-case",
      targetPath: tempRoot,
    });

    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "hitl_verdict_recorded",
        agentId: "lead-r1f2",
        sessionId: session.sessionId,
        payload: {
          channel: "hitl",
          reviewerId: "coder-a1",
          truth: true,
        },
      }),
      { targetPath: tempRoot }
    );
    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "hitl_verdict_recorded",
        agentId: "lead-r1f2",
        sessionId: session.sessionId,
        payload: {
          channel: "hitl",
          reviewerId: "coder-b2",
          truth: false,
        },
      }),
      { targetPath: tempRoot }
    );

    await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "coder-a1",
      task: "[P2] Keep a queued follow-up for auth monitor",
      targetPath: tempRoot,
    });

    const wildcard = await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "*:coder",
      task: "[P2] Wildcard route: pick best coder by score",
      targetPath: tempRoot,
    });

    assert.equal(wildcard.task.toAgentId, "coder-a1");
    assert.equal(wildcard.routing.strategy, "score");
    assert.equal(typeof wildcard.routing.selectedScore, "number");
    assert.equal(String(wildcard.routing.scoreModelVersion || "").length > 0, true);
    assert.equal(Array.isArray(wildcard.routing.rankedCandidates), true);
    assert.equal(wildcard.routing.rankedCandidates[0].agentId, "coder-a1");
    const second = wildcard.routing.rankedCandidates.find((entry) => entry.agentId === "coder-b2");
    assert.ok(second);
    assert.equal(
      Number(wildcard.routing.rankedCandidates[0].overallScore) >= Number(second.overallScore),
      true
    );

    const ranked = rankAgentsByScore(
      [
        { agentId: "coder-a1", assignmentCount: 1, statusWeight: 2, activityEpoch: 1 },
        { agentId: "coder-b2", assignmentCount: 0, statusWeight: 2, activityEpoch: 2 },
      ],
      {
        "coder-a1": {
          findings: 0,
          costUsd: 0,
          avgResponseTimeMs: 250,
          tasksAssigned: 3,
          tasksCompleted: 2,
          fileConflicts: 0,
          stuckDetections: 0,
          findingsConfirmed: 1,
          findingsTotal: 1,
        },
        "coder-b2": {
          findings: 0,
          costUsd: 0,
          avgResponseTimeMs: 250,
          tasksAssigned: 3,
          tasksCompleted: 0,
          fileConflicts: 0,
          stuckDetections: 0,
          findingsConfirmed: 0,
          findingsTotal: 1,
        },
      }
    );
    assert.equal(ranked[0].agentId, "coder-a1");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

