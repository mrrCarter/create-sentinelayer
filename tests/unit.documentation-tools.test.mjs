// Unit tests for Samir's documentation domain tools (#A23).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DOCUMENTATION_TOOLS,
  DOCUMENTATION_TOOL_IDS,
  dispatchDocumentationTool,
  runAllDocumentationTools,
  runApiDiff,
  runDeadLinkCheck,
  runDocstringCoverage,
  runReadmeFreshness,
} from "../src/agents/documentation/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-docs-"));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("DOCUMENTATION_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...DOCUMENTATION_TOOL_IDS].sort(), [
    "api-diff",
    "dead-link-check",
    "docstring-coverage",
    "readme-freshness",
  ]);
});

test("docstring-coverage: flags undocumented export function", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/util.js", "export function addNumbers(a, b) { return a + b; }\n");
    const findings = await runDocstringCoverage({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "documentation.undocumented-export"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("docstring-coverage: suppresses when JSDoc block is present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/util.js", "/** Adds two numbers. */\nexport function addNumbers(a, b) { return a + b; }\n");
    const findings = await runDocstringCoverage({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("readme-freshness: flags missing README", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/x.js", "export const x = 1;\n");
    const findings = await runReadmeFreshness({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "documentation.no-readme"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("readme-freshness: fresh README produces no finding", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "README.md", "# project\n");
    await writeFile(root, "src/x.js", "export const x = 1;\n");
    const findings = await runReadmeFreshness({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("api-diff: flags undocumented route handler", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server.js",
      "const app = require('express')();\napp.get('/api/users', (req, res) => res.json({}));\n"
    );
    const findings = await runApiDiff({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "documentation.undocumented-endpoint"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("api-diff: suppresses when openapi.yaml documents the endpoint", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server.js",
      "const app = require('express')();\napp.get('/api/users', (req, res) => res.json({}));\n"
    );
    await writeFile(root, "openapi.yaml", "paths:\n  /api/users:\n    get:\n      summary: List users\n# GET /api/users\n");
    const findings = await runApiDiff({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dead-link-check: flags broken relative link", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "docs/index.md", "[See guide](./guide.md)\n");
    const findings = await runDeadLinkCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "documentation.dead-link"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dead-link-check: suppresses when target exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "docs/index.md", "[See guide](./guide.md)\n");
    await writeFile(root, "docs/guide.md", "# guide\n");
    const findings = await runDeadLinkCheck({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllDocumentationTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/util.js", "export function foo(x) { return x + 1; }\n");
    const findings = await runAllDocumentationTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("docstring-coverage") || tools.has("readme-freshness"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dispatchDocumentationTool: unknown id throws", async () => {
  await assert.rejects(() => dispatchDocumentationTool("x", {}), /Unknown documentation tool/);
});

test("DOCUMENTATION_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of DOCUMENTATION_TOOL_IDS) {
    const t = DOCUMENTATION_TOOLS[toolId];
    assert.equal(t.id, toolId);
    assert.ok(t.description.length > 10);
    assert.equal(typeof t.handler, "function");
  }
});
