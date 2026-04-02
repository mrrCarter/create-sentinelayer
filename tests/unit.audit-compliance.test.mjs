import test from "node:test";
import assert from "node:assert/strict";

import {
  renderComplianceSpecialistMarkdown,
  runComplianceSpecialist,
} from "../src/audit/agents/compliance.js";

test("Unit audit compliance: specialist report maps findings to controls", () => {
  const report = runComplianceSpecialist({
    findings: [
      {
        severity: "P1",
        file: "src/auth/session.js",
        line: 30,
        message: "Session token appears without clear rotation control.",
        ruleId: "SL-SEC-004",
      },
    ],
    ingest: {
      riskSurfaces: [{ surface: "secrets", filePath: "src/auth/session.js" }],
    },
  });

  assert.equal(report.summary.findingCount >= 1, true);
  assert.equal(Array.isArray(report.controlSummary), true);
  assert.equal(report.controlSummary.length >= 1, true);
  assert.equal(report.summary.complianceScore <= 100, true);
});

test("Unit audit compliance: markdown renderer emits specialist sections", () => {
  const report = runComplianceSpecialist({
    findings: [],
    ingest: { riskSurfaces: [] },
  });

  const markdown = renderComplianceSpecialistMarkdown(report);
  assert.match(markdown, /COMPLIANCE_AGENT_REPORT/);
  assert.match(markdown, /Compliance score:/);
  assert.match(markdown, /Control mapping:/);
  assert.match(markdown, /Recommendations:/);
});
