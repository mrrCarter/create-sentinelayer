import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const classifier = path.join(repoRoot, "scripts", "ci", "classify_omar_provider_outage.py");

async function runClassifier(findings, runSummary = null) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "omar-provider-outage-"));
  const findingsPath = path.join(tempDir, "FINDINGS.jsonl");
  const outputPath = path.join(tempDir, "github-output.txt");
  await writeFile(
    findingsPath,
    findings.map((finding) => JSON.stringify(finding)).join("\n") + "\n",
    "utf8",
  );

  const args = [classifier, "--findings", findingsPath, "--github-output", outputPath];
  if (runSummary !== null) {
    const summaryPath = path.join(tempDir, "RUN_SUMMARY.json");
    await writeFile(summaryPath, `${JSON.stringify(runSummary, null, 2)}\n`, "utf8");
    args.push("--run-summary", summaryPath);
  }

  const result = spawnSync(
    "python",
    args,
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  const outputs = result.status === 0 ? await readFile(outputPath, "utf8") : "";
  return { result, outputs };
}

test("Unit Omar provider outage classifier: allows current action system LLM outage finding", async () => {
  const { result, outputs } = await runClassifier([
    {
      severity: "P0",
      category: "LLM Failure",
      provenance: "system",
      scope: { path: "<system>" },
      impact:
        "LLM analysis failed: primary failed and fallback failed; blocking merge per fail-closed policy. Provider outage detail: OpenAI 429 rate limit; Google 503 provider unavailable; Anthropic capacity exhausted.",
    },
    {
      severity: "P3",
      category: "secrets",
      provenance: "deterministic",
      scope: { path: "tests/example.test.mjs" },
      impact: "Advisory historical entropy.",
    },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=true/);
  assert.match(outputs, /reason=single_system_llm_provider_outage/);
});

test("Unit Omar provider outage classifier: rejects provider account-credit and auth failures", async () => {
  const { result, outputs } = await runClassifier([
    {
      severity: "P0",
      category: "LLM Failure",
      provenance: "system",
      scope: { path: "<system>" },
      impact:
        "LLM analysis failed: primary failed and fallback failed; blocking merge per fail-closed policy. Provider outage detail: Provider attempts: openai/gpt-5.3-codex: failed (openai_quota_exceeded - OpenAI managed Omar call failed: Error code: 429 - insufficient_quota); google/gemini-2.5-flash: failed (google_error - Google managed Omar call failed: HTTP 403 - consumer_suspended); anthropic/claude-sonnet-4-6: failed (anthropic_error - Anthropic managed Omar call failed: Error code: 400 - credit balance is too low. Please purchase credits.)",
    },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=false/);
  assert.match(outputs, /reason=llm_failure_provider_account_denied_not_outage/);
});

test("Unit Omar provider outage classifier: rejects managed billing-denied run with no findings", async () => {
  const { result, outputs } = await runClassifier([], {
    status: "failed",
    progress: "failed:billing-denied",
    gate_status: "error",
    backend_findings_count: 0,
    local_findings_count: 0,
    counts: {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
    },
    llm_policy: {
      sentinelayer_managed_llm: true,
      llm_failure_policy: "block",
      model: "gpt-5.3-codex",
      model_fallback: "gemini-2.5-flash",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=false/);
  assert.match(outputs, /reason=managed_billing_denied_not_provider_outage/);
});

test("Unit Omar provider outage classifier: rejects empty non-billing managed errors", async () => {
  const { result, outputs } = await runClassifier([], {
    status: "failed",
    progress: "failed:policy-denied",
    gate_status: "error",
    backend_findings_count: 0,
    local_findings_count: 0,
    counts: {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
    },
    llm_policy: {
      sentinelayer_managed_llm: true,
      llm_failure_policy: "block",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=false/);
  assert.match(outputs, /reason=expected_exactly_one_p0_llm_failure/);
});

test("Unit Omar provider outage classifier: rejects billing-denied summaries with findings", async () => {
  const { result, outputs } = await runClassifier([], {
    status: "failed",
    progress: "failed:billing-denied",
    gate_status: "error",
    backend_findings_count: 1,
    local_findings_count: 0,
    counts: {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
    },
    llm_policy: {
      sentinelayer_managed_llm: true,
      llm_failure_policy: "block",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=false/);
  assert.match(outputs, /reason=expected_exactly_one_p0_llm_failure/);
});

test("Unit Omar provider outage classifier: allows legacy API finding shape", async () => {
  const { result, outputs } = await runClassifier([
    {
      severity: "P0",
      category: "LLM Failure",
      source: "system",
      file_path: "<system>",
      message:
        "LLM analysis failed: Primary failed: quota. Fallback failed: provider unavailable. Blocking merge per fail-closed policy.",
    },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=true/);
});

test("Unit Omar provider outage classifier: rejects code P0", async () => {
  const { result, outputs } = await runClassifier([
    {
      severity: "P0",
      category: "security",
      provenance: "deterministic",
      scope: { path: "src/app.js" },
      impact: "Remote code execution.",
    },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=false/);
  assert.match(outputs, /reason=p0_is_not_system_llm_failure/);
});

test("Unit Omar provider outage classifier: rejects additional blocking findings", async () => {
  const { result, outputs } = await runClassifier([
    {
      severity: "P0",
      category: "LLM Failure",
      provenance: "system",
      scope: { path: "<system>" },
      impact:
        "LLM analysis failed: primary failed and fallback failed; blocking merge per fail-closed policy. Provider outage detail: quota.",
    },
    {
      severity: "P2",
      category: "security",
      provenance: "deterministic",
      scope: { path: "src/app.js" },
      impact: "Medium severity code issue.",
    },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=false/);
  assert.match(outputs, /reason=blocking_non_p0_findings_present/);
});

test("Unit Omar provider outage classifier: rejects non-capacity LLM failures", async () => {
  const { result, outputs } = await runClassifier([
    {
      severity: "P0",
      category: "LLM Failure",
      provenance: "system",
      scope: { path: "<system>" },
      impact:
        "LLM analysis failed: primary failed and fallback failed; blocking merge per fail-closed policy. Provider outage detail: invalid prompt contract.",
    },
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(outputs, /provider_outage_break_glass=false/);
  assert.match(outputs, /reason=llm_failure_not_provider_capacity_class/);
});
