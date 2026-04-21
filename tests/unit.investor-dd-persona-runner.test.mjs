// Unit tests for the unified persona runner (#investor-dd-4..15).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  INVESTOR_DD_PERSONA_IDS,
  INVESTOR_DD_PERSONA_TOOL_REGISTRY,
  getPersonaTools,
  runPersonaOnFile,
  runPersonaAcrossFiles,
  runAllPersonas,
} from "../src/review/investor-dd-persona-runner.js";
import { createBudgetState } from "../src/review/investor-dd-file-loop.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-invdd-runner-"));
}

async function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf-8");
}

test("registry covers 12 canonical personas (frontend excluded)", () => {
  assert.equal(INVESTOR_DD_PERSONA_IDS.length, 12);
  const canonicalNoFrontend = [
    "security",
    "backend",
    "code-quality",
    "testing",
    "data-layer",
    "reliability",
    "release",
    "observability",
    "infrastructure",
    "supply-chain",
    "documentation",
    "ai-governance",
  ];
  for (const id of canonicalNoFrontend) {
    assert.ok(INVESTOR_DD_PERSONA_TOOL_REGISTRY[id], `missing ${id}`);
  }
  assert.equal(INVESTOR_DD_PERSONA_TOOL_REGISTRY.frontend, undefined);
});

test("getPersonaTools returns at least one tool per persona", () => {
  for (const id of INVESTOR_DD_PERSONA_IDS) {
    const tools = getPersonaTools(id);
    assert.ok(tools.length > 0, `persona ${id} has no tools`);
    for (const tool of tools) {
      assert.equal(typeof tool.handler, "function");
      assert.equal(typeof tool.id, "string");
    }
  }
});

test("getPersonaTools returns [] for unknown persona", () => {
  assert.deepEqual(getPersonaTools("ninja-persona"), []);
});

test("runPersonaOnFile: security tools flag eval in a single file", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "app.js", "const run = (x) => eval(x);\n");
    const events = [];
    const result = await runPersonaOnFile({
      personaId: "security",
      file: "app.js",
      rootPath: root,
      budget: createBudgetState(),
      onEvent: (e) => events.push(e),
    });

    assert.ok(result.findings.length > 0, "expected at least 1 finding");
    assert.ok(result.findings.some((f) => f.kind === "sast.eval"));
    assert.ok(events.some((e) => e.type === "persona_finding"));
    assert.ok(events.some((e) => e.type === "persona_file_tool_call"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersonaOnFile: decorates findings with personaId + tool", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "app.js", "const run = (x) => eval(x);\n");
    const result = await runPersonaOnFile({
      personaId: "security",
      file: "app.js",
      rootPath: root,
      budget: createBudgetState(),
    });
    assert.ok(result.findings.every((f) => f.personaId === "security"));
    assert.ok(result.findings.every((f) => typeof f.tool === "string"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersonaOnFile: budget exhaustion stops remaining tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "app.js", "const run = (x) => eval(x);\n");
    const budget = createBudgetState({ maxUsd: 0 });
    budget.spentUsd = 1;
    const events = [];
    const result = await runPersonaOnFile({
      personaId: "security",
      file: "app.js",
      rootPath: root,
      budget,
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.stoppedEarly, true);
    assert.equal(result.findings.length, 0);
    assert.ok(events.every((e) => e.type !== "persona_file_tool_call"));
    assert.ok(events.some((e) => e.type === "persona_tool_skipped"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersonaOnFile: requires personaId, file, rootPath", async () => {
  await assert.rejects(() => runPersonaOnFile({}), /personaId/);
  await assert.rejects(
    () => runPersonaOnFile({ personaId: "security" }),
    /file/,
  );
  await assert.rejects(
    () => runPersonaOnFile({ personaId: "security", file: "a.js" }),
    /rootPath/,
  );
});

test("runPersonaAcrossFiles: visits each file + aggregates findings", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "const run = (x) => eval(x);\n");
    await writeFile(root, "b.js", "// clean file\nconst x = 1;\n");
    const events = [];
    const result = await runPersonaAcrossFiles({
      personaId: "security",
      files: ["a.js", "b.js"],
      rootPath: root,
      budget: createBudgetState(),
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.visited.length, 2);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.terminationReason, "ok");
    assert.equal(result.perFile.length, 2);
    assert.ok(result.findings.length >= 1);
    assert.ok(events.filter((e) => e.type === "persona_file_start").length === 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersonaAcrossFiles: halts when budget exhausts mid-stream", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "// clean\n");
    await writeFile(root, "b.js", "// clean\n");
    const budget = createBudgetState({ maxUsd: 10 });
    budget.spentUsd = 20; // pre-exhausted

    const result = await runPersonaAcrossFiles({
      personaId: "security",
      files: ["a.js", "b.js"],
      rootPath: root,
      budget,
    });
    assert.equal(result.terminationReason, "budget-cost-exhausted");
    assert.equal(result.visited.length, 0);
    assert.equal(result.skipped.length, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllPersonas: dispatches across multiple personas", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "app.js", "const run = (x) => eval(x);\n");
    await writeFile(root, "README.md", "# test\n");

    const routing = {
      security: ["app.js"],
      documentation: ["README.md"],
    };
    const events = [];
    const result = await runAllPersonas({
      routing,
      rootPath: root,
      budget: createBudgetState({ maxUsd: 100 }),
      onEvent: (e) => events.push(e),
    });

    assert.ok(result.byPersona.security);
    assert.ok(result.byPersona.documentation);
    assert.ok(result.findings.length >= 1);
    assert.equal(result.terminationReason, "ok");
    assert.ok(events.some((e) => e.type === "persona_start"));
    assert.ok(events.some((e) => e.type === "persona_complete"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllPersonas: marks remaining personas skipped after budget trip", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "const run = (x) => eval(x);\n");
    const budget = createBudgetState({ maxUsd: 10 });
    budget.spentUsd = 11; // pre-exhausted

    const result = await runAllPersonas({
      routing: { security: ["a.js"], documentation: ["README.md"] },
      rootPath: root,
      budget,
    });
    assert.ok(result.byPersona.security);
    assert.equal(result.byPersona.security.terminationReason, "budget-cost-exhausted");
    assert.equal(result.terminationReason, "budget-cost-exhausted");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllPersonas: requires rootPath", async () => {
  await assert.rejects(() => runAllPersonas({}), /rootPath/);
});
