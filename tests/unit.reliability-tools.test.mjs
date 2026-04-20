// Unit tests for Noah's reliability domain tools (#A18).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RELIABILITY_TOOLS,
  RELIABILITY_TOOL_IDS,
  dispatchReliabilityTool,
  runAllReliabilityTools,
  runBackpressureCheck,
  runChaosProbe,
  runGracefulDegradationCheck,
  runHealthCheckAudit,
} from "../src/agents/reliability/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-reliability-"));
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("RELIABILITY_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...RELIABILITY_TOOL_IDS].sort(), [
    "backpressure-check",
    "chaos-probe",
    "graceful-degradation-check",
    "health-check-audit",
  ]);
});

test("dispatchReliabilityTool: unknown id throws", async () => {
  await assert.rejects(
    () => dispatchReliabilityTool("not-real", {}),
    /Unknown reliability tool/
  );
});

test("chaos-probe: advises when repo has outbound calls but no chaos signals", async () => {
  const root = await makeTempRepo();
  try {
    for (let i = 0; i < 3; i += 1) {
      await writeFile(root, `svc${i}.js`, `export async function go() { return fetch('https://ex.com/${i}'); }\n`);
    }
    const findings = await runChaosProbe({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "reliability.no-chaos-testing"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("chaos-probe: no advice when chaostoolkit is wired up", async () => {
  const root = await makeTempRepo();
  try {
    for (let i = 0; i < 3; i += 1) {
      await writeFile(root, `svc${i}.js`, `export async function go() { return fetch('https://ex.com/${i}'); }\n`);
    }
    await writeFile(root, "chaos/test.py", `from chaostoolkit import *\nchaos_toolkit_experiment()\n`);
    const findings = await runChaosProbe({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("chaos-probe: no advice when outbound surface is too small", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "svc.js", "export const x = 1;\n");
    const findings = await runChaosProbe({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("health-check-audit: flags routes without a health endpoint", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server/app.js",
      `import express from 'express';\nconst app = express();\napp.get('/api/users', (req, res) => res.json({}));\napp.listen(3000);\n`
    );
    const findings = await runHealthCheckAudit({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "reliability.no-health-endpoint"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("health-check-audit: suppresses when /healthz is present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server/app.js",
      `import express from 'express';\nconst app = express();\napp.get('/healthz', (req, res) => res.status(200).send('ok'));\napp.get('/api/users', (req, res) => res.json({}));\n`
    );
    const findings = await runHealthCheckAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("graceful-degradation-check: flags outbound call without try/catch/fallback", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `export async function getProfile() {\n  const r = await fetch('https://example.com');\n  return r.json();\n}\n`
    );
    const findings = await runGracefulDegradationCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "reliability.no-graceful-degradation"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("graceful-degradation-check: suppresses when try/catch fallback is present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `export async function getProfile() {\n  try { return await fetch('https://example.com'); } catch (e) { return { fallback: true }; }\n}\n`
    );
    const findings = await runGracefulDegradationCheck({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("backpressure-check: flags BullMQ queue without concurrency/DLQ", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "worker.js",
      `import { Queue } from 'bullmq';\nconst q = new Queue('jobs');\nq.process(async (job) => { /* ... */ });\n`
    );
    const findings = await runBackpressureCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "reliability.no-backpressure"));
    assert.ok(findings.some((f) => f.kind === "reliability.no-dlq"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("backpressure-check: suppresses when concurrency + DLQ are set", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "worker.js",
      `import { Queue } from 'bullmq';\nconst q = new Queue('jobs', { concurrency: 5, defaultJobOptions: { attempts: 3, removeOnFail: false } });\n// DLQ handled via retry_policy / dead-letter queue on the broker\n`
    );
    const findings = await runBackpressureCheck({ rootPath: root });
    // Both suppressions should fire → no findings.
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllReliabilityTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `export async function go() { return fetch('https://ex.com'); }\n`
    );
    await writeFile(
      root,
      "server/app.js",
      `import express from 'express';\nconst app = express();\napp.post('/api/x', (req, res) => res.json({}));\n`
    );
    const findings = await runAllReliabilityTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("health-check-audit"));
    assert.ok(tools.has("graceful-degradation-check"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("RELIABILITY_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of RELIABILITY_TOOL_IDS) {
    const tool = RELIABILITY_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
