// Unit tests for Amina's ai-governance domain tools (#A24).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AI_GOVERNANCE_TOOLS,
  AI_GOVERNANCE_TOOL_IDS,
  dispatchAiGovernanceTool,
  runAllAiGovernanceTools,
  runEvalRegression,
  runHitlAudit,
  runProvenanceCheck,
  runPromptDrift,
} from "../src/agents/ai-governance/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-ai-gov-"));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("AI_GOVERNANCE_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...AI_GOVERNANCE_TOOL_IDS].sort(), [
    "eval-regression",
    "hitl-audit",
    "prompt-drift",
    "provenance-check",
  ]);
});

test("eval-regression: advises when LLM usage without eval suite", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/ai.js", "import OpenAI from 'openai';\nexport const cl = new OpenAI();\n");
    const findings = await runEvalRegression({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "ai-governance.no-eval-suite"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("eval-regression: suppresses when evals/ dir exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/ai.js", "import OpenAI from 'openai';\n");
    await writeFile(root, "evals/basic.json", "[]\n");
    const findings = await runEvalRegression({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("prompt-drift: flags prompt file without version header", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "prompts/system.md", "You are a helpful assistant.\n");
    const findings = await runPromptDrift({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "ai-governance.unversioned-prompt"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("prompt-drift: suppresses when version present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "prompts/system.md", "---\nversion: 1.0.0\n---\nYou are helpful.\n");
    const findings = await runPromptDrift({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hitl-audit: flags LLM + destructive action without approval", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "bot.js",
      `import { Messages } from 'anthropic-sdk';\nawait Messages.create({});\nimport fs from 'fs';\nfs.unlinkSync('/tmp/foo');\n`
    );
    const findings = await runHitlAudit({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "ai-governance.no-hitl"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hitl-audit: suppresses when approval gate exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "bot.js",
      `import { Messages } from 'anthropic-sdk';\nawait Messages.create({});\nawait humanReview(plan);\nimport fs from 'fs';\nfs.unlinkSync('/tmp/foo');\n`
    );
    const findings = await runHitlAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("provenance-check: flags generateContent without provenance", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "api.js", `export async function send() {\n  const text = await generateContent({});\n  return text;\n}\n`);
    const findings = await runProvenanceCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "ai-governance.no-provenance"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("provenance-check: suppresses when ai-generated header present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `export async function send() {\n  const text = await generateContent({});\n  return { text, 'x-ai-generated': true };\n}\n`
    );
    const findings = await runProvenanceCheck({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllAiGovernanceTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/ai.js", "import OpenAI from 'openai';\n");
    const findings = await runAllAiGovernanceTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("eval-regression"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dispatchAiGovernanceTool: unknown id throws", async () => {
  await assert.rejects(() => dispatchAiGovernanceTool("x", {}), /Unknown ai-governance tool/);
});

test("AI_GOVERNANCE_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of AI_GOVERNANCE_TOOL_IDS) {
    const t = AI_GOVERNANCE_TOOLS[toolId];
    assert.equal(t.id, toolId);
    assert.ok(t.description.length > 10);
    assert.equal(typeof t.handler, "function");
  }
});
