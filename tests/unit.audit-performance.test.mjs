import test from "node:test";
import assert from "node:assert/strict";

import {
  renderPerformanceSpecialistMarkdown,
  runPerformanceSpecialist,
} from "../src/audit/agents/performance.js";

test("Unit audit performance: specialist report derives runtime hotspots", () => {
  const report = runPerformanceSpecialist({
    findings: [
      {
        severity: "P2",
        file: "src/api/handler.js",
        line: 99,
        message: "Potential N+1 query pattern in request loop.",
        ruleId: "SL-PERF-017",
      },
    ],
    ingest: {
      indexedFiles: {
        files: [
          { path: "src/api/handler.js", language: "javascript", loc: 520, sizeBytes: 7400 },
          { path: "src/db/repo.js", language: "javascript", loc: 330, sizeBytes: 5200 },
        ],
      },
    },
  });

  assert.equal(report.summary.findingCount >= 1, true);
  assert.equal(Array.isArray(report.runtimeHotspots), true);
  assert.equal(report.runtimeHotspots.length >= 1, true);
  assert.equal(report.summary.performanceScore <= 100, true);
  assert.equal(Array.isArray(report.recommendations), true);
});

test("Unit audit performance: markdown renderer emits specialist sections", () => {
  const report = runPerformanceSpecialist({
    findings: [],
    ingest: {
      indexedFiles: {
        files: [{ path: "src/app.js", language: "javascript", loc: 310, sizeBytes: 2600 }],
      },
    },
  });

  const markdown = renderPerformanceSpecialistMarkdown(report);
  assert.match(markdown, /PERFORMANCE_AGENT_REPORT/);
  assert.match(markdown, /Performance score:/);
  assert.match(markdown, /Runtime hotspots:/);
  assert.match(markdown, /Recommendations:/);
});
