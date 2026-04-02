import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { buildSwarmExecutionPlan } from "../src/swarm/factory.js";
import { listBuiltinSwarmAgents } from "../src/swarm/registry.js";
import { runSwarmRuntime } from "../src/swarm/runtime.js";
import {
  loadSwarmDashboardSnapshot,
  renderSwarmDashboard,
  watchSwarmDashboard,
} from "../src/swarm/dashboard.js";

function pickAgents(ids = []) {
  const wanted = new Set(ids);
  return listBuiltinSwarmAgents().filter((agent) => wanted.has(agent.id));
}

test("Unit swarm dashboard: loads snapshot and renders agent rows", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-swarm-dashboard-"));
  try {
    const outputDir = path.join(tempRoot, ".sentinelayer");
    const plan = buildSwarmExecutionPlan({
      targetPath: tempRoot,
      agents: pickAgents(["omar", "security", "testing"]),
      scenario: "qa_audit",
      maxParallel: 2,
    });
    const runtime = await runSwarmRuntime({
      plan,
      targetPath: tempRoot,
      engine: "mock",
      execute: false,
      maxSteps: 20,
      outputDir,
      env: process.env,
    });

    const snapshot = await loadSwarmDashboardSnapshot({
      targetPath: tempRoot,
      outputDir,
      runId: runtime.runId,
      env: process.env,
    });
    assert.equal(snapshot.runId, runtime.runId);
    assert.equal(snapshot.completed, true);
    assert.equal(Array.isArray(snapshot.agentRows), true);
    assert.equal(snapshot.agentRows.some((row) => row.agentId === "omar"), true);

    const text = renderSwarmDashboard(snapshot);
    assert.match(text, /Swarm run:/);
    assert.match(text, /Agents:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit swarm dashboard: watch mode resolves completion and emits final snapshot", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-swarm-dashboard-"));
  try {
    const outputDir = path.join(tempRoot, ".sentinelayer");
    const plan = buildSwarmExecutionPlan({
      targetPath: tempRoot,
      agents: pickAgents(["omar", "security"]),
      scenario: "qa_audit",
      maxParallel: 1,
    });
    const runtime = await runSwarmRuntime({
      plan,
      targetPath: tempRoot,
      engine: "mock",
      execute: false,
      maxSteps: 20,
      outputDir,
      env: process.env,
    });

    const observed = [];
    const watchResult = await watchSwarmDashboard({
      targetPath: tempRoot,
      outputDir,
      runId: runtime.runId,
      pollSeconds: 0.2,
      maxIdleSeconds: 1,
      env: process.env,
      onSnapshot: async (snapshot) => {
        observed.push(snapshot.runId);
      },
    });
    assert.equal(watchResult.finalSnapshot.runId, runtime.runId);
    assert.equal(watchResult.finalSnapshot.completed, true);
    assert.equal(observed.length >= 1, true);
    assert.equal(watchResult.stopReason, "COMPLETED");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
