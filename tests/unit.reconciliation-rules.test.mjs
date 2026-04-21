// Unit tests for the reconciliation ruleset (#investor-dd-29).

import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileFindingWithObservation,
  reconcileFindings,
  applyReportPolicy,
  RECONCILIATION_RULES,
  RECONCILIATION_RULESET_VERSION,
} from "../src/review/reconciliation-rules.js";

test("ruleset carries a version string", () => {
  assert.match(RECONCILIATION_RULESET_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(RECONCILIATION_RULES.length >= 10);
});

test("R01: broken-handler + clean live → FALSE_POSITIVE", () => {
  const finding = { kind: "frontend.broken-handler", evidence: "broken click handler" };
  const obs = { interactionId: "x", statusCodeObserved: 200, consoleErrors: [] };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "FALSE_POSITIVE");
  assert.equal(verdict.ruleId, "R01");
});

test("R02: broken-handler + matching console error → CONFIRMED", () => {
  const finding = {
    kind: "frontend.broken-handler",
    evidence: "handler threw TypeError undefined is not a function",
  };
  const obs = {
    interactionId: "x",
    consoleErrors: [
      { msg: "TypeError undefined is not a function" },
    ],
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONFIRMED");
  assert.equal(verdict.ruleId, "R02");
});

test("R03: authz bypass + sensitive 200 → CONFIRMED", () => {
  const finding = { kind: "authz.missing-guard", evidence: "missing auth on /users" };
  const obs = {
    interactionId: "x",
    statusCodeObserved: 200,
    observedBehavior: "Returned list of user emails and ssn",
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONFIRMED");
  assert.equal(verdict.ruleId, "R03");
});

test("R04: authz bypass + 401 → FALSE_POSITIVE", () => {
  const finding = { kind: "authz.missing-guard" };
  const obs = { interactionId: "x", statusCodeObserved: 401 };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "FALSE_POSITIVE");
  assert.equal(verdict.ruleId, "R04");
});

test("R05: XSS + payload executed → CONFIRMED", () => {
  const finding = { kind: "xss.reflected", evidence: "<script>alert(1)</script>" };
  const obs = {
    interactionId: "x",
    observedBehavior: "payload executed in DOM",
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONFIRMED");
  assert.equal(verdict.ruleId, "R05");
});

test("R06: unbounded fetch + large payload → CONFIRMED", () => {
  const finding = { kind: "perf.unbounded-fetch" };
  const obs = {
    interactionId: "x",
    payload: { bytes: 50 * 1024 * 1024 },
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONFIRMED");
  assert.equal(verdict.ruleId, "R06");
});

test("R07: missing idempotency + duplicate rows → CONFIRMED", () => {
  const finding = { kind: "idempotency.missing" };
  const obs = {
    interactionId: "x",
    payload: { rowsCreatedOnDoubleSubmit: 2 },
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONFIRMED");
  assert.equal(verdict.ruleId, "R07");
});

test("R08: CORS * → CONFIRMED", () => {
  const finding = { kind: "cors.too-permissive" };
  const obs = {
    interactionId: "x",
    payload: { headers: { "access-control-allow-origin": "*" } },
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONFIRMED");
  assert.equal(verdict.ruleId, "R08");
});

test("R10: rate-limit bypass + burst success → CONFIRMED", () => {
  const finding = { kind: "rate-limit.missing" };
  const obs = {
    interactionId: "x",
    payload: { burstResults: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200] },
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONFIRMED");
  assert.equal(verdict.ruleId, "R10");
});

test("R11: broken-handler + 200 + error toast → CONTRADICTORY", () => {
  const finding = { kind: "frontend.broken-handler" };
  const obs = {
    interactionId: "x",
    statusCodeObserved: 200,
    observedBehavior: "Request succeeded but UI showed error toast 'Operation Failed'",
  };
  const verdict = reconcileFindingWithObservation(finding, obs);
  assert.equal(verdict.verdict, "CONTRADICTORY");
  assert.equal(verdict.ruleId, "R11");
});

test("no rule match → UNVERIFIABLE", () => {
  const finding = { kind: "unknown.kind" };
  const verdict = reconcileFindingWithObservation(finding, null);
  assert.equal(verdict.verdict, "UNVERIFIABLE");
  assert.equal(verdict.ruleId, "R-NO-MATCH");
});

test("null finding → UNVERIFIABLE preflight", () => {
  const verdict = reconcileFindingWithObservation(null, {});
  assert.equal(verdict.verdict, "UNVERIFIABLE");
  assert.equal(verdict.ruleId, "R-PREFLIGHT");
});

test("rule that throws is skipped, not fatal", () => {
  const finding = { get kind() { throw new Error("nope"); } };
  // Should not throw; falls through to UNVERIFIABLE.
  const verdict = reconcileFindingWithObservation(finding, {});
  assert.equal(verdict.verdict, "UNVERIFIABLE");
});

test("reconcileFindings: batch pairing", () => {
  const findings = [
    { kind: "authz.missing-guard", file: "a.js", line: 1 },
    { kind: "unknown.kind", file: "b.js", line: 1 },
  ];
  const observations = new Map([
    ["a.js:1", { interactionId: "a", statusCodeObserved: 401 }],
  ]);
  const result = reconcileFindings(findings, (f) => observations.get(`${f.file}:${f.line}`) || null);
  assert.equal(result[0].reconciliation.verdict, "FALSE_POSITIVE");
  assert.equal(result[1].reconciliation.verdict, "UNVERIFIABLE");
});

test("applyReportPolicy: FALSE_POSITIVE suppressed by default", () => {
  const finding = { reconciliation: { verdict: "FALSE_POSITIVE" } };
  assert.equal(applyReportPolicy(finding), "suppress");
  assert.equal(applyReportPolicy(finding, { keepFalsePositivesForHitl: true }), "include-with-banner");
});

test("applyReportPolicy: CONTRADICTORY always includes-with-banner", () => {
  const finding = { reconciliation: { verdict: "CONTRADICTORY" } };
  assert.equal(applyReportPolicy(finding), "include-with-banner");
});

test("applyReportPolicy: CONFIRMED and UNVERIFIABLE include as-is", () => {
  assert.equal(applyReportPolicy({ reconciliation: { verdict: "CONFIRMED" } }), "include");
  assert.equal(applyReportPolicy({ reconciliation: { verdict: "UNVERIFIABLE" } }), "include");
});
