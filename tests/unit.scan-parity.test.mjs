import test from "node:test";
import assert from "node:assert/strict";

import {
  SENTINELAYER_ACTION_REF,
  buildSecurityReviewWorkflow,
} from "../src/scan/generator.js";
import { resolveScanMode } from "../src/review/scan-modes.js";

const EXPECTED_FULL_DEPTH_PERSONAS = [
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
  "frontend",
  "documentation",
  "ai-governance",
];

const EXPECTED_DEEP_PERSONAS = EXPECTED_FULL_DEPTH_PERSONAS;

test("Unit scan parity: generated workflow uses v1-action contract modes and pinned ref", () => {
  const workflow = buildSecurityReviewWorkflow({
    profile: {
      scanMode: "baseline",
      severityGate: "P1",
      playwrightMode: "off",
      sbomMode: "off",
    },
  });

  assert.match(workflow, /scan_mode:/);
  assert.match(workflow, /- baseline/);
  assert.match(workflow, /- deep/);
  assert.match(workflow, /- audit/);
  assert.match(workflow, /- full-depth/);
  assert.match(workflow, new RegExp(`uses: ${SENTINELAYER_ACTION_REF}`));
  assert.match(workflow, /openai_api_key:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /google_api_key:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*\}\}/);
  assert.match(workflow, /llm_provider:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*!=\s*''\s*&&\s*'google'\s*\|\|\s*'openai'\s*\}\}/);
  assert.match(
    workflow,
    /sentinelayer_managed_llm:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*==\s*''\s*&&\s*secrets\.OPENAI_API_KEY\s*==\s*''\s*&&\s*secrets\.SENTINELAYER_TOKEN\s*!=\s*''\s*\}\}/,
  );
  assert.match(workflow, /model:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*!=\s*''\s*&&\s*'gemini-2\.5-pro'\s*\|\|\s*'gpt-5\.3-codex'\s*\}\}/);
  assert.match(
    workflow,
    /model_fallback:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*!=\s*''\s*&&\s*'gemini-2\.5-flash'\s*\|\|\s*'gpt-4\.1-mini'\s*\}\}/,
  );
  assert.match(workflow, /use_codex:\s*\$\{\{\s*secrets\.GOOGLE_API_KEY\s*==\s*''\s*\}\}/);
  assert.match(workflow, /codex_only:\s*"false"/);
  assert.match(workflow, /max_daily_scans:\s*\$\{\{\s*vars\.OMAR_MAX_DAILY_SCANS\s*\|\|\s*'200'\s*\}\}/);
  assert.match(
    workflow,
    /min_scan_interval_minutes:\s*\$\{\{\s*vars\.OMAR_MIN_SCAN_INTERVAL_MINUTES\s*\|\|\s*'0'\s*\}\}/,
  );
  assert.match(workflow, /rate_limit_fail_mode:\s*closed/);
  assert.match(workflow, /Stage Omar summary artifact/);
  assert.match(workflow, /omar-artifacts\/summary\.json/);
  assert.match(workflow, /omar_gate_summary/);
  assert.match(workflow, /schema_version/);
  assert.match(workflow, /run_url/);
  assert.match(workflow, /'llm_provider': env\('OMAR_LLM_PROVIDER', 'openai'\)/);
  assert.match(workflow, /'model': env\('OMAR_MODEL', 'gpt-5\.3-codex'\)/);
  assert.match(workflow, /'model_fallback': env\('OMAR_MODEL_FALLBACK', 'gpt-4\.1-mini'\)/);
  assert.match(
    workflow,
    /'llm_route': 'google_api_key' if bool_env\('OMAR_GOOGLE_KEY_PRESENT'\) else \('openai_api_key' if bool_env\('OMAR_OPENAI_KEY_PRESENT'\) else 'sentinelayer_managed'\)/,
  );
  assert.match(workflow, /'google_key_present': bool_env\('OMAR_GOOGLE_KEY_PRESENT'\)/);
  assert.match(workflow, /'openai_key_present': bool_env\('OMAR_OPENAI_KEY_PRESENT'\)/);
  assert.match(workflow, /'managed_llm': bool_env\('OMAR_MANAGED_LLM'\)/);
  assert.match(workflow, /actions\/upload-artifact@50769540e7f4bd5e21e526ee35c689e35e0d6874/);
});

test("Unit scan parity: local baseline/deep/full-depth persona contracts are stable", () => {
  const baseline = resolveScanMode("baseline");
  const deep = resolveScanMode("deep");
  const fullDepth = resolveScanMode("full-depth");

  assert.equal(baseline.mode, "baseline");
  assert.deepEqual(baseline.personas, ["security"]);

  assert.equal(deep.mode, "deep");
  assert.deepEqual(deep.personas, EXPECTED_DEEP_PERSONAS);
  assert.equal(deep.personas.length, 13);

  assert.equal(fullDepth.mode, "full-depth");
  assert.deepEqual(fullDepth.personas, EXPECTED_FULL_DEPTH_PERSONAS);
  assert.equal(fullDepth.personas.length, 13);

  assert.deepEqual(deep.personas, fullDepth.personas, "deep must match full-depth from v0.7+");
});

test("Unit scan parity: local audit mode is alias of full-depth", () => {
  const audit = resolveScanMode("audit");
  const fullDepth = resolveScanMode("full-depth");

  assert.equal(audit.mode, "audit");
  assert.deepEqual(audit.personas, fullDepth.personas);
});
