// Scaffold test — asserts the investor-dd budget resolver enforces
// documented defaults + respects caller overrides. Expanded as later
// PRs add the per-file loop, routing engine, compliance pack.

import test from "node:test";
import assert from "node:assert/strict";

import {
  INVESTOR_DD_COMMAND_TOKEN,
  INVESTOR_DD_DEFAULT_MAX_COST_USD,
  INVESTOR_DD_DEFAULT_MAX_PARALLEL,
  INVESTOR_DD_DEFAULT_MAX_RUNTIME_MINUTES,
  INVESTOR_DD_SUPPORTED_COMPLIANCE_PACKS,
  INVESTOR_DD_VERSION,
  resolveInvestorDdBudget,
} from "../src/review/investor-dd-config.js";

test("investor-dd: defaults match architecture doc", () => {
  assert.equal(INVESTOR_DD_DEFAULT_MAX_COST_USD, 25.0);
  assert.equal(INVESTOR_DD_DEFAULT_MAX_RUNTIME_MINUTES, 45);
  assert.equal(INVESTOR_DD_DEFAULT_MAX_PARALLEL, 3);
  assert.equal(INVESTOR_DD_COMMAND_TOKEN, "investor-dd");
  assert.equal(INVESTOR_DD_VERSION, "1.0.0");
});

test("investor-dd: compliance pack catalog includes SOC 2 + ISO 27001 + GDPR + HIPAA + license + DR", () => {
  const expected = new Set([
    "soc2",
    "iso27001",
    "gdpr",
    "ccpa",
    "hipaa",
    "license",
    "dr",
  ]);
  assert.deepEqual(
    new Set(INVESTOR_DD_SUPPORTED_COMPLIANCE_PACKS),
    expected,
    "compliance pack list must match what an acquirer audit expects"
  );
});

test("resolveInvestorDdBudget: returns defaults when caller passes nothing", () => {
  const budget = resolveInvestorDdBudget({});
  assert.equal(budget.maxCostUsd, INVESTOR_DD_DEFAULT_MAX_COST_USD);
  assert.equal(budget.maxRuntimeMinutes, INVESTOR_DD_DEFAULT_MAX_RUNTIME_MINUTES);
  assert.equal(budget.maxParallel, INVESTOR_DD_DEFAULT_MAX_PARALLEL);
});

test("resolveInvestorDdBudget: caller overrides beat defaults", () => {
  const budget = resolveInvestorDdBudget({
    maxCostUsd: 50,
    maxRuntimeMinutes: 90,
    maxParallel: 6,
  });
  assert.equal(budget.maxCostUsd, 50);
  assert.equal(budget.maxRuntimeMinutes, 90);
  assert.equal(budget.maxParallel, 6);
});

test("resolveInvestorDdBudget: rejects non-positive values in favor of defaults", () => {
  const budget = resolveInvestorDdBudget({
    maxCostUsd: 0,
    maxRuntimeMinutes: -10,
    maxParallel: "not-a-number",
  });
  assert.equal(budget.maxCostUsd, INVESTOR_DD_DEFAULT_MAX_COST_USD);
  assert.equal(budget.maxRuntimeMinutes, INVESTOR_DD_DEFAULT_MAX_RUNTIME_MINUTES);
  assert.equal(budget.maxParallel, INVESTOR_DD_DEFAULT_MAX_PARALLEL);
});

test("resolveInvestorDdBudget: floors fractional parallel + minutes", () => {
  const budget = resolveInvestorDdBudget({
    maxRuntimeMinutes: 30.8,
    maxParallel: 2.9,
  });
  assert.equal(budget.maxRuntimeMinutes, 30);
  assert.equal(budget.maxParallel, 2);
});
