import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  appendBlackboardEntry,
  benchmarkBlackboardNeedleRecall,
  createBlackboard,
  queryBlackboard,
  writeBlackboardArtifact,
} from "../src/memory/blackboard.js";

test("Unit memory blackboard: append/query/persist stays deterministic", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-blackboard-"));
  try {
    const blackboard = createBlackboard({
      runId: "audit-test-run",
      scope: "audit-orchestrator",
    });
    appendBlackboardEntry(blackboard, {
      agentId: "security",
      source: "deterministic-baseline",
      severity: "P1",
      file: "src/auth/service.js",
      line: 42,
      layer: "deterministic",
      message: "Auth token validation gap",
      note: "requires strict token validation",
    });
    appendBlackboardEntry(blackboard, {
      agentId: "testing",
      source: "specialist-agent",
      severity: "P2",
      file: "tests/e2e.test.mjs",
      line: 300,
      layer: "deterministic",
      message: "Missing regression coverage for auth edge case",
    });

    const lookup = queryBlackboard(blackboard, {
      query: "token validation auth",
      agentId: "security",
      limit: 2,
    });
    assert.equal(lookup.entries.length, 2);
    assert.equal(lookup.entries[0].agentId, "security");
    assert.equal(lookup.entries[0].severity, "P1");
    assert.equal(lookup.entries[0].file, "src/auth/service.js");

    const artifact = await writeBlackboardArtifact(blackboard, {
      outputRoot: tempRoot,
    });
    assert.match(String(artifact.artifactPath || ""), /[\\/]memory[\\/]blackboard-audit-test-run\.json$/);
    assert.equal(artifact.summary.entryCount, 2);
    assert.equal(artifact.summary.queryCount, 1);

    const payload = JSON.parse(await readFile(artifact.artifactPath, "utf-8"));
    assert.equal(payload.runId, "audit-test-run");
    assert.equal(payload.summary.entryCount, 2);
    assert.equal(Array.isArray(payload.entries), true);
    assert.equal(payload.entries.length, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit memory blackboard: 8-needle recall benchmark meets >=95%", () => {
  const blackboard = createBlackboard({
    runId: "audit-needle-run",
    scope: "audit-orchestrator",
  });
  const needles = [
    { id: "n-auth", message: "token rotation guardrail missing in auth flow", file: "src/auth/service.js" },
    { id: "n-xss", message: "unsanitized html rendering in dashboard component", file: "src/ui/dashboard.js" },
    { id: "n-sql", message: "parameterized query enforcement absent on repository layer", file: "src/data/repository.js" },
    { id: "n-csrf", message: "csrf origin check bypass on callback handler", file: "src/http/callback.js" },
    { id: "n-secrets", message: "plain secret written into runtime logs", file: "src/runtime/logger.js" },
    { id: "n-timeout", message: "retry loop lacks timeout ceiling for provider calls", file: "src/ai/client.js" },
    { id: "n-tests", message: "regression test absent for fixed auth bug", file: "tests/auth.test.mjs" },
    { id: "n-spec", message: "spec mismatch between endpoint and implementation path", file: "SPEC.md" },
  ];

  for (const needle of needles) {
    appendBlackboardEntry(blackboard, {
      agentId: "security",
      source: "specialist-agent",
      severity: "P2",
      file: needle.file,
      message: needle.message,
      needleId: needle.id,
      note: "benchmark-seed",
    });
  }

  const benchmark = benchmarkBlackboardNeedleRecall(blackboard, {
    query:
      "auth token html query callback secret timeout regression test spec endpoint mismatch",
    agentId: "security",
    needleIds: needles.map((needle) => needle.id),
    limit: 8,
  });

  assert.equal(benchmark.expectedCount, 8);
  assert.equal(benchmark.pass, true);
  assert.equal(benchmark.recall >= 0.95, true);
  assert.equal(benchmark.missingNeedles.length, 0);
});
