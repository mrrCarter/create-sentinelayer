import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { buildSwarmExecutionPlan } from "../src/swarm/factory.js";
import { listBuiltinSwarmAgents } from "../src/swarm/registry.js";
import { runSwarmRuntime } from "../src/swarm/runtime.js";

function pickAgents(ids = []) {
  const wanted = new Set(ids);
  return listBuiltinSwarmAgents().filter((agent) => wanted.has(agent.id));
}

test("Unit swarm runtime: mock runtime writes deterministic artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-swarm-runtime-"));
  try {
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
      outputDir: path.join(tempRoot, ".sentinelayer"),
      env: process.env,
    });

    assert.equal(runtime.completed, true);
    assert.equal(runtime.engine, "mock");
    assert.equal(runtime.stop.stopClass, "NONE");
    assert.match(String(runtime.runtimeJsonPath || ""), /[\\/]SWARM_RUNTIME\.json$/);
    assert.match(String(runtime.runtimeEventsPath || ""), /[\\/]events\.ndjson$/);

    const summary = JSON.parse(await readFile(runtime.runtimeJsonPath, "utf-8"));
    assert.equal(summary.runId, runtime.runId);
    assert.equal(summary.completed, true);

    const events = String(await readFile(runtime.runtimeEventsPath, "utf-8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events.length >= 2, true);
    assert.equal(events.some((event) => event.eventType === "run_start"), true);
    assert.equal(events.some((event) => event.eventType === "run_stop"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit swarm runtime: runtime stops when max-steps budget is exhausted", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-swarm-runtime-"));
  try {
    const plan = buildSwarmExecutionPlan({
      targetPath: tempRoot,
      agents: pickAgents(["omar", "security", "testing", "reliability"]),
      scenario: "error_event_remediation",
      maxParallel: 3,
    });

    const runtime = await runSwarmRuntime({
      plan,
      targetPath: tempRoot,
      engine: "mock",
      execute: false,
      maxSteps: 1,
      outputDir: path.join(tempRoot, ".sentinelayer"),
      env: process.env,
    });

    assert.equal(runtime.completed, false);
    assert.equal(runtime.stop.stopClass, "MAX_STEPS_EXCEEDED");
    assert.match(String(runtime.stop.reason || ""), /max-steps reached/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
