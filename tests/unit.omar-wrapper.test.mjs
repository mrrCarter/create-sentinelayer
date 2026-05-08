import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("Unit Omar wrapper: BYO OpenAI key is not forced through managed LLM proxy", async () => {
  const workflowText = await readFile(path.join(repoRoot, ".github", "workflows", "omar-gate.yml"), "utf8");
  const wrapperText = await readFile(path.join(repoRoot, ".github", "actions", "omar-gate", "action.yml"), "utf8");

  assert.match(workflowText, /Validate OpenAI key secret for Omar LLM scan/);
  assert.match(workflowText, /openai_api_key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(wrapperText, /openai_api_key:\s*\$\{\{\s*inputs\.openai_api_key\s*\}\}/);
  assert.match(wrapperText, /sentinelayer_managed_llm:\s*"false"/);
  assert.doesNotMatch(wrapperText, /sentinelayer_managed_llm:\s*"true"/);
});
