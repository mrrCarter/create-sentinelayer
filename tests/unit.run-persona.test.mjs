// Unit tests for src/agents/run-persona.js (#A27 runtime integration).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SUPPORTED_PERSONA_IDS,
  runPersona,
} from "../src/agents/run-persona.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-run-persona-"));
}

test("SUPPORTED_PERSONA_IDS covers the 12 non-frontend personas", () => {
  assert.deepEqual([...SUPPORTED_PERSONA_IDS], [
    "ai-governance",
    "backend",
    "code-quality",
    "data-layer",
    "documentation",
    "infrastructure",
    "observability",
    "release",
    "reliability",
    "security",
    "supply-chain",
    "testing",
  ]);
});

test("runPersona: unknown persona id throws", async () => {
  await assert.rejects(
    () => runPersona({ personaId: "definitely-not-real", rootPath: "." }),
    /Unknown persona id/
  );
});

test("runPersona: missing persona id throws", async () => {
  await assert.rejects(
    () => runPersona({ rootPath: "." }),
    /personaId is required/
  );
});

test("runPersona: security mode=audit runs tools and returns findings", async () => {
  const root = await makeTempRepo();
  try {
    await fsp.writeFile(
      path.join(root, "trigger.js"),
      "const run = (x) => eval(x);\n",
      "utf-8"
    );
    const result = await runPersona({
      personaId: "security",
      mode: "audit",
      rootPath: root,
    });
    assert.equal(result.personaId, "security");
    assert.equal(result.mode, "audit");
    assert.equal(result.rootPath, root);
    assert.ok(Array.isArray(result.findings));
    assert.ok(result.findings.some((f) => f.kind === "sast.eval"));
    // Mode config is attached for audit too — lets callers see the
    // allowed-tools baseline for diagnostics.
    assert.ok(Array.isArray(result.mode_config.allowedTools));
    assert.ok(result.mode_config.promptSuffix.includes("AUDIT"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersona: mode=codegen attaches the codegen plan", async () => {
  const root = await makeTempRepo();
  try {
    await fsp.writeFile(
      path.join(root, "safe.js"),
      "export const x = 1;\n",
      "utf-8"
    );
    const result = await runPersona({
      personaId: "security",
      mode: "codegen",
      rootPath: root,
    });
    assert.equal(result.mode, "codegen");
    assert.ok(
      result.mode_config.allowedTools.includes("FileEdit"),
      "codegen allowedTools should include FileEdit"
    );
    assert.ok(result.mode_config.promptSuffix.includes("CODE-GEN"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersona: --files option focuses the sweep", async () => {
  const root = await makeTempRepo();
  try {
    await fsp.writeFile(
      path.join(root, "a.js"),
      "const run = (x) => eval(x);\n",
      "utf-8"
    );
    await fsp.writeFile(
      path.join(root, "b.js"),
      "const run = (x) => eval(x);\n",
      "utf-8"
    );
    const result = await runPersona({
      personaId: "security",
      mode: "audit",
      rootPath: root,
      files: ["a.js"],
    });
    // Findings list should reflect only a.js
    const hit = result.findings.find((f) => f.kind === "sast.eval");
    assert.ok(hit);
    assert.ok(hit.file.endsWith("a.js"));
    assert.ok(
      !result.findings.some((f) => f.kind === "sast.eval" && f.file.endsWith("b.js")),
      "b.js should not be scanned when --files filters to a.js"
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersona: default mode is audit", async () => {
  const root = await makeTempRepo();
  try {
    const result = await runPersona({ personaId: "testing", rootPath: root });
    assert.equal(result.mode, "audit");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runPersona: handles every supported persona id without crashing", async () => {
  const root = await makeTempRepo();
  try {
    for (const id of SUPPORTED_PERSONA_IDS) {
      const result = await runPersona({
        personaId: id,
        mode: "audit",
        rootPath: root,
      });
      assert.equal(result.personaId, id);
      assert.ok(Array.isArray(result.findings));
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
