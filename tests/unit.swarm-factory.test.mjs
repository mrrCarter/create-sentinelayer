import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { buildSwarmExecutionPlan, writeSwarmPlanArtifacts } from "../src/swarm/factory.js";
import { listBuiltinSwarmAgents } from "../src/swarm/registry.js";

function pickAgents(ids = []) {
  const wanted = new Set(ids);
  return listBuiltinSwarmAgents().filter((agent) => wanted.has(agent.id));
}

test("Unit swarm factory: builds OMAR-led execution plan with phased graph", () => {
  const agents = pickAgents(["omar", "security", "testing", "reliability"]);
  const plan = buildSwarmExecutionPlan({
    targetPath: ".",
    scenario: "error_event_remediation",
    objective: "Route error findings and produce deterministic remediation handoffs.",
    agents,
    maxParallel: 3,
    globalBudget: {
      maxCostUsd: 3,
      maxOutputTokens: 12000,
      maxRuntimeMs: 1800000,
      maxToolCalls: 200,
      warningThresholdPercent: 75,
    },
  });

  assert.ok(String(plan.runId || "").startsWith("swarm-"));
  assert.equal(plan.selectedAgents[0], "omar");
  assert.equal(plan.assignments[0].agentId, "omar");
  assert.equal(plan.executionGraph.phases.length, 3);
  assert.equal(plan.executionGraph.phases[0].agentIds.includes("omar"), true);
  assert.equal(plan.summary.orchestratorCount, 1);
  assert.equal(plan.summary.specialistCount, 3);
  assert.equal(plan.maxParallel, 3);
  assert.equal(plan.globalBudget.warningThresholdPercent, 75);
});

test("Unit swarm factory: builds OMAR-led devTestBot execution plan", () => {
  const agents = pickAgents(["omar", "devtestbot"]);
  const plan = buildSwarmExecutionPlan({
    targetPath: ".",
    scenario: "smoke",
    objective: "Run devTestBot smoke browser evidence collection.",
    agents,
    maxParallel: 1,
  });

  assert.equal(plan.selectedAgents[0], "omar");
  assert.equal(plan.selectedAgents.includes("devtestbot"), true);
  assert.equal(plan.assignments.some((assignment) => assignment.agentId === "devtestbot"), true);
  const devTestBot = plan.assignments.find((assignment) => assignment.agentId === "devtestbot");
  assert.equal(devTestBot.constraints.networkMode, "enabled");
  assert.equal(devTestBot.constraints.permissionMode, "runtime-readonly");
  assert.equal(devTestBot.handoff.downstreamAgentIds.includes("omar"), true);
});

test("Unit swarm factory: writes deterministic plan artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-swarm-plan-"));
  try {
    const plan = buildSwarmExecutionPlan({
      targetPath: tempRoot,
      agents: pickAgents(["omar", "security", "testing"]),
      scenario: "qa_audit",
      maxParallel: 2,
    });

    const artifacts = await writeSwarmPlanArtifacts({
      plan,
      outputDir: path.join(tempRoot, ".sentinelayer"),
      env: process.env,
    });

    assert.match(String(artifacts.planJsonPath || ""), /[\\/]SWARM_PLAN\.json$/);
    assert.match(String(artifacts.planMarkdownPath || ""), /[\\/]SWARM_PLAN\.md$/);

    const json = JSON.parse(await readFile(artifacts.planJsonPath, "utf-8"));
    const markdown = await readFile(artifacts.planMarkdownPath, "utf-8");
    assert.equal(json.runId, plan.runId);
    assert.equal(Array.isArray(json.assignments), true);
    assert.equal(json.assignments.some((assignment) => assignment.agentId === "omar"), true);
    assert.match(markdown, /SWARM_PLAN/);
    assert.match(markdown, /Assignments:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
