import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { validateAgentEvent } from "../src/events/schema.js";
import {
  createRuntimeRun,
  heartbeatRuntimeRun,
  stopRuntimeRun,
  validateBudgetEnvelope,
  validateScopeEnvelope,
} from "../src/session/runtime-bridge.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "runtime-bridge-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

function buildScopeEnvelope() {
  return {
    allowed_tools: ["file_read", "grep"],
    allowed_paths: ["src/**"],
    denied_paths: ["secrets/**"],
  };
}

function buildBudgetEnvelope() {
  return {
    max_tokens: 100,
    max_cost_usd: 1,
    max_runtime_minutes: 10,
    max_tool_calls: 50,
    network_domain_allowlist: ["api.sentinelayer.com", "*.sentinelayer.com"],
  };
}

test("Unit session runtime bridge: validates scope + budget contract envelopes", async () => {
  assert.equal(validateScopeEnvelope(buildScopeEnvelope()), true);
  assert.equal(validateBudgetEnvelope(buildBudgetEnvelope()), true);
  assert.equal(validateScopeEnvelope({ allowed_paths: ["src/**"] }), false);
  assert.equal(validateBudgetEnvelope({ max_tokens: 10, max_cost_usd: 0 }), false);
});

test("Unit session runtime bridge: denied path access triggers blocked_by_policy stop class", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-runtime-path-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const run = await createRuntimeRun({
      sessionId: session.sessionId,
      workItemId: "work-path-1",
      targetPath: tempRoot,
      scopeEnvelope: buildScopeEnvelope(),
      budgetEnvelope: buildBudgetEnvelope(),
    });
    assert.equal(run.running, true);

    const heartbeat = await heartbeatRuntimeRun(session.sessionId, run.runId, {
      targetPath: tempRoot,
      pathAccesses: ["secrets/keys.env"],
      usage: {
        tokensUsed: 4,
        toolCalls: 1,
      },
    });
    assert.equal(heartbeat.running, false);
    assert.equal(heartbeat.stopClass, "blocked_by_policy");
    assert.equal(heartbeat.stopCode, "PATH_OUT_OF_SCOPE");
    assert.equal(heartbeat.usage.pathOutOfScopeHits >= 1, true);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const stopEvent = stream.find(
      (event) => event.event === "runtime_run_stop" && event.payload.runId === run.runId
    );
    assert.ok(stopEvent);
    assert.equal(stopEvent.payload.stopClass, "blocked_by_policy");
    assert.equal(stopEvent.payload.stopCode, "PATH_OUT_OF_SCOPE");
    assert.equal(validateAgentEvent(stopEvent, { allowLegacy: false }), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session runtime bridge: token ceiling stop class is budget_exhausted", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-runtime-token-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const run = await createRuntimeRun({
      sessionId: session.sessionId,
      workItemId: "work-token-1",
      targetPath: tempRoot,
      scopeEnvelope: buildScopeEnvelope(),
      budgetEnvelope: {
        ...buildBudgetEnvelope(),
        max_tokens: 5,
      },
    });
    assert.equal(run.running, true);

    const heartbeat = await heartbeatRuntimeRun(session.sessionId, run.runId, {
      targetPath: tempRoot,
      usage: {
        tokensUsed: 6,
        toolCalls: 1,
      },
    });
    assert.equal(heartbeat.running, false);
    assert.equal(heartbeat.stopClass, "budget_exhausted");
    assert.equal(heartbeat.stopCode, "MAX_TOKENS_EXCEEDED");

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const startedEvent = stream.find(
      (event) => event.event === "runtime_run_started" && event.payload.runId === run.runId
    );
    const stopEvent = stream.find(
      (event) => event.event === "runtime_run_stop" && event.payload.runId === run.runId
    );
    assert.ok(startedEvent);
    assert.ok(stopEvent);
    assert.equal(validateAgentEvent(startedEvent, { allowLegacy: false }), true);
    assert.equal(validateAgentEvent(stopEvent, { allowLegacy: false }), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session runtime bridge: explicit stop emits manual_stop", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-runtime-stop-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const run = await createRuntimeRun({
      sessionId: session.sessionId,
      workItemId: "work-stop-1",
      targetPath: tempRoot,
      scopeEnvelope: buildScopeEnvelope(),
      budgetEnvelope: buildBudgetEnvelope(),
    });
    const stopped = await stopRuntimeRun(session.sessionId, run.runId, {
      targetPath: tempRoot,
      reason: "operator_kill",
    });
    assert.equal(stopped.running, false);
    assert.equal(stopped.stopClass, "manual_stop");
    assert.equal(stopped.stopCode, "MANUAL_STOP");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
