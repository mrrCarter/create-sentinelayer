import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  compareUnifiedReports,
  loadReviewRunContext,
  writeReviewRunContext,
} from "../src/review/replay.js";

test("Unit review replay: compare reports treats identical fingerprints as equivalent", () => {
  const baseReport = {
    summary: { P0: 0, P1: 1, P2: 0, P3: 0, blocking: true },
    findings: [
      {
        findingId: "F-001",
        severity: "P1",
        file: "src/auth.js",
        line: 12,
        message: "Auth bypass risk",
      },
    ],
  };
  const candidateReport = {
    summary: { P0: 0, P1: 1, P2: 0, P3: 0, blocking: true },
    findings: [
      {
        findingId: "F-999",
        severity: "P1",
        file: "src/auth.js",
        line: 12,
        message: "Auth bypass risk",
      },
    ],
  };

  const comparison = compareUnifiedReports(baseReport, candidateReport);
  assert.equal(comparison.deterministicEquivalent, true);
  assert.equal(comparison.counts.added, 0);
  assert.equal(comparison.counts.removed, 0);
  assert.equal(comparison.counts.severityChanged, 0);
});

test("Unit review replay: compare reports detects additions and severity drift", () => {
  const baseReport = {
    summary: { P0: 0, P1: 1, P2: 0, P3: 0, blocking: true },
    findings: [
      { findingId: "F-001", severity: "P1", file: "a.js", line: 1, message: "A" },
      { findingId: "F-002", severity: "P2", file: "b.js", line: 2, message: "B" },
    ],
  };
  const candidateReport = {
    summary: { P0: 1, P1: 0, P2: 1, P3: 0, blocking: true },
    findings: [
      { findingId: "F-010", severity: "P0", file: "a.js", line: 1, message: "A" },
      { findingId: "F-020", severity: "P2", file: "b.js", line: 2, message: "B" },
      { findingId: "F-030", severity: "P2", file: "c.js", line: 3, message: "C" },
    ],
  };

  const comparison = compareUnifiedReports(baseReport, candidateReport);
  assert.equal(comparison.deterministicEquivalent, false);
  assert.equal(comparison.counts.added, 1);
  assert.equal(comparison.counts.removed, 0);
  assert.equal(comparison.counts.severityChanged, 1);
  assert.equal(comparison.summaryDelta.P0, 1);
  assert.equal(comparison.summaryDelta.P1, -1);
});

test("Unit review replay: run context write/load round-trip is deterministic", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-replay-unit-"));
  try {
    const writeResult = await writeReviewRunContext({
      runDirectory: tempRoot,
      runId: "review-abc",
      targetPath: tempRoot,
      mode: "diff",
      invocation: {
        aiEnabled: true,
        aiDryRun: true,
        provider: "openai",
        model: "gpt-5.3-codex",
        maxCost: "1.0",
      },
      replay: {
        sourceRunId: "review-base",
        replayed: true,
      },
    });
    assert.ok(String(writeResult.contextPath || "").includes("REVIEW_RUN_CONTEXT.json"));

    const loaded = await loadReviewRunContext(tempRoot);
    assert.equal(loaded.context.runId, "review-abc");
    assert.equal(loaded.context.mode, "diff");
    assert.equal(loaded.context.invocation.aiEnabled, true);
    assert.equal(loaded.context.invocation.aiDryRun, true);
    assert.equal(loaded.context.replay.sourceRunId, "review-base");
    assert.equal(typeof loaded.context.gitState.dirty, "boolean");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

