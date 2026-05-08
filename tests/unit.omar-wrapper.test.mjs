import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("Unit Omar wrapper: BYO Gemini key keeps Omar in fail-closed LLM mode without managed proxy", async () => {
  const workflowText = await readFile(path.join(repoRoot, ".github", "workflows", "omar-gate.yml"), "utf8");
  const wrapperText = await readFile(path.join(repoRoot, ".github", "actions", "omar-gate", "action.yml"), "utf8");

  assert.match(workflowText, /Validate Google key secret for Omar LLM scan/);
  assert.match(workflowText, /google_api_key:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*\}\}/);
  assert.match(wrapperText, /llm_provider:\s*google/);
  assert.match(wrapperText, /google_api_key:\s*\$\{\{\s*inputs\.google_api_key\s*\}\}/);
  assert.match(wrapperText, /sentinelayer_managed_llm:\s*"false"/);
  assert.match(wrapperText, /model:\s*gemini-2\.5-pro/);
  assert.match(wrapperText, /model_fallback:\s*gemini-2\.5-flash/);
  assert.match(wrapperText, /use_codex:\s*"false"/);
  assert.doesNotMatch(wrapperText, /sentinelayer_managed_llm:\s*"true"/);
});
