import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("Unit Omar workflow: managed LLM keeps Omar in fail-closed direct-action mode", async () => {
  const workflowText = await readFile(path.join(repoRoot, ".github", "workflows", "omar-gate.yml"), "utf8");

  assert.doesNotMatch(workflowText, /Validate Google key secret for Omar LLM scan/);
  assert.doesNotMatch(workflowText, /google_api_key:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*\}\}/);
  assert.match(workflowText, /uses:\s*mrrCarter\/sentinelayer-v1-action@4cb3063e04e3b899981b25f6918b26f70d35a8d4/);
  assert.doesNotMatch(workflowText, /uses:\s*\.\/\.github\/actions\/omar-gate/);
  assert.doesNotMatch(workflowText, /llm_provider:/);
  assert.doesNotMatch(workflowText, /google_api_key:/);
  assert.doesNotMatch(workflowText, /openai_api_key:/);
  assert.match(workflowText, /sentinelayer_managed_llm:\s*"true"/);
  assert.match(workflowText, /model:\s*gpt-5\.3-codex/);
  assert.match(workflowText, /model_fallback:\s*gpt-4\.1-mini/);
  assert.match(workflowText, /use_codex:\s*"true"/);
  assert.doesNotMatch(workflowText, /sentinelayer_managed_llm:\s*"false"/);
  assert.doesNotMatch(workflowText, /issues:\s*write/);
  assert.match(workflowText, /Validate Omar workflow contract/);
  assert.match(workflowText, /check_omar_workflow_contract\.py --self-test/);
  assert.match(workflowText, /python3 scripts\/ci\/check_omar_workflow_contract\.py/);
  assert.doesNotMatch(workflowText, /wait_for_authoritative_omar_review\.py/);
  assert.doesNotMatch(workflowText, /Wait for authoritative Omar Gate review surface/);
  assert.doesNotMatch(workflowText, /--summary-out\s+\/tmp\/omar-authoritative\/summary\.json/);
  assert.doesNotMatch(workflowText, new RegExp("--upsert" + "-comment"));
  assert.doesNotMatch(workflowText, /sentinelayer-omar-summary/);
  assert.match(workflowText, /Stage Omar artifacts/);
  assert.match(workflowText, /Upload Omar artifacts/);
  assert.match(workflowText, /actions\/upload-artifact/);
  assert.match(workflowText, /omar-artifacts\/\*\*/);
  assert.match(workflowText, /omar_enforce:[\s\S]*if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(workflowText, /Require selected Omar scan success/);
  assert.match(workflowText, /Trusted Omar scan did not succeed/);
  assert.match(workflowText, /Untrusted Omar scan did not succeed/);
  assert.ok(
    workflowText.indexOf("Validate Omar workflow contract") < workflowText.indexOf("Run Omar Gate"),
    "workflow contract validation should run before Omar consumes scan quota",
  );
});
