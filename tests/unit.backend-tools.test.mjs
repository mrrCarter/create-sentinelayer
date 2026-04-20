// Unit tests for Maya's backend-persona domain tools (#A14).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BACKEND_TOOLS,
  BACKEND_TOOL_IDS,
  dispatchBackendTool,
  runAllBackendTools,
  runCircuitBreakerCheck,
  runIdempotencyAudit,
  runRetryAudit,
  runTimeoutAudit,
} from "../src/agents/backend/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-backend-"));
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("BACKEND_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...BACKEND_TOOL_IDS].sort(), [
    "circuit-breaker-check",
    "idempotency-audit",
    "retry-audit",
    "timeout-audit",
  ]);
});

test("dispatchBackendTool: unknown id throws", async () => {
  await assert.rejects(
    () => dispatchBackendTool("definitely-not-real", {}),
    /Unknown backend tool/
  );
});

test("circuit-breaker-check: flags fetch() without breaker", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "downstream.js",
      `export async function ping() {\n  const r = await fetch("https://example.com");\n  return r.ok;\n}\n`
    );
    const findings = await runCircuitBreakerCheck({ rootPath: root });
    const hit = findings.find((f) => f.kind === "backend.no-circuit-breaker");
    assert.ok(hit);
    assert.equal(hit.severity, "P1");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("circuit-breaker-check: suppressed when opossum / cockatiel is in scope", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "downstream.js",
      `import CircuitBreaker from "opossum";\nconst breaker = new CircuitBreaker(() => fetch("https://x"));\n`
    );
    const findings = await runCircuitBreakerCheck({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("retry-audit: flags for-loop retry with constant sleep", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "worker.js",
      `async function withRetries() {
        for (let i = 0; i < 5; i++) {
          try { return await call(); }
          catch (e) { await new Promise((r) => setTimeout(r, 1000)); }
        }
      }
      `
    );
    const findings = await runRetryAudit({ rootPath: root });
    const hit = findings.find((f) => f.kind === "backend.retry-constant-delay");
    assert.ok(hit);
    assert.equal(hit.severity, "P2");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("retry-audit: does NOT fire when p-retry / async-retry is in use", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "worker.js",
      `import pRetry from "p-retry";\nawait pRetry(call, { retries: 5 });\n`
    );
    const findings = await runRetryAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("timeout-audit: flags fetch() without timeout option", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `export async function go() { return fetch("https://example.com"); }\n`
    );
    const findings = await runTimeoutAudit({ rootPath: root });
    const hit = findings.find((f) => f.kind === "backend.no-timeout");
    assert.ok(hit);
    assert.equal(hit.severity, "P1");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("timeout-audit: suppresses when AbortSignal.timeout is passed", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `export async function go() {
        return fetch("https://example.com", { signal: AbortSignal.timeout(5000) });
      }\n`
    );
    const findings = await runTimeoutAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("timeout-audit: flags requests.get without timeout (Python)", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "client.py",
      `import requests\nrequests.get("https://example.com")\n`
    );
    const findings = await runTimeoutAudit({ rootPath: root });
    const hit = findings.find((f) => f.kind === "backend.no-timeout");
    assert.ok(hit);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("idempotency-audit: flags POST handler without idempotency plumbing", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server.js",
      `import express from "express";
const app = express();
app.post("/api/charge", (req, res) => res.json({ ok: true }));
`
    );
    const findings = await runIdempotencyAudit({ rootPath: root });
    const hit = findings.find((f) => f.kind === "backend.no-idempotency");
    assert.ok(hit);
    assert.equal(hit.severity, "P2");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("idempotency-audit: suppresses when Idempotency-Key is handled", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server.js",
      `import express from "express";
const app = express();
app.post("/api/charge", (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"];
  // lookup ...
  res.json({ ok: true });
});
`
    );
    const findings = await runIdempotencyAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllBackendTools: returns a flat array across all tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `import express from "express";
const app = express();
app.post("/charge", (req, res) => fetch("https://downstream"));
`
    );
    const findings = await runAllBackendTools({ rootPath: root });
    assert.ok(findings.length >= 2);
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("timeout-audit"));
    assert.ok(tools.has("idempotency-audit"));
    assert.ok(tools.has("circuit-breaker-check"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("BACKEND_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of BACKEND_TOOL_IDS) {
    const tool = BACKEND_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
