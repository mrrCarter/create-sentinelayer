import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { SENTINELAYER_ACTION_REF } from "../src/scan/generator.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "omar-gate.yml");
const actionFixturePath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "sentinelayer-v1-action-52fe9cf",
  "action.yml",
);
const UNSUPPORTED_ACTION_INPUTS = [
  "playwright_mode",
  "sbom_mode",
  "wait_for_completion",
  "artifact_name_suffix",
];

function collectSteps(workflow) {
  const collected = [];
  for (const [jobId, job] of Object.entries(workflow.jobs || {})) {
    for (const [stepIndex, step] of (job.steps || []).entries()) {
      collected.push({ jobId, stepIndex, step });
    }
  }
  return collected;
}

function requireStep(steps, predicate, message) {
  const found = steps.find(({ step }) => predicate(step));
  assert.ok(found, message);
  return found;
}

async function loadWorkflowContract() {
  const [workflowText, actionFixtureText] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(actionFixturePath, "utf8"),
  ]);
  return {
    workflowText,
    workflow: YAML.parse(workflowText),
    actionFixture: YAML.parse(actionFixtureText),
  };
}

test("Unit Omar workflow: root Action invocation is an exact declared subset", async () => {
  const { workflow, actionFixture } = await loadWorkflowContract();
  const steps = collectSteps(workflow);
  const actionEntries = steps.filter(({ step }) =>
    String(step.uses || "").includes("mrrCarter/sentinelayer-v1-action"),
  );
  assert.equal(actionEntries.length, 1);

  const actionStep = actionEntries[0].step;
  const declaredInputs = new Set(Object.keys(actionFixture.inputs));
  const generatedInputs = Object.keys(actionStep.with || {});

  assert.equal(actionStep.uses, SENTINELAYER_ACTION_REF);
  assert.equal(generatedInputs.every((inputName) => declaredInputs.has(inputName)), true);
  assert.deepEqual(
    generatedInputs.filter((inputName) => UNSUPPORTED_ACTION_INPUTS.includes(inputName)),
    [],
  );
  assert.equal(actionStep.with.publish_github, "false");
  assert.equal(actionStep.with.severity_gate, "none");
  assert.equal(actionStep.with.llm_failure_policy, "block");
  assert.equal(
    actionStep.with.comment_tag,
    "${{ format('omar-gate-{0}-{1}', github.run_id, github.run_attempt) }}",
  );
  assert.equal(actionStep["continue-on-error"], true);
  assert.deepEqual(
    workflow.on.workflow_dispatch.inputs.scan_mode.options,
    ["pr-diff", "deep", "nightly"],
  );
  assert.equal(
    workflow.jobs.omar_scan.outputs.idempotency_key,
    "${{ steps.omar_result.outputs.idempotency_key }}",
  );

  for (const { step } of actionEntries) {
    assert.notEqual(step.with.llm_failure_policy, "deterministic_only");
    assert.equal(Object.hasOwn(step.with, "artifact_name_suffix"), false);
  }
});

test("Unit Omar workflow: provenance and evidence validation precede severity authority", async () => {
  const { workflow } = await loadWorkflowContract();
  const trustedSteps = (workflow.jobs.omar_scan.steps || []).map((step, stepIndex) => ({
    jobId: "omar_scan",
    stepIndex,
    step,
  }));
  const checkoutEntry = requireStep(
    trustedSteps,
    (step) => String(step.uses || "").startsWith("actions/checkout@"),
    "trusted workflow must check out the exact reviewed subject",
  );
  const provenanceEntry = requireStep(
    trustedSteps,
    (step) => step.id === "provenance",
    "trusted workflow must bind independent provenance",
  );
  const actionEntry = requireStep(
    trustedSteps,
    (step) => step.id === "omar",
    "trusted workflow must invoke Omar",
  );
  const manifestEntry = requireStep(
    trustedSteps,
    (step) => step.id === "evidence_manifest",
    "trusted workflow must build a structured evidence manifest",
  );
  const validatorEntry = requireStep(
    trustedSteps,
    (step) => step.id === "omar_result",
    "trusted workflow must validate structured live evidence",
  );
  const artifactEntry = requireStep(
    trustedSteps,
    (step) => String(step.name || "").startsWith("Stage Omar artifacts"),
    "trusted workflow must retain validated original artifacts",
  );
  const scannerEntry = requireStep(
    trustedSteps,
    (step) => step.id === "artifact_secret_scan",
    "trusted workflow must scan staged evidence for secrets",
  );
  const uploadEntry = requireStep(
    trustedSteps,
    (step) => step.id === "artifact_upload",
    "trusted workflow must upload retained evidence",
  );
  const downloadEntry = requireStep(
    trustedSteps,
    (step) => step.id === "artifact_download",
    "trusted workflow must download the exact uploaded artifact",
  );
  const handoffEntry = requireStep(
    trustedSteps,
    (step) => step.id === "artifact_handoff",
    "trusted workflow must verify the sealed upload handoff",
  );
  const evidenceGateEntry = requireStep(
    trustedSteps,
    (step) => step.name === "Enforce validated Omar evidence",
    "trusted workflow must fail closed on invalid live evidence",
  );

  assert.equal(
    checkoutEntry.step.with.ref,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
  );
  assert.equal(checkoutEntry.step.with["persist-credentials"], false);
  assert.equal(provenanceEntry.step.env.WORKFLOW_SHA, "${{ github.workflow_sha }}");
  assert.match(provenanceEntry.step.run, /actual_subject_sha/);
  assert.match(provenanceEntry.step.run, /Checked-out Omar subject mismatch/);

  const evidenceOutputs = [
    "llm_attempted",
    "llm_success",
    "llm_output_valid",
    "llm_no_findings_reported",
    "llm_findings_count",
    "llm_parse_error_count",
    "llm_failure_class",
  ];
  const manifestValues = Object.values(manifestEntry.step.env || {});
  for (const outputName of evidenceOutputs) {
    assert.equal(
      manifestValues.includes("${{ steps.omar.outputs." + outputName + " || '' }}"),
      true,
      "manifest must consume " + outputName,
    );
  }
  assert.equal(
    manifestEntry.step.env.OMAR_PACK_SUMMARY_ARTIFACT,
    "${{ steps.omar.outputs.pack_summary_artifact || '' }}",
  );
  assert.equal(
    manifestEntry.step.env.OMAR_FINDINGS_ARTIFACT,
    "${{ steps.omar.outputs.findings_artifact || '' }}",
  );
  assert.equal(
    manifestEntry.step.env.OMAR_IDEMPOTENCY_KEY,
    "${{ steps.omar.outputs.idempotency_key || '' }}",
  );
  assert.equal(manifestEntry.step.env.OMAR_EVENT_NAME, "${{ github.event_name }}");
  assert.match(manifestEntry.step.run, /event_name: env\("OMAR_EVENT_NAME"\)/);

  assert.match(
    validatorEntry.step.run,
    /node\s+src\/scan\/omar-action-evidence-validator\.mjs/,
  );
  assert.match(validatorEntry.step.run, /--expected-subject-sha/);
  assert.match(validatorEntry.step.run, /--expected-workflow-sha/);
  assert.match(validatorEntry.step.run, /--expected-workflow-ref/);
  assert.match(validatorEntry.step.run, /--summary-out/);
  assert.match(validatorEntry.step.run, /--github-output/);
  assert.equal(validatorEntry.step["continue-on-error"], true);

  assert.equal(
    artifactEntry.step.env.OMAR_PACK_SUMMARY_PATH,
    "${{ steps.omar_result.outputs.pack_summary_path || '' }}",
  );
  assert.equal(
    artifactEntry.step.env.OMAR_FINDINGS_PATH,
    "${{ steps.omar_result.outputs.findings_path || '' }}",
  );
  assert.match(artifactEntry.step.run, /original\/PACK_SUMMARY\.json/);
  assert.match(artifactEntry.step.run, /original\/FINDINGS\.jsonl/);
  assert.match(artifactEntry.step.run, /staged_pack_sha256/);
  assert.match(artifactEntry.step.run, /staged_findings_sha256/);
  assert.match(scannerEntry.step.run, /scan-omar-artifacts\.js/);
  assert.match(scannerEntry.step.run, /--manifest/);
  assert.match(scannerEntry.step.run, /--expected-manifest/);
  assert.match(scannerEntry.step.run, /archive-files\.nul/);
  assert.match(scannerEntry.step.run, /--verbatim-files-from/);
  assert.match(scannerEntry.step.run, /--no-recursion/);
  assert.match(scannerEntry.step.run, /extracted_pack_sha256/);
  assert.match(scannerEntry.step.run, /extracted_findings_sha256/);
  assert.match(scannerEntry.step.run, /omar-gate-artifacts-\$\{archive_sha256\}\.tar/);
  assert.match(
    uploadEntry.step.if,
    /steps\.artifact_secret_scan\.outcome == 'success'/,
  );
  assert.equal(uploadEntry.step.with.path, "${{ steps.artifact_secret_scan.outputs.archive_path }}");
  assert.equal(
    downloadEntry.step.with["artifact-ids"],
    "${{ steps.artifact_upload.outputs.artifact-id }}",
  );
  assert.equal(downloadEntry.step.with["merge-multiple"], true);
  assert.match(handoffEntry.step.run, /actual_sha256/);
  assert.match(handoffEntry.step.run, /downloaded_sha256/);
  assert.match(handoffEntry.step.run, /OMAR_UPLOAD_DIGEST/);
  assert.match(evidenceGateEntry.step.run, /evidence validation failed closed/);
  assert.match(evidenceGateEntry.step.run, /safely retained/);

  assert.ok(actionEntry.stepIndex < manifestEntry.stepIndex);
  assert.ok(manifestEntry.stepIndex < validatorEntry.stepIndex);
  assert.ok(validatorEntry.stepIndex < scannerEntry.stepIndex);
  assert.ok(scannerEntry.stepIndex < uploadEntry.stepIndex);
  assert.ok(uploadEntry.stepIndex < downloadEntry.stepIndex);
  assert.ok(downloadEntry.stepIndex < handoffEntry.stepIndex);
  assert.ok(handoffEntry.stepIndex < evidenceGateEntry.stepIndex);

  const enforcementSteps = workflow.jobs.omar_enforce.steps || [];
  assert.equal(enforcementSteps[0].name, "Require authoritative Omar scan success");
  assert.equal(enforcementSteps[1].name, "Enforce Omar reviewer merge thresholds");
});

test("Unit Omar workflow: fork diagnostics and provider failure cannot become authoritative green", async () => {
  const { workflow, workflowText } = await loadWorkflowContract();
  const enforcementSteps = workflow.jobs.omar_enforce.steps || [];
  const authorityStep = enforcementSteps.find(
    (step) => step.name === "Require authoritative Omar scan success",
  );
  assert.ok(authorityStep);
  assert.match(authorityStep.run, /Fork Omar scan is diagnostic only/);
  assert.match(authorityStep.run, /Trusted exact-subject promotion is required/);
  assert.match(authorityStep.run, /exit 1/);

  const trustedActionSteps = collectSteps(workflow).filter(({ step }) =>
    String(step.uses || "").includes("mrrCarter/sentinelayer-v1-action"),
  );
  assert.equal(trustedActionSteps.length, 1);
  assert.equal(
    trustedActionSteps.some(({ step }) => step.with?.llm_failure_policy === "deterministic_only"),
    false,
  );
  assert.doesNotMatch(workflowText, /artifact_name_suffix:/);
  assert.doesNotMatch(workflowText, /provider_outage_break_glass/);
  assert.doesNotMatch(workflowText, /Select Omar Gate result/);
});
