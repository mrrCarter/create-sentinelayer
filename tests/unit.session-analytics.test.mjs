import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { computeSessionAnalytics } from "../src/session/analytics.js";
import { createSession } from "../src/session/store.js";
import { appendToStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify(
      {
        name: "session-analytics-fixture",
        version: "1.0.0",
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const ok = true;\n", "utf-8");
}

test("Unit session analytics: computes full metrics bundle from stream + closeout artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-analytics-"));
  try {
    await seedWorkspace(tempRoot);
    const created = await createSession({ targetPath: tempRoot, ttlSeconds: 60 });
    const sessionId = created.sessionId;

    const events = [
      {
        event: "session_message",
        agentId: "codex-a1",
        payload: { message: "finding: [P1] lock collision in src/index.js" },
        ts: "2026-04-17T00:00:00.000Z",
      },
      {
        event: "session_message",
        agentId: "claude-b2",
        payload: { message: "ack, taking fix path" },
        ts: "2026-04-17T00:01:00.000Z",
      },
      {
        event: "daemon_alert",
        agentId: "senti",
        payload: { alert: "file_lock_denied" },
        ts: "2026-04-17T00:01:10.000Z",
      },
      {
        event: "file_lock",
        agentId: "codex-a1",
        payload: { file: "src/index.js" },
        ts: "2026-04-17T00:01:11.000Z",
      },
      {
        event: "task_assign",
        agentId: "codex-a1",
        payload: {
          taskId: "task-123",
          from: "codex-a1",
          to: "claude-b2",
          task: "patch lock race",
          priority: "P1",
        },
        ts: "2026-04-17T00:01:20.000Z",
      },
      {
        event: "task_completed",
        agentId: "claude-b2",
        payload: {
          taskId: "task-123",
          from: "codex-a1",
          to: "claude-b2",
          result: "done",
        },
        ts: "2026-04-17T00:01:40.000Z",
      },
      {
        event: "daemon_alert",
        agentId: "senti",
        payload: { alert: "stuck_recovered" },
        ts: "2026-04-17T00:01:50.000Z",
      },
      {
        event: "daemon_alert",
        agentId: "senti",
        payload: { alert: "stuck_detected" },
        ts: "2026-04-17T00:01:55.000Z",
      },
      {
        event: "model_span",
        agentId: "codex-a1",
        payload: { model: "gpt-5.4", costUsd: 1.5 },
        ts: "2026-04-17T00:02:00.000Z",
      },
      {
        event: "hitl_review",
        agentId: "senti",
        payload: { channel: "hitl", override: true, disagreement: true },
        ts: "2026-04-17T00:02:10.000Z",
      },
      {
        event: "eval_result",
        agentId: "senti",
        payload: { regression: true },
        ts: "2026-04-17T00:02:20.000Z",
      },
    ];

    for (const event of events) {
      await appendToStream(sessionId, event, { targetPath: tempRoot });
    }

    const observabilityDir = path.join(tempRoot, ".sentinelayer", "observability", "2026-04-17");
    const closeoutOneDir = path.join(observabilityDir, "work-item-1");
    const closeoutTwoDir = path.join(observabilityDir, "work-item-2");
    await mkdir(closeoutOneDir, { recursive: true });
    await mkdir(closeoutTwoDir, { recursive: true });
    await writeFile(
      path.join(closeoutOneDir, "closeout.json"),
      `${JSON.stringify(
        {
          sessionId,
          chainVerified: true,
          cosignAttestationRef: "sigstore://entry/123",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    await writeFile(
      path.join(closeoutTwoDir, "closeout.json"),
      `${JSON.stringify(
        {
          sessionId,
          chainVerified: false,
          cosignAttestationRef: "",
          sbomRef: "",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const metrics = await computeSessionAnalytics(sessionId, {
      targetPath: tempRoot,
      nowIso: "2026-04-17T01:00:00.000Z",
    });

    for (const requiredKey of [
      "totalMessages",
      "uniqueAgents",
      "totalFindings",
      "conflictsPrevented",
      "tasksAssigned",
      "tasksCompleted",
      "handoffsSuccessful",
      "avgResponseTimeMs",
      "stuckRecoveries",
      "totalCostUsd",
      "coordinationEfficiency",
      "elapsedHours",
      "renewalCount",
      "humanOverrideRate",
      "hitlDisagreementRate",
      "reproducibilitySuccessRate",
      "fixPlanUsefulnessScore",
      "evalRegressionRate",
      "provenanceAttestationCoverage",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(metrics, requiredKey), true, requiredKey);
    }

    assert.equal(metrics.totalMessages, 2);
    assert.equal(metrics.uniqueAgents, 3);
    assert.equal(metrics.totalFindings.P0, 0);
    assert.equal(metrics.totalFindings.P1, 1);
    assert.equal(metrics.totalFindings.P2, 0);
    assert.equal(metrics.totalFindings.P3, 0);
    assert.equal(metrics.conflictsPrevented, 2);
    assert.equal(metrics.tasksAssigned, 1);
    assert.equal(metrics.tasksCompleted, 1);
    assert.equal(metrics.handoffsSuccessful, 1);
    assert.equal(metrics.avgResponseTimeMs, 60_000);
    assert.equal(metrics.stuckRecoveries, 1);
    assert.equal(metrics.totalCostUsd, 1.5);
    assert.equal(metrics.coordinationEfficiency, 0.875);
    assert.equal(metrics.renewalCount, 0);
    assert.equal(metrics.humanOverrideRate, 1);
    assert.equal(metrics.hitlDisagreementRate, 1);
    assert.equal(metrics.reproducibilitySuccessRate, 0.5);
    assert.equal(metrics.fixPlanUsefulnessScore, 1);
    assert.equal(metrics.evalRegressionRate, 1);
    assert.equal(metrics.provenanceAttestationCoverage, 0.5);
    assert.equal(Number.isFinite(metrics.elapsedHours) && metrics.elapsedHours >= 0, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
