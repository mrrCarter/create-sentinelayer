// Unit tests for Sofia's observability domain tools (#A20).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  OBSERVABILITY_TOOLS,
  OBSERVABILITY_TOOL_IDS,
  dispatchObservabilityTool,
  runAllObservabilityTools,
  runAlertAudit,
  runDashboardGap,
  runLogSchemaCheck,
  runSpanCoverage,
} from "../src/agents/observability/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-observability-"));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("OBSERVABILITY_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...OBSERVABILITY_TOOL_IDS].sort(), [
    "alert-audit",
    "dashboard-gap",
    "log-schema-check",
    "span-coverage",
  ]);
});

test("span-coverage: flags route handler without tracing", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "server.js", `import express from 'express';\nconst app = express();\napp.get('/api/x', (req, res) => res.json({}));\n`);
    const findings = await runSpanCoverage({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "observability.no-span"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("span-coverage: suppresses when tracer.startSpan is present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "server.js", `import { trace } from '@opentelemetry/api';\nimport express from 'express';\nconst app = express();\napp.get('/x', (req, res) => {\n  const span = trace.getTracer('app').startSpan('x');\n  res.json({});\n  span.end();\n});\n`);
    const findings = await runSpanCoverage({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dashboard-gap: advises when no dashboard dir exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "export const x = 1;\n");
    const findings = await runDashboardGap({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "observability.no-dashboard"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dashboard-gap: suppresses when grafana dir exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "grafana/app.json", "{}\n");
    const findings = await runDashboardGap({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("alert-audit: advises when no alerts defined", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "export const x = 1;\n");
    const findings = await runAlertAudit({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "observability.no-alerts"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("alert-audit: suppresses when prometheus rules present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "prometheus/rules/alerts.yml", "groups: []\n");
    const findings = await runAlertAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("log-schema-check: flags console.log in production source", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/svc.js", "export function go() {\n  console.log('hi');\n  return 1;\n}\n");
    const findings = await runLogSchemaCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "observability.unstructured-log"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("log-schema-check: ignores console.log in test files", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "foo.test.js", "console.log('in test');\n");
    const findings = await runLogSchemaCheck({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllObservabilityTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "server.js", `const app = require('express')();\napp.get('/x', (req, res) => res.json({}));\n`);
    const findings = await runAllObservabilityTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("span-coverage"));
    assert.ok(tools.has("dashboard-gap") || tools.has("alert-audit"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dispatchObservabilityTool: unknown id throws", async () => {
  await assert.rejects(() => dispatchObservabilityTool("x", {}), /Unknown observability tool/);
});

test("OBSERVABILITY_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of OBSERVABILITY_TOOL_IDS) {
    const t = OBSERVABILITY_TOOLS[toolId];
    assert.equal(t.id, toolId);
    assert.ok(t.description.length > 20);
    assert.equal(typeof t.handler, "function");
  }
});
