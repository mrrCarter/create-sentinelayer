import test from "node:test";
import assert from "node:assert/strict";

import {
  SENTINELAYER_ACTION_REF,
  buildSecurityReviewWorkflow,
} from "../src/scan/generator.js";
import { resolveScanMode } from "../src/review/scan-modes.js";

const EXPECTED_DEEP_PERSONAS = [
  "security",
  "architecture",
  "testing",
  "performance",
  "compliance",
  "reliability",
];

const EXPECTED_FULL_DEPTH_PERSONAS = [
  "security",
  "architecture",
  "testing",
  "performance",
  "compliance",
  "reliability",
  "release",
  "observability",
  "infrastructure",
  "supply-chain",
  "frontend",
  "documentation",
  "ai-governance",
];

test("Unit scan parity: generated workflow uses v1-action contract modes and pinned ref", () => {
  const workflow = buildSecurityReviewWorkflow({
    profile: {
      scanMode: "baseline",
      severityGate: "P1",
      playwrightMode: "off",
      sbomMode: "off",
    },
  });

  assert.match(workflow, /scan_mode:/);
  assert.match(workflow, /- baseline/);
  assert.match(workflow, /- deep/);
  assert.match(workflow, /- audit/);
  assert.match(workflow, /- full-depth/);
  assert.match(workflow, new RegExp(`uses: ${SENTINELAYER_ACTION_REF}`));
});

test("Unit scan parity: local baseline/deep/full-depth persona contracts are stable", () => {
  const baseline = resolveScanMode("baseline");
  const deep = resolveScanMode("deep");
  const fullDepth = resolveScanMode("full-depth");

  assert.equal(baseline.mode, "baseline");
  assert.deepEqual(baseline.personas, ["security"]);

  assert.equal(deep.mode, "deep");
  assert.deepEqual(deep.personas, EXPECTED_DEEP_PERSONAS);
  assert.equal(deep.personas.length, 6);

  assert.equal(fullDepth.mode, "full-depth");
  assert.deepEqual(fullDepth.personas, EXPECTED_FULL_DEPTH_PERSONAS);
  assert.equal(fullDepth.personas.length, 13);
});

test("Unit scan parity: local audit mode is alias of full-depth", () => {
  const audit = resolveScanMode("audit");
  const fullDepth = resolveScanMode("full-depth");

  assert.equal(audit.mode, "audit");
  assert.deepEqual(audit.personas, fullDepth.personas);
});
