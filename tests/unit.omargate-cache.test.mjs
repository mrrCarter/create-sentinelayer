import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadOmarGateDeterministicCache,
  writeOmarGateDeterministicCache,
} from "../src/review/omargate-cache.js";

async function makeTempRoot(prefix = "omargate-cache-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function deterministicFixture(overrides = {}) {
  return {
    runId: "review-cache-test",
    mode: "full",
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
      markdownPath: "REVIEW_DETERMINISTIC.md",
      jsonPath: "REVIEW_DETERMINISTIC.json",
    },
    ...overrides,
  };
}

test("Unit OmarGate cache: writes stable deterministic cache and loads explicit run id", async () => {
  const tempRoot = await makeTempRoot();
  try {
    const written = await writeOmarGateDeterministicCache({
      targetPath: tempRoot,
      runId: "omargate-test-run",
      deterministic: deterministicFixture(),
      reportPath: path.join(tempRoot, ".sentinelayer", "reports", "omargate.md"),
    });

    assert.match(written.artifactPath, /[\\/]\.sentinelayer[\\/]runs[\\/]omargate-test-run[\\/]deterministic\.json$/);
    const loaded = await loadOmarGateDeterministicCache({
      targetPath: tempRoot,
      runIdOrLatest: "omargate-test-run",
    });

    assert.equal(loaded.found, true);
    assert.equal(loaded.runId, "omargate-test-run");
    assert.equal(loaded.cache.deterministicRunId, "review-cache-test");
    assert.equal(loaded.cache.findings.length, 1);
    assert.equal(loaded.cache.source.command, "/omargate deep");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit OmarGate cache: latest resolves only for the same target path", async () => {
  const firstRoot = await makeTempRoot("omargate-cache-first-");
  const secondRoot = await makeTempRoot("omargate-cache-second-");
  try {
    await writeOmarGateDeterministicCache({
      targetPath: firstRoot,
      runId: "omargate-first",
      deterministic: deterministicFixture(),
    });

    const latestForFirst = await loadOmarGateDeterministicCache({
      targetPath: firstRoot,
      runIdOrLatest: "latest",
    });
    assert.equal(latestForFirst.found, true);
    assert.equal(latestForFirst.runId, "omargate-first");

    const latestForSecond = await loadOmarGateDeterministicCache({
      targetPath: secondRoot,
      outputDir: path.join(firstRoot, ".sentinelayer"),
      runIdOrLatest: "latest",
    });
    assert.equal(latestForSecond.found, false);
    assert.equal(latestForSecond.reason, "not_found");
  } finally {
    await Promise.all([
      fs.rm(firstRoot, { recursive: true, force: true }),
      fs.rm(secondRoot, { recursive: true, force: true }),
    ]);
  }
});

test("Unit OmarGate cache: invalid or malformed requested caches fail closed", async () => {
  const tempRoot = await makeTempRoot();
  try {
    const invalid = await loadOmarGateDeterministicCache({
      targetPath: tempRoot,
      runIdOrLatest: "../escape",
    });
    assert.equal(invalid.found, false);
    assert.equal(invalid.reason, "invalid_run_id");

    const runsDir = path.join(tempRoot, ".sentinelayer", "runs", "bad-run");
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(path.join(runsDir, "deterministic.json"), "{not-json", "utf-8");

    const malformed = await loadOmarGateDeterministicCache({
      targetPath: tempRoot,
      runIdOrLatest: "bad-run",
    });
    assert.equal(malformed.found, false);
    assert.equal(malformed.reason, "malformed_or_missing_cache");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
