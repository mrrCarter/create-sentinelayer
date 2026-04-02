import test from "node:test";
import assert from "node:assert/strict";

import { reconcileReviewFindings } from "../src/review/report.js";

test("Unit review report: reconcile deduplicates deterministic+AI overlaps and keeps highest severity", () => {
  const deterministicFindings = [
    {
      severity: "P2",
      file: "src/auth.js",
      line: 42,
      message: "Token exposed in logs",
      excerpt: "console.log(token)",
      ruleId: "SL-PAT-100",
      suggestedFix: "Redact secrets before logging.",
    },
  ];
  const aiFindings = [
    {
      severity: "P1",
      file: "src/auth.js",
      line: 42,
      message: "Token exposed in logs",
      excerpt: "JWT appears in logs",
      ruleId: "SL-AI-001",
      suggestedFix: "Strip token values from log payloads.",
      confidence: 0.77,
    },
  ];

  const reconciled = reconcileReviewFindings({
    deterministicFindings,
    aiFindings,
  });

  assert.equal(reconciled.findings.length, 1);
  assert.equal(reconciled.findings[0].severity, "P1");
  assert.deepEqual(reconciled.findings[0].sources, ["ai", "deterministic"]);
  assert.equal(reconciled.summary.P1, 1);
  assert.equal(reconciled.summary.blocking, true);
});

test("Unit review report: reconcile assigns stable IDs and severity summary", () => {
  const reconciled = reconcileReviewFindings({
    deterministicFindings: [
      { severity: "P2", file: "b.js", line: 1, message: "B issue" },
      { severity: "P1", file: "a.js", line: 2, message: "A issue" },
    ],
    aiFindings: [{ severity: "P3", file: "c.js", line: 3, message: "C issue", confidence: 0.5 }],
  });

  assert.equal(reconciled.findings.length, 3);
  assert.equal(reconciled.findings[0].findingId, "F-001");
  assert.equal(reconciled.findings[1].findingId, "F-002");
  assert.equal(reconciled.findings[2].findingId, "F-003");
  assert.equal(reconciled.summary.P1, 1);
  assert.equal(reconciled.summary.P2, 1);
  assert.equal(reconciled.summary.P3, 1);
  assert.equal(reconciled.summary.blocking, true);
});

