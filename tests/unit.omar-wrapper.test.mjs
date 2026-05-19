import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("Unit Omar wrapper: managed LLM keeps Omar in fail-closed full-action mode", async () => {
  const workflowText = await readFile(path.join(repoRoot, ".github", "workflows", "omar-gate.yml"), "utf8");
  const wrapperText = await readFile(path.join(repoRoot, ".github", "actions", "omar-gate", "action.yml"), "utf8");

  assert.doesNotMatch(workflowText, /Validate Google key secret for Omar LLM scan/);
  assert.doesNotMatch(workflowText, /google_api_key:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*\}\}/);
  assert.doesNotMatch(wrapperText, /llm_provider:/);
  assert.doesNotMatch(wrapperText, /google_api_key:/);
  assert.doesNotMatch(wrapperText, /openai_api_key:/);
  assert.match(wrapperText, /sentinelayer_managed_llm:\s*"true"/);
  assert.match(wrapperText, /model:\s*gpt-5\.3-codex/);
  assert.match(wrapperText, /model_fallback:\s*gpt-4\.1-mini/);
  assert.match(wrapperText, /use_codex:\s*"true"/);
  assert.doesNotMatch(wrapperText, /sentinelayer_managed_llm:\s*"false"/);
});
