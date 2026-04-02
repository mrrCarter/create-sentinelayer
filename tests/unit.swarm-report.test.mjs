import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { buildSwarmExecutionPlan } from "../src/swarm/factory.js";
import { listBuiltinSwarmAgents } from "../src/swarm/registry.js";
import { runSwarmRuntime } from "../src/swarm/runtime.js";
import { buildSwarmExecutionReport } from "../src/swarm/report.js";

function pickAgents(ids = []) {
  const wanted = new Set(ids);
  return listBuiltinSwarmAgents().filter((agent) => wanted.has(agent.id));
}

test("Unit swarm report: builds deterministic execution report from runtime artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-swarm-report-"));
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
    const report = await buildSwarmExecutionReport({
      targetPath: tempRoot,
      outputDir,
      runId: runtime.runId,
      env: process.env,
    });

    assert.equal(report.runtimeRunId, runtime.runId);
    assert.equal(report.completed, true);
    assert.match(String(report.reportJsonPath || ""), /[\\/]SWARM_EXECUTION_REPORT\.json$/);
    assert.match(String(report.reportMarkdownPath || ""), /[\\/]SWARM_EXECUTION_REPORT\.md$/);
    assert.equal(Array.isArray(report.agentRows), true);
    assert.equal(report.agentRows.some((row) => row.agentId === "omar"), true);

    const saved = JSON.parse(await readFile(report.reportJsonPath, "utf-8"));
    assert.equal(saved.runtimeRunId, runtime.runId);
    assert.equal(saved.agentSummary.completed >= 1, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
