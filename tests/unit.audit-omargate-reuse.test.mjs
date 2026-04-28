import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAuditOrchestrator } from "../src/audit/orchestrator.js";
import { writeOmarGateDeterministicCache } from "../src/review/omargate-cache.js";

test("Unit audit orchestrator: reuse-omargate latest skips deterministic rerun and seeds blackboard", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audit-omargate-reuse-"));
  try {
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "index.js"), "export const ok = true;\n", "utf-8");

    await writeOmarGateDeterministicCache({
      targetPath: tempRoot,
      runId: "omargate-cached-run",
      deterministic: {
        runId: "review-cached-run",
        summary: { P0: 0, P1: 0, P2: 1, P3: 0, blocking: false },
        findings: [
          {
            severity: "P2",
            file: "src/index.js",
            line: 1,
            message: "Cached deterministic issue",
            confidence: 1,
          },
        ],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/index.js"],
        },
        layers: {
          ingest: {
            summary: {
              filesScanned: 1,
              totalLoc: 1,
            },
          },
        },
        metadata: {},
        artifacts: {
          jsonPath: path.join(tempRoot, ".sentinelayer", "reviews", "review-cached-run", "REVIEW_DETERMINISTIC.json"),
        },
      },
      reportPath: path.join(tempRoot, ".sentinelayer", "reports", "omargate-deep.md"),
    });

    const result = await runAuditOrchestrator({
      targetPath: tempRoot,
      agents: [],
      maxParallel: 1,
      reuseOmarGate: "latest",
      seedFromDeterministic: true,
    });

    assert.equal(result.omargateReuse.used, true);
    assert.equal(result.omargateReuse.runId, "omargate-cached-run");
    assert.equal(result.deterministicBaseline.reusedFromOmarGate, true);
    assert.equal(result.deterministicBaseline.runId, "review-cached-run");
    assert.equal(result.deterministicBaseline.findings.length, 1);
    assert.equal(result.sharedMemory.entryCount, 1);

    const reportText = await fs.readFile(result.reportMarkdownPath, "utf-8");
    assert.match(reportText, /OmarGate reuse: yes \(omargate-cached-run\)/);
    assert.match(reportText, /Reused OmarGate run: omargate-cached-run/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit orchestrator: unavailable reuse falls back to deterministic baseline", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "audit-omargate-reuse-missing-"));
  try {
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "index.js"), "export const ok = true;\n", "utf-8");

    const result = await runAuditOrchestrator({
      targetPath: tempRoot,
      agents: [],
      maxParallel: 1,
      reuseOmarGate: "latest",
      seedFromDeterministic: true,
    });

    assert.equal(result.omargateReuse.used, false);
    assert.equal(result.omargateReuse.reason, "not_found");
    assert.equal(result.deterministicBaseline.reusedFromOmarGate, undefined);
    assert.match(result.deterministicBaseline.runId, /^review-/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
