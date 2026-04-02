import test from "node:test";
import assert from "node:assert/strict";

import {
  renderDocumentationSpecialistMarkdown,
  runDocumentationSpecialist,
} from "../src/audit/agents/documentation.js";

test("Unit audit documentation: specialist report derives inventory and gaps", () => {
  const report = runDocumentationSpecialist({
    findings: [
      {
        severity: "P2",
        file: "src/core/engine.js",
        line: 11,
        message: "Spec/docs mismatch around runtime assumptions.",
        ruleId: "SL-DOC-010",
      },
    ],
    ingest: {
      indexedFiles: {
        files: [
          { path: "src/core/engine.js", language: "javascript", loc: 610, sizeBytes: 9000 },
          { path: "docs/architecture.md", language: "markdown", loc: 120, sizeBytes: 2200 },
        ],
      },
    },
  });

  assert.equal(report.summary.findingCount >= 1, true);
  assert.equal(report.inventory.codeFileCount >= 1, true);
  assert.equal(report.inventory.docFileCount >= 1, true);
  assert.equal(report.summary.documentationScore <= 100, true);
});

test("Unit audit documentation: markdown renderer emits specialist sections", () => {
  const report = runDocumentationSpecialist({
    findings: [],
    ingest: {
      indexedFiles: {
        files: [{ path: "src/app.js", language: "javascript", loc: 330, sizeBytes: 2600 }],
      },
    },
  });

  const markdown = renderDocumentationSpecialistMarkdown(report);
  assert.match(markdown, /DOCUMENTATION_AGENT_REPORT/);
  assert.match(markdown, /Documentation score:/);
  assert.match(markdown, /Documentation inventory:/);
  assert.match(markdown, /Recommendations:/);
});
