import test from "node:test";
import assert from "node:assert/strict";

import {
  renderArchitectureSpecialistMarkdown,
  runArchitectureSpecialist,
} from "../src/audit/agents/architecture.js";

test("Unit audit architecture: specialist report derives hotspots and summary", () => {
  const report = runArchitectureSpecialist({
    findings: [
      {
        severity: "P2",
        file: "src/backend/service.js",
        line: 12,
        message: "Potential dependency coupling drift detected in service layer.",
      },
    ],
    ingest: {
      indexedFiles: {
        files: [
          {
            path: "src/backend/mega-module.js",
            language: "javascript",
            loc: 840,
            sizeBytes: 12000,
          },
          {
            path: "src/backend/helper.js",
            language: "javascript",
            loc: 120,
            sizeBytes: 2000,
          },
        ],
      },
    },
  });

  assert.equal(report.summary.findingCount >= 1, true);
  assert.equal(Array.isArray(report.hotspots), true);
  assert.equal(report.hotspots.some((item) => item.path === "src/backend/mega-module.js"), true);
  assert.equal(report.summary.architectureScore < 100, true);
  assert.equal(Array.isArray(report.recommendations), true);
});

test("Unit audit architecture: markdown renderer emits specialist sections", () => {
  const report = runArchitectureSpecialist({
    findings: [
      {
        severity: "P2",
        file: "src/frontend/page.tsx",
        line: 20,
        message: "High component coupling in page assembly.",
      },
    ],
    ingest: {
      indexedFiles: {
        files: [
          {
            path: "src/frontend/page.tsx",
            language: "typescript",
            loc: 420,
            sizeBytes: 6400,
          },
        ],
      },
    },
  });

  const markdown = renderArchitectureSpecialistMarkdown(report);
  assert.match(markdown, /ARCHITECTURE_AGENT_REPORT/);
  assert.match(markdown, /Architecture score:/);
  assert.match(markdown, /Hotspots:/);
  assert.match(markdown, /Recommendations:/);
});

test("Unit audit architecture: LOC-only hotspots ignore support artifacts and stay non-blocking", () => {
  const report = runArchitectureSpecialist({
    findings: [],
    ingest: {
      indexedFiles: {
        files: [
          { path: "tests/e2e.test.mjs", language: "javascript", loc: 1800, sizeBytes: 18000 },
          { path: "tasks/backlog.md", language: "markdown", loc: 1500, sizeBytes: 17000 },
          { path: ".github/workflows/ci.yml", language: "yaml", loc: 1200, sizeBytes: 12000 },
          { path: "src/generated/client.ts", language: "typescript", loc: 1100, sizeBytes: 11000 },
          { path: "package-lock.json", language: "json", loc: 2500, sizeBytes: 90000 },
          { path: "src/commands/session.js", language: "javascript", loc: 1000, sizeBytes: 16000 },
        ],
      },
    },
  });

  assert.deepEqual(
    report.hotspots.map((item) => item.path),
    ["src/commands/session.js"]
  );
  assert.equal(report.findings.some((finding) => finding.file === "src/commands/session.js"), true);
  assert.equal(report.summary.P1, 0);
  assert.equal(report.summary.P2, 1);
  assert.equal(report.summary.blocking, false);
});
