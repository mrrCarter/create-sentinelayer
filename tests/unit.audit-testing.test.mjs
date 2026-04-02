import test from "node:test";
import assert from "node:assert/strict";

import {
  renderTestingSpecialistMarkdown,
  runTestingSpecialist,
} from "../src/audit/agents/testing.js";

test("Unit audit testing: specialist report derives coverage inventory and findings", () => {
  const report = runTestingSpecialist({
    findings: [
      {
        severity: "P2",
        file: "src/service/order.js",
        line: 33,
        message: "Coverage gap detected for integration path.",
        ruleId: "SL-TST-017",
      },
    ],
    ingest: {
      indexedFiles: {
        files: [
          { path: "src/service/order.js", language: "javascript", loc: 640, sizeBytes: 10000 },
          { path: "src/service/order-helper.js", language: "javascript", loc: 300, sizeBytes: 4000 },
          { path: "tests/order.test.js", language: "javascript", loc: 80, sizeBytes: 1400 },
        ],
      },
    },
  });

  assert.equal(report.summary.findingCount >= 1, true);
  assert.equal(report.coverageInventory.codeFileCount >= 2, true);
  assert.equal(report.coverageInventory.testFileCount >= 1, true);
  assert.equal(report.summary.testingScore <= 100, true);
  assert.equal(Array.isArray(report.recommendations), true);
});

test("Unit audit testing: markdown renderer emits specialist sections", () => {
  const report = runTestingSpecialist({
    findings: [],
    ingest: {
      indexedFiles: {
        files: [{ path: "src/app.js", language: "javascript", loc: 280, sizeBytes: 2000 }],
      },
    },
  });

  const markdown = renderTestingSpecialistMarkdown(report);
  assert.match(markdown, /TESTING_AGENT_REPORT/);
  assert.match(markdown, /Testing score:/);
  assert.match(markdown, /Coverage inventory:/);
  assert.match(markdown, /Recommendations:/);
});
