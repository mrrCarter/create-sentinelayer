import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  PINNED_ACTION_REF,
  PINNED_ACTION_SHA,
  VALIDATOR_LIMITS,
  computePinnedActionIdempotencyKey,
  validateOmarActionEvidence,
} from "../src/scan/omar-action-evidence-validator.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.dirname(TESTS_DIR);
const VALIDATOR_PATH = path.join(
  REPOSITORY_ROOT,
  "src",
  "scan",
  "omar-action-evidence-validator.mjs",
);
const FIXTURE_ROOT = path.join(
  TESTS_DIR,
  "fixtures",
  "sentinelayer-v1-action-52fe9cf",
);
const SUBJECT_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const RUN_ID = "run-1234";
const GITHUB_RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const PULL_REQUEST_NUMBER = "42";
const REPOSITORY = "owner/repo";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/omar-gate.yml@refs/heads/main`;
const COMMENT_TAG = `omar-gate-${GITHUB_RUN_ID}-${RUN_ATTEMPT}`;

const EXPECTED_ACTION_INPUTS = [
  "openai_api_key",
  "llm_provider",
  "anthropic_api_key",
  "google_api_key",
  "xai_api_key",
  "github_token",
  "pr_number",
  "comment_tag",
  "publish_github",
  "sentinelayer_token",
  "sentinelayer_spec_id",
  "sentinelayer_managed_llm",
  "telemetry_tier",
  "telemetry",
  "share_metadata",
  "share_artifacts",
  "training_opt_in",
  "scan_mode",
  "severity_gate",
  "model",
  "model_fallback",
  "llm_failure_policy",
  "use_codex",
  "codex_only",
  "codex_model",
  "codex_timeout",
  "run_harness",
  "pip_audit_ignore_ids",
  "max_daily_scans",
  "min_scan_interval_minutes",
  "rate_limit_fail_mode",
  "max_input_tokens",
  "require_cost_confirmation",
  "approval_mode",
  "approval_label",
  "fork_policy",
  "run_deterministic_fix",
  "run_llm_fix",
  "auto_commit_fixes",
  "policy_pack",
  "policy_pack_version",
];

const EXPECTED_ACTION_OUTPUTS = [
  "gate_status",
  "p0_count",
  "p1_count",
  "p2_count",
  "p3_count",
  "run_id",
  "findings_artifact",
  "pack_summary_artifact",
  "ingest_artifact",
  "codebase_ingest_artifact",
  "codebase_ingest_summary_artifact",
  "codebase_ingest_summary_md_artifact",
  "review_brief_artifact",
  "audit_report_artifact",
  "estimated_cost_usd",
  "idempotency_key",
  "scan_mode",
  "severity_gate",
  "llm_provider",
  "model",
  "model_fallback",
  "model_fallback_used",
  "llm_attempted",
  "llm_success",
  "llm_output_valid",
  "llm_no_findings_reported",
  "llm_findings_count",
  "llm_parse_error_count",
  "llm_failure_class",
  "policy_pack",
  "policy_pack_version",
];

function gitBlobId(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeFinding(severity = "P2", index = 1) {
  return {
    id: `finding-${index}`,
    severity,
    category: "testing",
    file_path: "src/example.mjs",
    line_start: index,
    line_end: index,
    message: "A validated finding",
    recommendation: "Apply the recommended fix.",
    confidence: 0.9,
    source: "llm",
    fingerprint: index.toString(16).padStart(32, "0"),
  };
}

function severityCounts(findings) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    if (Object.hasOwn(counts, finding.severity)) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

async function createEvidenceCase(
  t,
  {
    findings = [],
    reportedFindingCount,
    eventName = "pull_request",
    pullRequestNumber,
  } = {},
) {
  const effectivePullRequestNumber =
    pullRequestNumber ?? (eventName === "pull_request" ? PULL_REQUEST_NUMBER : "0");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "omar-action-evidence-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const runDir = path.join(workspace, ".sentinelayer", "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  const findingsPath = path.join(runDir, "FINDINGS.jsonl");
  const packPath = path.join(runDir, "PACK_SUMMARY.json");
  const findingsText = findings.map((finding) => JSON.stringify(finding)).join("\n");
  const findingsBytes = Buffer.from(findingsText ? `${findingsText}\n` : "", "utf8");
  await writeFile(findingsPath, findingsBytes);

  const counts = severityCounts(findings);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const reported = reportedFindingCount ?? findings.length;
  const idempotencyKey = computePinnedActionIdempotencyKey({
    repository: REPOSITORY,
    pullRequestNumber: effectivePullRequestNumber,
    headSha: SUBJECT_SHA,
    scanMode: "deep",
    policyPack: "omar",
    policyPackVersion: "v1",
    commentTag: COMMENT_TAG,
  });
  const pack = {
    schema_version: "1.0",
    run_id: RUN_ID,
    writer_complete: true,
    counts: { ...counts, total },
    findings_file: "FINDINGS.jsonl",
    findings_file_sha256: sha256(findingsBytes),
    fingerprint_count: findings.length,
    dedupe_key: idempotencyKey,
    scan_mode: "deep",
    policy_pack: "omar",
    policy_pack_version: "v1",
    llm_usage: {
      engine: "codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      route: "codex_cli",
      tokens_in: 200,
      tokens_out: 50,
      latency_ms: 125,
    },
    llm_evidence: {
      schema_version: "1.0",
      attempted: true,
      success: true,
      output_valid: true,
      no_findings_reported: reported === 0,
      reported_finding_count: reported,
      accepted_finding_count: reported,
      parse_error_count: 0,
      failure_class: null,
      usage_recorded: true,
      engine: "codex",
      provider: "openai",
      model: "gpt-5.3-codex",
      route: "codex_cli",
      latency_ms: 125,
    },
  };
  const manifest = {
    schema_version: "1.0",
    action: {
      ref: PINNED_ACTION_REF,
      outcome: "success",
      gate_status: "passed",
      run_id: RUN_ID,
      p0_count: String(counts.P0),
      p1_count: String(counts.P1),
      p2_count: String(counts.P2),
      p3_count: String(counts.P3),
      findings_artifact: `.sentinelayer/runs/${RUN_ID}/FINDINGS.jsonl`,
      pack_summary_artifact: `.sentinelayer/runs/${RUN_ID}/PACK_SUMMARY.json`,
      llm_attempted: "true",
      llm_success: "true",
      llm_output_valid: "true",
      llm_no_findings_reported: String(reported === 0),
      llm_findings_count: String(reported),
      llm_parse_error_count: "0",
      llm_failure_class: "",
      scan_mode: "deep",
      policy_pack: "omar",
      policy_pack_version: "v1",
      idempotency_key: idempotencyKey,
    },
    provenance: {
      subject_sha: SUBJECT_SHA,
      workflow_sha: WORKFLOW_SHA,
      workflow_ref: WORKFLOW_REF,
      workflow_file_sha256: "c".repeat(64),
      validator_sha256: "d".repeat(64),
      repository: REPOSITORY,
      event_name: eventName,
      github_run_id: GITHUB_RUN_ID,
      github_run_attempt: RUN_ATTEMPT,
      pull_request_number: effectivePullRequestNumber,
      comment_tag: COMMENT_TAG,
    },
  };
  const options = {
    workspaceRoot: workspace,
    expectedSubjectSha: SUBJECT_SHA,
    expectedWorkflowSha: WORKFLOW_SHA,
    expectedWorkflowRef: WORKFLOW_REF,
  };
  const writePack = async () => {
    await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  };
  await writePack();
  return {
    workspace,
    runDir,
    findingsPath,
    packPath,
    findingsBytes,
    pack,
    manifest,
    options,
    writePack,
  };
}

async function expectValidationCode(context, expectedCode) {
  await assert.rejects(
    validateOmarActionEvidence(context.manifest, context.options),
    (error) => {
      assert.equal(error.code, expectedCode);
      assert.doesNotMatch(error.message, /secret|token|api[_-]?key/i);
      return true;
    },
  );
}

test("pinned Action fixtures preserve exact blobs and declared interface", async () => {
  const actionBytes = await readFile(path.join(FIXTURE_ROOT, "action.yml"));
  const modelsBytes = await readFile(path.join(FIXTURE_ROOT, "models.py"));
  assert.equal(gitBlobId(actionBytes), "c6367f205c8407ca9cbbc14b081206276a81ae6b");
  assert.equal(gitBlobId(modelsBytes), "bc7fbaba93353f46fbbc732bd56cae33204b96c1");

  const action = YAML.parse(actionBytes.toString("utf8"));
  assert.deepEqual(Object.keys(action.inputs), EXPECTED_ACTION_INPUTS);
  assert.deepEqual(Object.keys(action.outputs), EXPECTED_ACTION_OUTPUTS);
  assert.equal(action.outputs.idempotency_key.value, "${{ steps.omar.outputs.idempotency_key }}");
  for (const retired of ["playwright_mode", "sbom_mode", "wait_for_completion"]) {
    assert.equal(Object.hasOwn(action.inputs, retired), false);
  }

  const models = modelsBytes.toString("utf8");
  const match = models.match(/ScanMode\s*=\s*Literal\[([^\]]+)\]/u);
  assert.ok(match);
  assert.deepEqual(
    [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]),
    ["pr-diff", "deep", "nightly"],
  );
});

test("valid explicit-clean evidence emits a deterministic sanitized summary", async (t) => {
  const context = await createEvidenceCase(t);
  const first = await validateOmarActionEvidence(context.manifest, context.options);
  const second = await validateOmarActionEvidence(context.manifest, context.options);

  assert.deepEqual(second, first);
  assert.equal(first.validation_status, "passed");
  assert.equal(first.action.sha, PINNED_ACTION_SHA);
  assert.equal(first.action.idempotency_key, context.manifest.action.idempotency_key);
  assert.deepEqual(first.action.counts, { P0: 0, P1: 0, P2: 0, P3: 0 });
  assert.equal(first.live_evidence.no_findings_reported, true);
  assert.equal(first.live_evidence.provider, "openai");
  assert.equal(first.artifacts.pack_summary_path.includes(context.workspace), false);
  assert.equal(first.artifacts.findings_path.includes(context.workspace), false);
  assert.match(first.artifacts.pack_sha256, /^[0-9a-f]{64}$/u);
  assert.match(first.evidence_digest, /^[0-9a-f]{64}$/u);
  assert.equal(first.provenance.workflow_ref, context.manifest.provenance.workflow_ref);
  assert.equal(
    first.provenance.workflow_file_sha256,
    context.manifest.provenance.workflow_file_sha256,
  );
  assert.equal(first.provenance.validator_sha256, context.manifest.provenance.validator_sha256);
});

test("valid live findings preserve counts without applying severity policy", async (t) => {
  const context = await createEvidenceCase(t, { findings: [makeFinding("P1")] });
  const summary = await validateOmarActionEvidence(context.manifest, context.options);
  assert.equal(summary.action.gate_status, "passed");
  assert.deepEqual(summary.action.counts, { P0: 0, P1: 1, P2: 0, P3: 0 });
  assert.equal(summary.live_evidence.no_findings_reported, false);
  assert.equal(summary.live_evidence.reported_finding_count, 1);
  assert.equal(summary.findings.fingerprint_count, 1);
});

test("manifest rejects unknown fields and non-string GitHub outputs", async (t) => {
  const unknown = await createEvidenceCase(t);
  unknown.manifest.action.requested_provider = "openai";
  await expectValidationCode(unknown, "KEYS_INVALID");

  const wrongType = await createEvidenceCase(t);
  wrongType.manifest.action.p0_count = 0;
  await expectValidationCode(wrongType, "TYPE_INVALID");
});

test("Action pin, step outcome, and gate status fail closed independently", async (t) => {
  const cases = [
    ["ref", "mrrCarter/sentinelayer-v1-action@main", "ACTION_REF_INVALID"],
    ["outcome", "failure", "ACTION_OUTCOME_INVALID"],
    ["gate_status", "blocked", "ACTION_GATE_INVALID"],
  ];
  for (const [field, value, code] of cases) {
    const context = await createEvidenceCase(t);
    context.manifest.action[field] = value;
    await expectValidationCode(context, code);
  }
});

test("all three Action liveness booleans must be canonical true outputs", async (t) => {
  for (const field of ["llm_attempted", "llm_success", "llm_output_valid"]) {
    const context = await createEvidenceCase(t);
    context.manifest.action[field] = "false";
    await expectValidationCode(context, "ACTION_LIVENESS_INVALID");
  }

  const malformed = await createEvidenceCase(t);
  malformed.manifest.action.llm_attempted = "TRUE";
  await expectValidationCode(malformed, "BOOLEAN_INVALID");
});

test("Action parse errors and contradictory result shape block", async (t) => {
  const parseErrors = await createEvidenceCase(t);
  parseErrors.manifest.action.llm_parse_error_count = "1";
  await expectValidationCode(parseErrors, "ACTION_PARSE_ERRORS");

  const resultShape = await createEvidenceCase(t);
  resultShape.manifest.action.llm_no_findings_reported = "false";
  await expectValidationCode(resultShape, "ACTION_RESULT_SHAPE_INVALID");

  const failureClass = await createEvidenceCase(t);
  failureClass.manifest.action.llm_failure_class = "provider_error";
  await expectValidationCode(failureClass, "ACTION_FAILURE_CONTRADICTION");
});

test("pack writer, liveness, usage, parse, and result shape fail closed", async (t) => {
  const wrongPackSchema = await createEvidenceCase(t);
  wrongPackSchema.pack.schema_version = "0.9";
  await wrongPackSchema.writePack();
  await expectValidationCode(wrongPackSchema, "PACK_SCHEMA_INVALID");

  const wrongEvidenceSchema = await createEvidenceCase(t);
  wrongEvidenceSchema.pack.llm_evidence.schema_version = "0.9";
  await wrongEvidenceSchema.writePack();
  await expectValidationCode(wrongEvidenceSchema, "EVIDENCE_SCHEMA_INVALID");

  const incomplete = await createEvidenceCase(t);
  incomplete.pack.writer_complete = false;
  await incomplete.writePack();
  await expectValidationCode(incomplete, "PACK_INCOMPLETE");

  for (const field of ["attempted", "success", "output_valid", "usage_recorded"]) {
    const liveness = await createEvidenceCase(t);
    liveness.pack.llm_evidence[field] = false;
    await liveness.writePack();
    await expectValidationCode(liveness, "PACK_LIVENESS_INVALID");
  }

  const parseErrors = await createEvidenceCase(t);
  parseErrors.pack.llm_evidence.parse_error_count = 1;
  await parseErrors.writePack();
  await expectValidationCode(parseErrors, "PACK_PARSE_ERRORS");

  const resultShape = await createEvidenceCase(t);
  resultShape.pack.llm_evidence.no_findings_reported = false;
  await resultShape.writePack();
  await expectValidationCode(resultShape, "PACK_RESULT_SHAPE_INVALID");
});

test("raw usage provider, model, and latency are mandatory observed evidence", async (t) => {
  const cases = [
    ["provider", "", "VALUE_UNSAFE"],
    ["model", "", "VALUE_UNSAFE"],
    ["latency_ms", 0, "USAGE_INVALID"],
  ];
  for (const [field, value, code] of cases) {
    const context = await createEvidenceCase(t);
    context.pack.llm_usage[field] = value;
    context.pack.llm_provider = "requested-openai";
    context.pack.model_used = "requested-model";
    await context.writePack();
    await expectValidationCode(context, code);
  }

  for (const field of ["engine", "provider", "model"]) {
    const context = await createEvidenceCase(t);
    context.pack.llm_evidence[field] = "";
    await context.writePack();
    await expectValidationCode(context, "VALUE_UNSAFE");
  }

  const derivedLatency = await createEvidenceCase(t);
  derivedLatency.pack.llm_evidence.latency_ms = 0;
  await derivedLatency.writePack();
  await expectValidationCode(derivedLatency, "LATENCY_INVALID");
});

test("requested settings cannot substitute for raw observed usage", async (t) => {
  const context = await createEvidenceCase(t);
  context.pack.llm_usage.provider = "";
  context.pack.llm_evidence.provider = "";
  context.pack.llm_provider = "openai";
  context.pack.model_used = "gpt-5.3-codex";
  context.pack.requested_credential_present = true;
  await context.writePack();
  await expectValidationCode(context, "VALUE_UNSAFE");
});

test("derived evidence must exactly agree with raw usage", async (t) => {
  const context = await createEvidenceCase(t);
  context.pack.llm_evidence.model = "gpt-4.1-mini";
  await context.writePack();
  await expectValidationCode(context, "USAGE_MISMATCH");
});

test("idempotency key is recomputed and bound to pack dedupe_key", async (t) => {
  const wrongInvocation = await createEvidenceCase(t);
  wrongInvocation.manifest.action.idempotency_key = "e".repeat(64);
  wrongInvocation.pack.dedupe_key = "e".repeat(64);
  await wrongInvocation.writePack();
  await expectValidationCode(wrongInvocation, "IDEMPOTENCY_KEY_INVALID");

  const wrongPack = await createEvidenceCase(t);
  wrongPack.pack.dedupe_key = "e".repeat(64);
  await wrongPack.writePack();
  await expectValidationCode(wrongPack, "IDEMPOTENCY_KEY_MISMATCH");

  const wrongTag = await createEvidenceCase(t);
  wrongTag.manifest.provenance.comment_tag = "omar-gate-reused";
  await expectValidationCode(wrongTag, "COMMENT_TAG_INVALID");

  const actionUuidTag = await createEvidenceCase(t);
  actionUuidTag.manifest.provenance.comment_tag =
    `omar-gate-${RUN_ID}-${RUN_ATTEMPT}`;
  await expectValidationCode(actionUuidTag, "COMMENT_TAG_INVALID");
});

test("event context binds GitHub run tags and pull request number semantics", async (t) => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    const context = await createEvidenceCase(t, { eventName });
    const summary = await validateOmarActionEvidence(context.manifest, context.options);
    assert.equal(summary.provenance.event_name, eventName);
    assert.equal(summary.provenance.pull_request_number, "0");
    assert.equal(summary.provenance.comment_tag, COMMENT_TAG);
  }

  const zeroPullRequest = await createEvidenceCase(t);
  zeroPullRequest.manifest.provenance.pull_request_number = "0";
  await expectValidationCode(zeroPullRequest, "PULL_REQUEST_NUMBER_INVALID");

  const positivePush = await createEvidenceCase(t, { eventName: "push" });
  positivePush.manifest.provenance.pull_request_number = "42";
  await expectValidationCode(positivePush, "PULL_REQUEST_NUMBER_INVALID");

  const nonCanonicalDispatch = await createEvidenceCase(t, {
    eventName: "workflow_dispatch",
  });
  nonCanonicalDispatch.manifest.provenance.pull_request_number = "00";
  await expectValidationCode(nonCanonicalDispatch, "PULL_REQUEST_NUMBER_INVALID");

  const unsupportedEvent = await createEvidenceCase(t, { eventName: "pull_request_target" });
  await expectValidationCode(unsupportedEvent, "EVENT_NAME_INVALID");
});

test("pinned idempotency algorithm normalizes and omits comment tags exactly", () => {
  const base =
    "owner/repo:42:" +
    `${SUBJECT_SHA}:deep:omar:v1:1:llm-evidence-v1`;
  const tagged = computePinnedActionIdempotencyKey({
    repository: "owner/repo",
    pullRequestNumber: "42",
    headSha: SUBJECT_SHA,
    scanMode: "deep",
    policyPack: "omar",
    policyPackVersion: "v1",
    commentTag: "  Omar Gate!!__Attempt---2  ",
  });
  assert.equal(tagged, sha256(Buffer.from(`${base}:omar-gate-__attempt-2`, "utf8")));
  const untagged = computePinnedActionIdempotencyKey({
    repository: "owner/repo",
    pullRequestNumber: "42",
    headSha: SUBJECT_SHA,
    scanMode: "deep",
    policyPack: "omar",
    policyPackVersion: "v1",
    commentTag: " --__ ",
  });
  assert.equal(untagged, sha256(Buffer.from(base, "utf8")));
  const defaults = computePinnedActionIdempotencyKey({
    repository: "owner/repo",
    pullRequestNumber: "42",
    headSha: SUBJECT_SHA,
    scanMode: "deep",
  });
  assert.equal(defaults, sha256(Buffer.from(base, "utf8")));
});

test("pack invocation metadata must match hosted Action outputs", async (t) => {
  const context = await createEvidenceCase(t);
  context.pack.scan_mode = "nightly";
  await context.writePack();
  await expectValidationCode(context, "PACK_INVOCATION_MISMATCH");
});

test("run id is bounded and must match the pack", async (t) => {
  const bounded = await createEvidenceCase(t);
  bounded.manifest.action.run_id = "a".repeat(129);
  await expectValidationCode(bounded, "RUN_ID_INVALID");

  const mismatched = await createEvidenceCase(t);
  mismatched.pack.run_id = "another-run";
  await mismatched.writePack();
  await expectValidationCode(mismatched, "RUN_ID_MISMATCH");
});

test("subject, workflow hash, and workflow ref require independent exact equality", async (t) => {
  const subject = await createEvidenceCase(t);
  subject.options.expectedSubjectSha = "f".repeat(40);
  await expectValidationCode(subject, "SUBJECT_SHA_MISMATCH");

  const workflow = await createEvidenceCase(t);
  workflow.options.expectedWorkflowSha = "f".repeat(40);
  await expectValidationCode(workflow, "WORKFLOW_SHA_MISMATCH");

  const workflowRef = await createEvidenceCase(t);
  workflowRef.options.expectedWorkflowRef =
    `${REPOSITORY}/.github/workflows/another.yml@refs/heads/main`;
  await expectValidationCode(workflowRef, "WORKFLOW_REF_MISMATCH");

  const customWorkflow = await createEvidenceCase(t);
  customWorkflow.manifest.provenance.workflow_ref =
    `${REPOSITORY}/.github/workflows/security-review.yml@refs/heads/main`;
  customWorkflow.options.expectedWorkflowRef = customWorkflow.manifest.provenance.workflow_ref;
  await validateOmarActionEvidence(customWorkflow.manifest, customWorkflow.options);

  const missing = await createEvidenceCase(t);
  delete missing.options.expectedWorkflowSha;
  await expectValidationCode(missing, "EXPECTED_PROVENANCE_REQUIRED");
});

test("artifact traversal and absolute paths outside the workspace are rejected", async (t) => {
  const traversal = await createEvidenceCase(t);
  traversal.manifest.action.findings_artifact =
    `.sentinelayer/runs/${RUN_ID}/../other/FINDINGS.jsonl`;
  await expectValidationCode(traversal, "ARTIFACT_TRAVERSAL");

  const absolute = await createEvidenceCase(t);
  absolute.manifest.action.findings_artifact = path.resolve(
    absolute.workspace,
    "..",
    "outside",
    "FINDINGS.jsonl",
  );
  await expectValidationCode(absolute, "ARTIFACT_ABSOLUTE");
});

test("symlinked findings cannot escape the canonical run root", async (t) => {
  const context = await createEvidenceCase(t);
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "omar-evidence-outside-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const outsideFindings = path.join(outsideDir, "FINDINGS.jsonl");
  await writeFile(outsideFindings, context.findingsBytes);
  await unlink(context.findingsPath);
  await symlink(outsideFindings, context.findingsPath, "file");
  await expectValidationCode(context, "ARTIFACT_SYMLINK");
});

test("Action findings path must equal the pack-resolved findings path", async (t) => {
  const context = await createEvidenceCase(t);
  const alternateDir = path.join(context.runDir, "alternate");
  await mkdir(alternateDir);
  await writeFile(path.join(alternateDir, "FINDINGS.jsonl"), context.findingsBytes);
  context.manifest.action.findings_artifact =
    `.sentinelayer/runs/${RUN_ID}/alternate/FINDINGS.jsonl`;
  await expectValidationCode(context, "FINDINGS_PATH_MISMATCH");
});

test("findings bytes must match the exact pack SHA-256", async (t) => {
  const context = await createEvidenceCase(t);
  await writeFile(context.findingsPath, "tampered\n", "utf8");
  await expectValidationCode(context, "FINDINGS_HASH_MISMATCH");
});

test("Action, pack, and parsed severity counts must agree", async (t) => {
  const outputMismatch = await createEvidenceCase(t);
  outputMismatch.manifest.action.p1_count = "1";
  await expectValidationCode(outputMismatch, "COUNT_MISMATCH");

  const severityMismatch = await createEvidenceCase(t, {
    findings: [makeFinding("P2")],
  });
  severityMismatch.manifest.action.p1_count = "1";
  severityMismatch.manifest.action.p2_count = "0";
  severityMismatch.pack.counts = { P0: 0, P1: 1, P2: 0, P3: 0, total: 1 };
  await severityMismatch.writePack();
  await expectValidationCode(severityMismatch, "SEVERITY_COUNT_MISMATCH");
});

test("finding metadata and pack fingerprint count are validated", async (t) => {
  const invalidFinding = await createEvidenceCase(t, {
    findings: [makeFinding("P2")],
  });
  const finding = makeFinding("P2");
  finding.fingerprint = "not-a-fingerprint";
  const bytes = Buffer.from(`${JSON.stringify(finding)}\n`, "utf8");
  await writeFile(invalidFinding.findingsPath, bytes);
  invalidFinding.pack.findings_file_sha256 = sha256(bytes);
  await invalidFinding.writePack();
  await expectValidationCode(invalidFinding, "FINDING_METADATA_INVALID");

  const fingerprintMismatch = await createEvidenceCase(t, {
    findings: [makeFinding("P2")],
  });
  fingerprintMismatch.pack.fingerprint_count = 0;
  await fingerprintMismatch.writePack();
  await expectValidationCode(fingerprintMismatch, "FINDING_METADATA_MISMATCH");
});

test("artifact size limits match the 64 MiB streaming retention contract", async (t) => {
  assert.equal(VALIDATOR_LIMITS.findings_bytes, 64 * 1024 * 1024);
  assert.equal(VALIDATOR_LIMITS.pack_summary_bytes, 2 * 1024 * 1024);

  const findings = await createEvidenceCase(t);
  await truncate(findings.findingsPath, VALIDATOR_LIMITS.findings_bytes + 1);
  await expectValidationCode(findings, "ARTIFACT_TOO_LARGE");

  const pack = await createEvidenceCase(t);
  await writeFile(
    pack.packPath,
    Buffer.alloc(VALIDATOR_LIMITS.pack_summary_bytes + 1, 0x20),
  );
  await expectValidationCode(pack, "ARTIFACT_TOO_LARGE");
});

test("findings record bounds are enforced before allocating or parsing records", async (t) => {
  const context = await createEvidenceCase(t);
  const newlineFlood = Buffer.alloc(VALIDATOR_LIMITS.findings_count + 1, 0x0a);
  await writeFile(context.findingsPath, newlineFlood);
  context.pack.findings_file_sha256 = sha256(newlineFlood);
  await context.writePack();

  await expectValidationCode(context, "COUNT_INVALID");

  const oversizedFinding = makeFinding("P2");
  oversizedFinding.message = "x".repeat(256 * 1024);
  const oversizedRecord = await createEvidenceCase(t, {
    findings: [oversizedFinding],
  });
  await expectValidationCode(oversizedRecord, "FINDINGS_JSONL_INVALID");

  const nestedFinding = makeFinding("P2");
  let nested = "leaf";
  for (let depth = 0; depth < 20; depth += 1) {
    nested = { nested };
  }
  nestedFinding.unknown_nested_metadata = nested;
  const deeplyNestedRecord = await createEvidenceCase(t, {
    findings: [nestedFinding],
  });
  await expectValidationCode(deeplyNestedRecord, "FINDING_STRUCTURE_INVALID");
});

function cliArguments(context, inputPath, summaryPath, githubOutputPath) {
  return [
    VALIDATOR_PATH,
    "--input",
    inputPath,
    "--summary-out",
    summaryPath,
    "--github-output",
    githubOutputPath,
    "--workspace-root",
    context.workspace,
    "--expected-subject-sha",
    SUBJECT_SHA,
    "--expected-workflow-sha",
    WORKFLOW_SHA,
    "--expected-workflow-ref",
    WORKFLOW_REF,
  ];
}

test("CLI writes the validated summary and safe GitHub outputs", async (t) => {
  const context = await createEvidenceCase(t, {
    findings: [makeFinding("P2")],
  });
  const inputPath = path.join(context.workspace, "manifest.json");
  const summaryPath = path.join(context.workspace, "validated.json");
  const githubOutputPath = path.join(context.workspace, "github-output.txt");
  await writeFile(inputPath, `${JSON.stringify(context.manifest)}\n`, "utf8");
  await writeFile(githubOutputPath, "preexisting=value\n", "utf8");

  const result = spawnSync(
    process.execPath,
    cliArguments(context, inputPath, summaryPath, githubOutputPath),
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");

  const stdoutSummary = JSON.parse(result.stdout);
  const fileSummary = JSON.parse(await readFile(summaryPath, "utf8"));
  assert.deepEqual(fileSummary, stdoutSummary);
  const githubOutput = await readFile(githubOutputPath, "utf8");
  assert.match(githubOutput, /^preexisting=value$/mu);
  for (const name of [
    "run_id",
    "gate_status",
    "p0_count",
    "p1_count",
    "p2_count",
    "p3_count",
    "pack_summary_path",
    "findings_path",
    "pack_sha256",
    "findings_sha256",
    "evidence_digest",
    "subject_sha",
    "workflow_sha",
  ]) {
    assert.match(githubOutput, new RegExp(`^${name}=.+$`, "mu"));
  }
  assert.match(githubOutput, /^gate_status=passed$/mu);
  assert.match(githubOutput, /^p2_count=1$/mu);
  assert.doesNotMatch(githubOutput, /[\r]/u);
});

test("CLI validation failure is nonzero and creates no partial success output", async (t) => {
  const context = await createEvidenceCase(t);
  const inputPath = path.join(context.workspace, "invalid-manifest.json");
  const summaryPath = path.join(context.workspace, "must-not-exist.json");
  const githubOutputPath = path.join(context.workspace, "github-output.txt");
  const untrustedValue = "provider-token-super-sensitive";
  context.manifest.action.outcome = untrustedValue;
  await writeFile(inputPath, `${JSON.stringify(context.manifest)}\n`, "utf8");
  await writeFile(githubOutputPath, "preexisting=value\n", "utf8");

  const result = spawnSync(
    process.execPath,
    cliArguments(context, inputPath, summaryPath, githubOutputPath),
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const error = JSON.parse(result.stderr);
  assert.equal(error.validation_status, "failed");
  assert.equal(error.error.code, "ACTION_OUTCOME_INVALID");
  assert.doesNotMatch(result.stderr, new RegExp(untrustedValue, "u"));
  await assert.rejects(access(summaryPath), { code: "ENOENT" });
  assert.equal(await readFile(githubOutputPath, "utf8"), "preexisting=value\n");
});

test("CLI output preflight failure does not create a summary", async (t) => {
  const context = await createEvidenceCase(t);
  const inputPath = path.join(context.workspace, "manifest.json");
  const summaryPath = path.join(context.workspace, "must-not-exist.json");
  const missingOutput = path.join(context.workspace, "missing", "github-output.txt");
  await writeFile(inputPath, `${JSON.stringify(context.manifest)}\n`, "utf8");

  const result = spawnSync(
    process.execPath,
    cliArguments(context, inputPath, summaryPath, missingOutput),
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "OUTPUT_DESTINATION_INVALID");
  await assert.rejects(access(summaryPath), { code: "ENOENT" });
});
