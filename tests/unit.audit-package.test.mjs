import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  buildDdPackageManifest,
  loadAuditRunReport,
  resolveAuditRunDirectory,
  writeDdPackage,
} from "../src/audit/package.js";

function sampleReport(runDirectory) {
  return {
    runId: "audit-20260402-000000-abcd1234",
    targetPath: "C:/repo",
    runDirectory,
    summary: { P0: 0, P1: 0, P2: 2, P3: 0, blocking: false },
    deterministicBaseline: {
      runId: "review-123",
      reportPath: "C:/repo/.sentinelayer/reviews/review-123/REVIEW_DETERMINISTIC.md",
      reportJsonPath: "C:/repo/.sentinelayer/reviews/review-123/REVIEW_DETERMINISTIC.json",
      summary: { P0: 0, P1: 0, P2: 2, P3: 0, blocking: false },
    },
    ingest: {
      summary: { filesScanned: 12, totalLoc: 1200 },
      frameworks: ["node"],
      riskSurfaces: ["secrets"],
    },
    agentResults: [
      {
        agentId: "security",
        persona: "Nina Patel",
        domain: "Security",
        status: "ok",
        findingCount: 1,
        confidence: 0.9,
        artifactPath: path.join(runDirectory, "agents", "security.json"),
        specialistReportPath: path.join(runDirectory, "agents", "SECURITY_AGENT_REPORT.md"),
        findings: [
          {
            severity: "P2",
            file: "src/app.js",
            line: 10,
            message: "Potential secret exposure",
            ruleId: "SL-SEC-004",
          },
        ],
      },
    ],
  };
}

test("Unit audit package: manifest builder and package writer produce DD artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-package-"));
  try {
    const runDirectory = path.join(tempRoot, ".sentinelayer", "audits", "audit-20260402-000000-abcd1234");
    await mkdir(path.join(runDirectory, "agents"), { recursive: true });
    const report = sampleReport(runDirectory);

    const manifest = buildDdPackageManifest(report);
    assert.equal(manifest.runId, report.runId);
    assert.equal(manifest.summary.P2, 2);
    assert.equal(Array.isArray(manifest.agents), true);

    const ddPackage = await writeDdPackage({
      report,
      runDirectory,
    });
    assert.match(ddPackage.manifestPath, /DD_PACKAGE_MANIFEST\.json$/);
    assert.match(ddPackage.findingsIndexPath, /DD_FINDINGS_INDEX\.json$/);
    assert.match(ddPackage.executiveSummaryPath, /DD_EXEC_SUMMARY\.md$/);
    assert.equal(ddPackage.findingsIndexCount, 1);

    const summaryText = await readFile(ddPackage.executiveSummaryPath, "utf-8");
    assert.match(summaryText, /DD_EXEC_SUMMARY/);
    assert.match(summaryText, /Top findings index/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit package: run directory resolver locates latest and requested runs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-package-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    const runA = path.join(outputRoot, "audits", "audit-a");
    const runB = path.join(outputRoot, "audits", "audit-b");
    await mkdir(runA, { recursive: true });
    await mkdir(runB, { recursive: true });

    await writeFile(path.join(runA, "AUDIT_REPORT.json"), `${JSON.stringify(sampleReport(runA), null, 2)}\n`, "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(path.join(runB, "AUDIT_REPORT.json"), `${JSON.stringify(sampleReport(runB), null, 2)}\n`, "utf-8");

    const requested = await resolveAuditRunDirectory({
      outputRoot,
      runId: "audit-a",
    });
    assert.equal(requested.endsWith(path.join("audits", "audit-a")), true);

    const latest = await resolveAuditRunDirectory({
      outputRoot,
    });
    assert.equal(latest.endsWith(path.join("audits", "audit-b")), true);

    const loaded = await loadAuditRunReport(latest);
    assert.equal(loaded.report.runId, "audit-20260402-000000-abcd1234");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
