import test from "node:test";
import assert from "node:assert/strict";

import { callPlannerClient } from "../src/review/investor-dd-devtestbot.js";

// #94651 CLI hint: the investor-dd devtestbot planner is the only DD managed-proxy
// LLM call. Its proxy request must carry the entitlement-gate metadata (action +
// repoKey + idempotency + agentId) so the API gate can authorize_run before spend.
test("Unit investor-dd devtestbot: planner proxy call carries DD entitlement gate metadata", async () => {
  let captured = null;
  const plannerClient = {
    invoke: async (args) => {
      captured = args;
      return { text: "{}", model: "test-model", provider: "sentinelayer" };
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
  assert.equal(captured.action, "investor_dd_devtestbot_planner");
  assert.equal(captured.agentId, "investor-dd-devtestbot-planner");
  assert.equal(
    typeof captured.usageIdempotencyKey === "string" &&
      captured.usageIdempotencyKey.startsWith("investor-dd-devtestbot-"),
    true,
    "usageIdempotencyKey is set and namespaced",
  );
  assert.ok(captured.metadata, "metadata is present");
  assert.equal(
    typeof captured.metadata.repoKey === "string" && captured.metadata.repoKey.length > 0,
    true,
    "metadata.repoKey is a non-empty stable key",
  );
});

// The generatePlan fallback path must carry the same gate metadata in its options.
test("Unit investor-dd devtestbot: generatePlan fallback also carries gate metadata", async () => {
  let captured = null;
  const plannerClient = {
    generatePlan: async (_messages, options) => {
      captured = options;
      return { text: "{}", model: "test-model", provider: "sentinelayer" };
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

  assert.ok(captured, "plannerClient.generatePlan was called");
  assert.equal(captured.action, "investor_dd_devtestbot_planner");
  assert.equal(captured.agentId, "investor-dd-devtestbot-planner");
  assert.ok(captured.metadata && captured.metadata.repoKey, "metadata.repoKey present on generatePlan path");
});
