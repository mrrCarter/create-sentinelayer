import test from "node:test";
import assert from "node:assert/strict";

import {
  renderSecuritySpecialistMarkdown,
  runSecuritySpecialist,
} from "../src/audit/agents/security.js";

test("Unit audit security: specialist report computes severity summary and scenarios", () => {
  const report = runSecuritySpecialist({
    findings: [
      {
        severity: "P1",
        file: "src/auth.js",
        line: 22,
        message: "Possible provider API key detected.",
        ruleId: "SL-SEC-004",
        suggestedFix: "Rotate keys and use secret manager.",
      },
      {
        severity: "P2",
        file: "src/db.js",
        line: 41,
        message: "Potential SQL string interpolation detected.",
        ruleId: "SL-PAT-005",
        suggestedFix: "Use parameterized queries.",
      },
    ],
  });

  assert.equal(report.summary.P1, 1);
  assert.equal(report.summary.P2, 1);
  assert.equal(report.summary.blocking, true);
  assert.equal(report.summary.findingCount, 2);
  assert.equal(report.exploitScenarios.length >= 2, true);
  assert.equal(report.categories.length >= 1, true);
  assert.equal(report.summary.riskScore >= 10, true);
});

test("Unit audit security: markdown renderer emits structured specialist report", () => {
  const report = runSecuritySpecialist({
    findings: [
      {
        severity: "P2",
        file: "src/release.yml",
        line: 12,
        message: "Release workflow uses floating action tags",
        ruleId: "SL-REL-001",
      },
    ],
  });

  const markdown = renderSecuritySpecialistMarkdown(report);
  assert.match(markdown, /SECURITY_AGENT_REPORT/);
  assert.match(markdown, /Risk score:/);
  assert.match(markdown, /Exploit scenarios:/);
  assert.match(markdown, /Recommended actions:/);
});
