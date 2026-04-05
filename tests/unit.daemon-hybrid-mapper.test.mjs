import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";

import {
  buildHybridHandoffPackage,
  buildHybridScopeMap,
  listHybridHandoffs,
  listHybridScopeMaps,
  showHybridHandoff,
  showHybridScopeMap,
} from "../src/daemon/hybrid-mapper.js";
import {
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../src/daemon/error-worker.js";

async function seedHybridWorkspace(targetPath) {
  await mkdir(path.join(targetPath, "src", "routes"), { recursive: true });
  await mkdir(path.join(targetPath, "src", "services"), { recursive: true });
  await mkdir(path.join(targetPath, "src", "graph"), { recursive: true });
  await mkdir(path.join(targetPath, "src", "utils"), { recursive: true });

  await writeFile(
    path.join(targetPath, "package.json"),
    JSON.stringify(
      {
        name: "hybrid-map-fixture",
        version: "0.0.1",
        type: "module",
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(
    path.join(targetPath, "src", "routes", "runtime-runs.js"),
    [
      "import { runRuntimeScan } from \"../services/runtime-service.js\";",
      "",
      "export function registerRuntimeRoutes(app) {",
      "  app.get(\"/v1/runtime/runs\", runRuntimeScan);",
      "}",
      "",
    ].join("\n"),
    "utf-8"
  );
  await writeFile(
    path.join(targetPath, "src", "services", "runtime-service.js"),
    [
      "import { buildSemanticOverlay } from \"../graph/semantic-map.js\";",
      "",
      "export function runRuntimeScan(req, res) {",
      "  const overlay = buildSemanticOverlay(req.path || \"/v1/runtime/runs\");",
      "  res.json({ ok: true, overlay });",
      "}",
      "",
    ].join("\n"),
    "utf-8"
  );
  await writeFile(
    path.join(targetPath, "src", "graph", "semantic-map.js"),
    [
      "import { computeBudgetToken } from \"../utils/token-budget.js\";",
      "",
      "export function buildSemanticOverlay(endpoint) {",
      "  return `${endpoint}:${computeBudgetToken(42)}`;",
      "}",
      "",
    ].join("\n"),
    "utf-8"
  );
  await writeFile(
    path.join(targetPath, "src", "utils", "token-budget.js"),
    [
      "export function computeBudgetToken(value) {",
      "  return `runtime-${value}`;",
      "}",
      "",
    ].join("\n"),
    "utf-8"
  );
}

async function seedWorkItem(targetPath) {
  await appendAdminErrorEvent({
    targetPath,
    event: {
      service: "sentinelayer-api",
      endpoint: "/v1/runtime/runs",
      errorCode: "RUNTIME_TIMEOUT",
      severity: "P1",
      message: "runtime timeout for hybrid map test",
    },
  });
  await runErrorDaemonWorker({
    targetPath,
    maxEvents: 20,
    nowIso: "2026-04-02T00:20:00.000Z",
  });
  const queue = await listErrorQueue({
    targetPath,
    limit: 10,
  });
  const workItemId = String(queue.items[0]?.workItemId || "");
  if (!workItemId) {
    throw new Error("Expected seeded work item.");
  }
  return workItemId;
}

test("Unit daemon hybrid mapper: builds deterministic + semantic overlay scope map", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-hybrid-map-"));
  try {
    await seedHybridWorkspace(tempRoot);
    const workItemId = await seedWorkItem(tempRoot);
    const mapped = await buildHybridScopeMap({
      targetPath: tempRoot,
      workItemId,
      maxFiles: 10,
      graphDepth: 2,
      nowIso: "2026-04-02T00:20:30.000Z",
    });
    assert.equal(mapped.workItem.workItemId, workItemId);
    assert.equal(mapped.summary.scopedFileCount > 0, true);
    assert.equal(mapped.summary.graphNodeCount > 0, true);
    assert.equal(mapped.summary.astParsedFileCount > 0, true);
    assert.equal(mapped.summary.astParseErrorCount, 0);
    assert.equal(mapped.summary.callGraphNodeCount > 0, true);
    assert.equal(mapped.summary.callGraphEdgeCount > 0, true);
    const scopedPaths = mapped.scopedFiles.map((file) => file.path);
    assert.equal(scopedPaths.includes("src/routes/runtime-runs.js"), true);
    assert.equal(scopedPaths.includes("src/services/runtime-service.js"), true);
    assert.equal(mapped.strategy.mode, "hybrid_deterministic_ast_semantic_overlay");
    assert.equal(mapped.strategy.tokenizedSignals.includes("runtime"), true);
    assert.equal(mapped.strategy.callGraphOverlay.edgeCount > 0, true);
    assert.equal(Array.isArray(mapped.callGraph.edges), true);
    assert.equal(mapped.callGraph.edges.length > 0, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon hybrid mapper: list/show surfaces latest map artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-hybrid-list-"));
  try {
    await seedHybridWorkspace(tempRoot);
    const workItemId = await seedWorkItem(tempRoot);
    const mapped = await buildHybridScopeMap({
      targetPath: tempRoot,
      workItemId,
      maxFiles: 8,
      graphDepth: 2,
      nowIso: "2026-04-02T00:21:00.000Z",
    });
    const listed = await listHybridScopeMaps({
      targetPath: tempRoot,
      workItemId,
      limit: 10,
    });
    assert.equal(listed.totalCount, 1);
    assert.equal(listed.visibleCount, 1);
    assert.equal(listed.maps[0].workItemId, workItemId);
    const shown = await showHybridScopeMap({
      targetPath: tempRoot,
      workItemId,
      runId: mapped.runId,
    });
    assert.equal(shown.payload.workItem.workItemId, workItemId);
    assert.equal(Array.isArray(shown.payload.scopedFiles), true);
    assert.equal(shown.payload.scopedFiles.length > 0, true);
    assert.equal(Array.isArray(shown.payload.callGraph.nodes), true);
    assert.equal(shown.payload.callGraph.nodes.length > 0, true);
    assert.equal(Array.isArray(shown.payload.callGraph.edges), true);
    assert.equal(shown.payload.callGraph.edges.length > 0, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon hybrid mapper: builds deterministic handoff package from scoped map", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-hybrid-handoff-"));
  try {
    await seedHybridWorkspace(tempRoot);
    const workItemId = await seedWorkItem(tempRoot);
    const mapped = await buildHybridScopeMap({
      targetPath: tempRoot,
      workItemId,
      maxFiles: 8,
      graphDepth: 2,
      nowIso: "2026-04-02T00:22:00.000Z",
    });
    const handoff = await buildHybridHandoffPackage({
      targetPath: tempRoot,
      workItemId,
      mapRunId: mapped.runId,
      assignee: "maya.markov@sentinelayer.local",
      maxFiles: 5,
      nowIso: "2026-04-02T00:22:30.000Z",
    });
    assert.equal(handoff.payload.workItem.workItemId, workItemId);
    assert.equal(handoff.payload.assignee.primary, "maya.markov@sentinelayer.local");
    assert.equal(handoff.payload.files.length > 0, true);
    assert.equal(handoff.summary.estimatedInputTokens > 0, true);

    const listed = await listHybridHandoffs({
      targetPath: tempRoot,
      workItemId,
      limit: 10,
    });
    assert.equal(listed.totalCount, 1);
    assert.equal(listed.visibleCount, 1);
    assert.equal(listed.handoffs[0].workItemId, workItemId);

    const shown = await showHybridHandoff({
      targetPath: tempRoot,
      workItemId,
      handoffRunId: handoff.handoffRunId,
    });
    assert.equal(shown.payload.workItem.workItemId, workItemId);
    assert.equal(Array.isArray(shown.payload.files), true);
    assert.equal(shown.payload.files.length > 0, true);
    assert.equal(Array.isArray(shown.payload.context.callGraph.edges), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
