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

test("Unit audit performance: LOC-only hotspots ignore support artifacts and stay non-blocking", () => {
  const report = runPerformanceSpecialist({
    findings: [],
    ingest: {
      indexedFiles: {
        files: [
          { path: "tests/api.test.mjs", language: "javascript", loc: 1600, sizeBytes: 18000 },
          { path: "docs/performance.md", language: "markdown", loc: 1400, sizeBytes: 15000 },
          { path: "fixtures/generated/payload.json", language: "json", loc: 1200, sizeBytes: 90000 },
          { path: "pnpm-lock.yaml", language: "yaml", loc: 2200, sizeBytes: 90000 },
          { path: "src/api/server.js", language: "javascript", loc: 950, sizeBytes: 12000 },
        ],
      },
    },
  });

  assert.deepEqual(
    report.runtimeHotspots.map((item) => item.path),
    ["src/api/server.js"]
  );
  assert.equal(report.findings.some((finding) => finding.file === "src/api/server.js"), true);
  assert.equal(report.summary.P1, 0);
  assert.equal(report.summary.P2, 1);
  assert.equal(report.summary.blocking, false);
});
