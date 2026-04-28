import test from "node:test";
import assert from "node:assert/strict";

import { dropBelowConfidence, reconcileReviewFindings } from "../src/review/report.js";

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
      confidence: 0.42,
      persona: "security",
    },
  ];

  const reconciled = reconcileReviewFindings({
    deterministicFindings,
    aiFindings,
    confidenceFloors: { security: 0.85 },
  });

  assert.equal(reconciled.findings.length, 1);
  assert.equal(reconciled.findings[0].severity, "P1");
  assert.deepEqual(reconciled.findings[0].sources, ["ai", "deterministic"]);
  assert.deepEqual(reconciled.findings[0].confirmationSources, ["ai:security", "deterministic"]);
  assert.equal(reconciled.summary.P1, 1);
  assert.equal(reconciled.summary.blocking, true);
  assert.equal(reconciled.summary.droppedBelowConfidence, 0);
});

test("Unit review report: reconcile assigns stable IDs and severity summary", () => {
  const reconciled = reconcileReviewFindings({
    deterministicFindings: [
      { severity: "P2", file: "b.js", line: 1, message: "B issue" },
      { severity: "P1", file: "a.js", line: 2, message: "A issue" },
    ],
    aiFindings: [{ severity: "P3", file: "c.js", line: 3, message: "C issue", confidence: 0.75 }],
  });

  assert.equal(reconciled.findings.length, 3);
  assert.equal(reconciled.findings[0].findingId, "F-001");
  assert.equal(reconciled.findings[1].findingId, "F-002");
  assert.equal(reconciled.findings[2].findingId, "F-003");
  assert.equal(reconciled.summary.P1, 1);
  assert.equal(reconciled.summary.P2, 1);
  assert.equal(reconciled.summary.P3, 1);
  assert.equal(reconciled.summary.blocking, true);
  assert.equal(reconciled.summary.droppedBelowConfidence, 0);
});

test("Unit review report: reconcile drops low-confidence single-source AI findings", () => {
  const aiFindings = Array.from({ length: 5 }, (_, index) => ({
    severity: "P2",
    file: `src/low-${index}.js`,
    line: index + 1,
    message: `Low confidence issue ${index}`,
    confidence: 0.42,
  }));

  const reconciled = reconcileReviewFindings({
    aiFindings,
  });

  assert.equal(reconciled.findings.length, 0);
  assert.equal(reconciled.droppedFindings.length, 5);
  assert.equal(reconciled.summary.P0, 0);
  assert.equal(reconciled.summary.P1, 0);
  assert.equal(reconciled.summary.P2, 0);
  assert.equal(reconciled.summary.P3, 0);
  assert.equal(reconciled.summary.droppedBelowConfidence, 5);
  assert.equal(reconciled.summary.droppedBelowConfidenceSingleSource, 5);
});

test("Unit review report: confidence floor keeps low-confidence multi-source findings", () => {
  const reconciled = reconcileReviewFindings({
    deterministicFindings: [
      {
        severity: "P2",
        file: "src/auth.js",
        line: 12,
        message: "Session token leaks to logs",
      },
    ],
    aiFindings: [
      {
        severity: "P2",
        file: "src/auth.js",
        line: 12,
        message: "Session token leaks to logs",
        confidence: 0.41,
      },
    ],
  });

  assert.equal(reconciled.findings.length, 1);
  assert.deepEqual(reconciled.findings[0].sources, ["ai", "deterministic"]);
  assert.equal(reconciled.findings[0].confidence, 1);
  assert.equal(reconciled.summary.droppedBelowConfidence, 0);
});

test("Unit review report: confidence floor keeps findings confirmed by two AI personas", () => {
  const reconciled = reconcileReviewFindings({
    aiFindings: [
      {
        severity: "P2",
        file: "src/session.js",
        line: 44,
        message: "Session stream can miss events",
        confidence: 0.41,
        persona: "reliability",
      },
      {
        severity: "P2",
        file: "src/session.js",
        line: 44,
        message: "Session stream can miss events",
        confidence: 0.39,
        persona: "observability",
      },
    ],
    confidenceFloors: {
      reliability: 0.78,
      observability: 0.75,
    },
  });

  assert.equal(reconciled.findings.length, 1);
  assert.deepEqual(reconciled.findings[0].sources, ["ai"]);
  assert.deepEqual(reconciled.findings[0].confirmationSources, [
    "ai:observability",
    "ai:reliability",
  ]);
  assert.equal(reconciled.summary.droppedBelowConfidence, 0);
});

test("Unit review report: dropBelowConfidence supports per-finding floor overrides", () => {
  const filtered = dropBelowConfidence([
    {
      severity: "P3",
      file: "src/a.js",
      line: 1,
      message: "High custom floor issue",
      confidence: 0.75,
      confidenceFloor: 0.8,
      sources: ["ai"],
    },
    {
      severity: "P3",
      file: "src/b.js",
      line: 1,
      message: "Low custom floor issue",
      confidence: 0.65,
      confidenceFloor: 0.6,
      sources: ["ai"],
    },
  ]);

  assert.equal(filtered.findings.length, 1);
  assert.equal(filtered.findings[0].file, "src/b.js");
  assert.equal(filtered.dropped.length, 1);
  assert.equal(filtered.dropped[0].droppedReason, "below_confidence_floor_single_source");
});

