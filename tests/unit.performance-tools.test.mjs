// Unit tests for Arjun's performance domain tools (#A16).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PERFORMANCE_TOOLS,
  PERFORMANCE_TOOL_IDS,
  dispatchPerformanceTool,
  runAllPerformanceTools,
  runBlockingIoAudit,
  runBundleBudgetCheck,
  runCachePolicyAudit,
  runNPlusOneDetect,
} from "../src/agents/performance/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-performance-"));
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("PERFORMANCE_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...PERFORMANCE_TOOL_IDS].sort(), [
    "blocking-io-audit",
    "bundle-budget-check",
    "cache-policy-audit",
    "n-plus-one-detect",
  ]);
});

test("dispatchPerformanceTool: unknown id throws", async () => {
  await assert.rejects(
    () => dispatchPerformanceTool("not-real", {}),
    /Unknown performance tool/
  );
});

test("runNPlusOneDetect: flags loop-scoped query calls", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/api/users.js",
      "export async function handler(ids) { for (const id of ids) { await prisma.user.findMany({ where: { id } }); } }\n"
    );
    const findings = await runNPlusOneDetect({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "performance.n-plus-one-loop"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runBlockingIoAudit: flags synchronous filesystem and process calls", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/server/load.js",
      "import fs from 'node:fs';\nimport { execSync } from 'node:child_process';\nexport function load(){ fs.readFileSync('x'); execSync('git status'); }\n"
    );
    const findings = await runBlockingIoAudit({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "performance.blocking-sync-fs"));
    assert.ok(findings.some((f) => f.kind === "performance.blocking-child-process"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCachePolicyAudit: flags expensive handlers without cache signals", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/routes/feed.js",
      "export async function GET(){ const rows = await fetch('https://api.example.com/feed'); return rows; }\n"
    );
    await writeFile(
      root,
      "src/routes/cached.js",
      "export const revalidate = 60;\nexport async function GET(){ return fetch('https://api.example.com/feed', { cache: 'force-cache' }); }\n"
    );
    const findings = await runCachePolicyAudit({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "performance.missing-cache-policy"));
    assert.ok(!findings.some((f) => f.file.endsWith("cached.js")));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runBundleBudgetCheck: flags heavyweight client imports", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/components/Chart.jsx",
      "import Chart from 'chart.js/auto';\nexport function ChartView(){ return Chart; }\n"
    );
    const findings = await runBundleBudgetCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "performance.heavy-client-import"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllPerformanceTools: aggregates findings across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/api/users.js",
      "export async function handler(ids) { for (const id of ids) { await prisma.user.findMany({ where: { id } }); } }\n"
    );
    const findings = await runAllPerformanceTools({ rootPath: root });
    assert.ok(findings.some((f) => f.tool === "n-plus-one-detect"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("PERFORMANCE_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of PERFORMANCE_TOOL_IDS) {
    const tool = PERFORMANCE_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
