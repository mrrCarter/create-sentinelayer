import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("Unit Omar workflow: real LLM route keeps Omar in fail-closed direct-action mode", async () => {
  const workflowText = await readFile(path.join(repoRoot, ".github", "workflows", "omar-gate.yml"), "utf8");

  assert.doesNotMatch(workflowText, /Validate Google key secret for Omar LLM scan/);
  assert.match(workflowText, /uses:\s*mrrCarter\/sentinelayer-v1-action@03d7369cba7de2e9f15b959275c982111f0ee493/);
  assert.doesNotMatch(workflowText, /uses:\s*\.\/\.github\/actions\/omar-gate/);
  assert.match(workflowText, /openai_api_key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(
    workflowText,
    /google_api_key:\s*\$\{\{\s*secrets\.GOOGLE_GEMINI_API_KEY\s*!=\s*''\s*&&\s*secrets\.GOOGLE_GEMINI_API_KEY\s*\|\|\s*secrets\.GOOGLE_API_KEY\s*\}\}/,
  );
  assert.match(
    workflowText,
    /llm_provider:\s*\$\{\{\s*\(secrets\.GOOGLE_GEMINI_API_KEY\s*!=\s*''\s*\|\|\s*secrets\.GOOGLE_API_KEY\s*!=\s*''\)\s*&&\s*'google'\s*\|\|\s*'openai'\s*\}\}/,
  );
  assert.match(
    workflowText,
    /sentinelayer_managed_llm:\s*\$\{\{\s*secrets\.GOOGLE_GEMINI_API_KEY\s*==\s*''\s*&&\s*secrets\.GOOGLE_API_KEY\s*==\s*''\s*&&\s*secrets\.OPENAI_API_KEY\s*==\s*''\s*&&\s*steps\.resolve_omar_credentials\.outputs\.sentinelayer_token\s*!=\s*''\s*\}\}/,
  );
  assert.match(
    workflowText,
    /model:\s*\$\{\{\s*\(secrets\.GOOGLE_GEMINI_API_KEY\s*!=\s*''\s*\|\|\s*secrets\.GOOGLE_API_KEY\s*!=\s*''\)\s*&&\s*'gemini-3\.1-flash-lite'\s*\|\|\s*'gpt-5\.3-codex'\s*\}\}/,
  );
  assert.match(workflowText, /codex_model:\s*gpt-5\.3-codex/);
  assert.match(
    workflowText,
    /model_fallback:\s*\$\{\{\s*\(secrets\.GOOGLE_GEMINI_API_KEY\s*!=\s*''\s*\|\|\s*secrets\.GOOGLE_API_KEY\s*!=\s*''\)\s*&&\s*'gemini-3\.1-flash-lite'\s*\|\|\s*'gpt-4\.1-mini'\s*\}\}/,
  );
  assert.match(
    workflowText,
    /use_codex:\s*\$\{\{\s*secrets\.GOOGLE_GEMINI_API_KEY\s*==\s*''\s*&&\s*secrets\.GOOGLE_API_KEY\s*==\s*''\s*\}\}/,
  );
  assert.match(workflowText, /codex_only:\s*"false"/);
  assert.match(workflowText, /max_daily_scans:\s*\$\{\{\s*vars\.OMAR_MAX_DAILY_SCANS\s*\|\|\s*'200'\s*\}\}/);
  assert.match(
    workflowText,
    /min_scan_interval_minutes:\s*\$\{\{\s*vars\.OMAR_MIN_SCAN_INTERVAL_MINUTES\s*\|\|\s*'0'\s*\}\}/,
  );
  assert.match(workflowText, /rate_limit_fail_mode:\s*closed/);
  assert.doesNotMatch(workflowText, /sentinelayer_managed_llm:\s*"false"/);
  assert.doesNotMatch(workflowText, /sentinelayer_managed_llm:\s*"true"/);
  assert.doesNotMatch(workflowText, /issues:\s*write/);
  assert.match(workflowText, /Validate Omar workflow contract/);
  assert.match(workflowText, /Verify managed Omar token secret/);
  assert.match(workflowText, /Assert Omar LLM contract is active/);
  assert.match(workflowText, /check_omar_workflow_contract\.py --self-test/);
  assert.match(workflowText, /check_forbidden_omar_surface\.py --self-test/);
  assert.match(workflowText, /python3 scripts\/ci\/check_forbidden_omar_surface\.py/);
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
  assert.match(workflowText, /"llm_provider": env\("OMAR_LLM_PROVIDER", "openai"\)/);
  assert.match(workflowText, /"model": env\("OMAR_MODEL", "gpt-5\.3-codex"\)/);
  assert.match(workflowText, /"model_fallback": env\("OMAR_MODEL_FALLBACK", "gpt-4\.1-mini"\)/);
  assert.match(
    workflowText,
    /"llm_route": "google_api_key" if bool_env\("OMAR_GOOGLE_KEY_PRESENT"\) else \("openai_api_key" if bool_env\("OMAR_OPENAI_KEY_PRESENT"\) else "sentinelayer_managed"\)/,
  );
  assert.match(workflowText, /"google_key_present": bool_env\("OMAR_GOOGLE_KEY_PRESENT"\)/);
  assert.match(workflowText, /"openai_key_present": bool_env\("OMAR_OPENAI_KEY_PRESENT"\)/);
  assert.match(workflowText, /"managed_llm": bool_env\("OMAR_MANAGED_LLM"\)/);
  assert.match(workflowText, /omar_enforce:[\s\S]*if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.match(workflowText, /Require selected Omar scan success/);
  assert.match(workflowText, /Trusted Omar scan did not succeed/);
  assert.match(workflowText, /Untrusted Omar scan did not succeed/);
  assert.ok(
    workflowText.indexOf("Validate Omar workflow contract") < workflowText.indexOf("Run Omar Gate"),
    "workflow contract validation should run before Omar consumes scan quota",
  );
});
