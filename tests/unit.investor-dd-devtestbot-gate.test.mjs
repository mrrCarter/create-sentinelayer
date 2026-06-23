import test from "node:test";
import assert from "node:assert/strict";

import { callPlannerClient } from "../src/review/investor-dd-devtestbot.js";

const SESSION_USAGE = Object.freeze({
  sessionId: "sess-dd",
  agentId: "investor-dd",
  model: "test-model",
  provider: "sentinelayer",
  recorder: async () => ({ ok: true, ledgerEntry: { ledgerEntryId: "ledger-dd" } }),
});

function assertGateMetadata(captured) {
  assert.equal(captured.action, "investor_dd_devtestbot_planner");
  assert.equal(captured.sessionId, "sess-dd");
  assert.equal(captured.agentId, "investor-dd-devtestbot-planner");
  assert.equal(
    typeof captured.usageIdempotencyKey === "string" &&
      captured.usageIdempotencyKey.startsWith("investor-dd-devtestbot-"),
    true,
    "usageIdempotencyKey is set and namespaced",
  );
  assert.ok(captured.metadata, "metadata is present");
  assert.equal(captured.metadata.phase, "devtestbot");
  assert.equal(
    typeof captured.metadata.repoKey === "string" && captured.metadata.repoKey.length > 0,
    true,
    "metadata.repoKey is a non-empty stable key",
  );
  assert.equal(captured.metadata.repoKey.includes("\\"), false, "repoKey does not leak a Windows path");
  assert.equal(/^[A-Za-z]:/.test(captured.metadata.repoKey), false, "repoKey does not leak a drive path");
}

// #94651 CLI hint: no-session planner callers must stay status quo. API-side
// DD actions are fail-closed and reject incomplete session usage context.
test("Unit investor-dd devtestbot: no-session planner call does not emit DD gate action", async () => {
  let captured = null;
  const plannerClient = {
    invoke: async (args) => {
      captured = args;
      return {
        text: "{}",
        model: "test-model",
        provider: "sentinelayer",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  await callPlannerClient({
    plannerClient,
    rootPath: process.cwd(),
    files: [],
    findings: [],
    budget: { maxUsd: 1 },
    sessionUsage: null,
  });

  assert.ok(captured, "plannerClient.invoke was called");
  assert.equal(captured.action, undefined);
  assert.equal(captured.sessionId, undefined);
  assert.equal(captured.agentId, undefined);
  assert.equal(captured.usageIdempotencyKey, undefined);
  assert.equal(captured.metadata, undefined);
});

// The investor-dd devtestbot planner is the only DD managed-proxy LLM call.
// When attached to a Senti usage session, its proxy request must carry the
// entitlement-gate metadata so the API gate can authorize_run before spend.
test("Unit investor-dd devtestbot: planner proxy call carries DD entitlement gate metadata", async () => {
  let captured = null;
  const plannerClient = {
    invoke: async (args) => {
      captured = args;
      return {
        text: "{}",
        model: "test-model",
        provider: "sentinelayer",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  await callPlannerClient({
    plannerClient,
    rootPath: process.cwd(),
    files: [],
    findings: [],
    budget: { maxUsd: 1 },
    sessionUsage: SESSION_USAGE,
  });

  assert.ok(captured, "plannerClient.invoke was called");
  assertGateMetadata(captured);
});

// The generatePlan fallback path must carry the same gate metadata in its options.
test("Unit investor-dd devtestbot: generatePlan fallback also carries gate metadata", async () => {
  let captured = null;
  const plannerClient = {
    generatePlan: async (_messages, options) => {
      captured = options;
      return {
        text: "{}",
        model: "test-model",
        provider: "sentinelayer",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  await callPlannerClient({
    plannerClient,
    rootPath: process.cwd(),
    files: [],
    findings: [],
    budget: { maxUsd: 1 },
    sessionUsage: SESSION_USAGE,
  });

  assert.ok(captured, "plannerClient.generatePlan was called");
  assertGateMetadata(captured);
});
