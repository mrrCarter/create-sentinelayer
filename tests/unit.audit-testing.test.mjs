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

test("Unit audit testing: coverage gaps ignore support artifacts and stay non-blocking", () => {
  const report = runTestingSpecialist({
    findings: [],
    ingest: {
      indexedFiles: {
        files: [
          { path: "tests/service.test.mjs", language: "javascript", loc: 1200, sizeBytes: 12000 },
          { path: "tasks/test-plan.md", language: "markdown", loc: 900, sizeBytes: 10000 },
          { path: ".github/workflows/test.yml", language: "yaml", loc: 800, sizeBytes: 9000 },
          { path: "src/generated/types.ts", language: "typescript", loc: 1000, sizeBytes: 10000 },
          { path: "yarn.lock", language: "text", loc: 3000, sizeBytes: 120000 },
          { path: "src/service/order.js", language: "javascript", loc: 700, sizeBytes: 11000 },
        ],
      },
    },
  });

  assert.equal(report.coverageInventory.codeFileCount, 1);
  assert.equal(report.coverageInventory.testFileCount, 1);
  assert.deepEqual(
    report.coverageInventory.likelyGaps.map((item) => item.path),
    ["src/service/order.js"]
  );
  assert.equal(report.summary.P1, 0);
  assert.equal(report.summary.P2, 1);
  assert.equal(report.summary.blocking, false);
});
