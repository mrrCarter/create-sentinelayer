import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { compareAuditReports, writeAuditComparisonArtifact } from "../src/audit/replay.js";

function buildReport(runId, findings = []) {
  return {
    runId,
    summary: { P0: 0, P1: 0, P2: findings.length, P3: 0, blocking: false },
    agentResults: [
      {
        agentId: "security",
        findings,
      },
    ],
  };
}

test("Unit audit replay: compare reports identifies deterministic equivalence", () => {
  const base = buildReport("audit-base", [
    { severity: "P2", file: "src/a.js", line: 10, message: "finding one" },
  ]);
  const candidate = buildReport("audit-candidate", [
    { severity: "P2", file: "src/a.js", line: 10, message: "finding one" },
  ]);

  const comparison = compareAuditReports(base, candidate);
  assert.equal(comparison.deterministicEquivalent, true);
  assert.equal(comparison.addedCount, 0);
  assert.equal(comparison.removedCount, 0);
});

test("Unit audit replay: compare reports detects drift and writes artifact", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-replay-"));
  try {
    const base = buildReport("audit-base", [
      { severity: "P2", file: "src/a.js", line: 10, message: "finding one" },
    ]);
    const candidate = buildReport("audit-candidate", [
      { severity: "P2", file: "src/a.js", line: 10, message: "finding one" },
      { severity: "P2", file: "src/b.js", line: 4, message: "finding two" },
    ]);

    const result = await writeAuditComparisonArtifact({
      baseReport: base,
      candidateReport: candidate,
      outputDirectory: tempRoot,
    });
    assert.match(result.outputPath, /AUDIT_COMPARISON_audit-base_vs_audit-candidate\.json$/);
    assert.equal(result.comparison.deterministicEquivalent, false);
    assert.equal(result.comparison.addedCount, 1);

    const saved = JSON.parse(await readFile(result.outputPath, "utf-8"));
    assert.equal(saved.baseRunId, "audit-base");
    assert.equal(saved.candidateRunId, "audit-candidate");
    assert.equal(saved.addedCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
