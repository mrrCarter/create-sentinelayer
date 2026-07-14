import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import YAML from "yaml";

import {
  GENERATED_ARTIFACT_SCANNER_PATH,
  GENERATED_EVIDENCE_VALIDATOR_PATH,
  GENERATED_EVIDENCE_VALIDATOR_SOURCE_PATH,
  GENERATED_WORKFLOW_SUPPORT_FILES,
  PINNED_ACTION_INPUT_NAMES,
  PINNED_ACTION_OUTPUT_NAMES,
  SENTINELAYER_ACTION_REF,
  SENTINELAYER_ACTION_SHA,
  SUPPORTED_HOSTED_SCAN_MODES,
  buildSecurityReviewWorkflow,
  validatePinnedActionWorkflowInterface,
} from "../src/scan/generator.js";
import { resolveScanMode } from "../src/review/scan-modes.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const actionFixturePath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "sentinelayer-v1-action-52fe9cf",
  "action.yml",
);
const modelsFixturePath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "sentinelayer-v1-action-52fe9cf",
  "models.py",
);
const EXPECTED_ACTION_BLOB_ID = "c6367f205c8407ca9cbbc14b081206276a81ae6b";
const EXPECTED_MODELS_BLOB_ID = "bc7fbaba93353f46fbbc732bd56cae33204b96c1";
const OLD_ACTION_REF =
  "mrrCarter/sentinelayer-v1-action@a496be33a466c0cc3f8616d66bbd7d78f7d3c31d";
const UNSUPPORTED_ACTION_INPUTS = [
  "playwright_mode",
  "sbom_mode",
  "wait_for_completion",
  "artifact_name_suffix",
];

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

function gitBlobId(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function parseScanModes(modelsText) {
  const declaration = String(modelsText).match(/^ScanMode\s*=\s*Literal\[([^\]]+)\]/m);
  assert.ok(declaration, "models.py must declare ScanMode as a Literal");
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function collectSteps(workflow) {
  const collected = [];
  for (const [jobId, job] of Object.entries(workflow.jobs || {})) {
    for (const [stepIndex, step] of (job.steps || []).entries()) {
      collected.push({ jobId, stepIndex, step });
    }
  }
  return collected;
}

function findStep(steps, predicate, message) {
  const found = steps.find(({ step }) => predicate(step));
  assert.ok(found, message);
  return found;
}

async function loadPinnedFixtureContract() {
  const [actionBytes, modelsBytes] = await Promise.all([
    readFile(actionFixturePath),
    readFile(modelsFixturePath),
  ]);
  return {
    actionBytes,
    modelsBytes,
    action: YAML.parse(actionBytes.toString("utf8")),
    modes: parseScanModes(modelsBytes.toString("utf8")),
  };
}

test("Unit scan parity: exact-SHA Action fixtures retain their upstream Git blob identities", async () => {
  const fixture = await loadPinnedFixtureContract();

  assert.equal(gitBlobId(fixture.actionBytes), EXPECTED_ACTION_BLOB_ID);
  assert.equal(gitBlobId(fixture.modelsBytes), EXPECTED_MODELS_BLOB_ID);
  assert.deepEqual(Object.keys(fixture.action.inputs), [...PINNED_ACTION_INPUT_NAMES]);
  assert.deepEqual(Object.keys(fixture.action.outputs), [...PINNED_ACTION_OUTPUT_NAMES]);
  assert.deepEqual(fixture.modes, ["pr-diff", "deep", "nightly"]);
  assert.deepEqual([...SUPPORTED_HOSTED_SCAN_MODES], fixture.modes);
  assert.equal(SENTINELAYER_ACTION_SHA, "52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5");
  assert.equal(
    SENTINELAYER_ACTION_REF,
    `mrrCarter/sentinelayer-v1-action@${SENTINELAYER_ACTION_SHA}`,
  );
});

test("Unit scan parity: generated workflow is a declared exact-pin Action consumer", async () => {
  const fixture = await loadPinnedFixtureContract();
  const workflowText = buildSecurityReviewWorkflow({
    profile: {
      scanMode: "pr-diff",
      severityGate: "P1",
      playwrightMode: "audit",
      sbomMode: "audit",
    },
  });
  const workflow = YAML.parse(workflowText);
  const steps = collectSteps(workflow);
  const checkoutEntry = findStep(
    steps,
    (step) => String(step.uses || "").startsWith("actions/checkout@"),
    "generated workflow must check out the exact reviewed subject",
  );
  const provenanceEntry = findStep(
    steps,
    (step) => step.id === "omar_provenance",
    "generated workflow must bind independent subject and workflow provenance",
  );
  const actionEntry = findStep(
    steps,
    (step) => String(step.uses || "").includes("mrrCarter/sentinelayer-v1-action"),
    "generated workflow must contain the pinned Action",
  );
  const actionStep = actionEntry.step;
  const generatedInputNames = Object.keys(actionStep.with || {});
  const declaredInputNames = new Set(Object.keys(fixture.action.inputs));

  assert.equal(actionStep.uses, SENTINELAYER_ACTION_REF);
  assert.notEqual(actionStep.uses, OLD_ACTION_REF);
  assert.equal(
    generatedInputNames.every((inputName) => declaredInputNames.has(inputName)),
    true,
    "every generated Action input must be declared by exact-SHA action.yml",
  );
  assert.deepEqual(
    generatedInputNames.filter((inputName) => UNSUPPORTED_ACTION_INPUTS.includes(inputName)),
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

  assert.equal(
    checkoutEntry.step.with.ref,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
  );
  assert.equal(checkoutEntry.step.with["persist-credentials"], false);
  assert.equal(provenanceEntry.step.env.WORKFLOW_SHA, "${{ github.workflow_sha }}");
  assert.equal(
    provenanceEntry.step.env.TARGET_SUBJECT_SHA,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
  );
  assert.match(provenanceEntry.step.run, /Checked-out subject does not match expected subject/);

  const generatedModes = workflow.on.workflow_dispatch.inputs.scan_mode.options;
  assert.deepEqual(generatedModes, fixture.modes);
  assert.deepEqual(generatedModes, [...SUPPORTED_HOSTED_SCAN_MODES]);
  assert.equal(generatedModes.includes("baseline"), false);
  assert.equal(generatedModes.includes("audit"), false);
  assert.equal(generatedModes.includes("full-depth"), false);

  assert.ok(fixture.action.outputs.idempotency_key);
  assert.equal(
    workflow.jobs.omar_gate.outputs.idempotency_key,
    "${{ steps.omar_evidence.outputs.idempotency_key }}",
  );
  assert.deepEqual(validatePinnedActionWorkflowInterface(workflowText), {
    valid: true,
    errors: [],
  });
});

test("Unit scan parity: generated manifest consumes all live evidence and original artifact outputs", () => {
  const workflow = YAML.parse(
    buildSecurityReviewWorkflow({
      profile: { scanMode: "deep", severityGate: "P2" },
    }),
  );
  const steps = collectSteps(workflow);
  const manifestEntry = findStep(
    steps,
    (step) => step.id === "omar_manifest",
    "generated workflow must build a structured evidence manifest",
  );
  const validatorEntry = findStep(
    steps,
    (step) => step.id === "omar_evidence",
    "generated workflow must invoke the shared evidence validator",
  );
  const artifactEntry = findStep(
    steps,
    (step) => step.name === "Stage validated Omar artifacts",
    "generated workflow must retain validated original artifacts",
  );
  const uploadEntry = findStep(
    steps,
    (step) => step.id === "omar_artifact_upload",
    "generated workflow must upload retained artifacts",
  );
  const scannerEntry = findStep(
    steps,
    (step) => step.id === "omar_artifact_secret_scan",
    "generated workflow must scan staged artifacts before upload",
  );
  const downloadEntry = findStep(
    steps,
    (step) => step.id === "omar_artifact_download",
    "generated workflow must download the exact uploaded artifact",
  );
  const handoffEntry = findStep(
    steps,
    (step) => step.id === "omar_artifact_handoff",
    "generated workflow must verify the sealed upload handoff",
  );
  const evidenceGateEntry = findStep(
    steps,
    (step) => step.name === "Enforce validated Omar evidence",
    "generated workflow must fail closed after diagnostic artifact retention",
  );
  const severityEntry = findStep(
    steps,
    (step) => step.name === "Enforce repository severity policy",
    "generated workflow must apply repository severity policy",
  );

  const evidenceOutputs = [
    "llm_attempted",
    "llm_success",
    "llm_output_valid",
    "llm_no_findings_reported",
    "llm_findings_count",
    "llm_parse_error_count",
    "llm_failure_class",
  ];
  const manifestValues = Object.values(manifestEntry.step.env);
  for (const outputName of evidenceOutputs) {
    assert.equal(
      manifestValues.includes("${{ steps.omar.outputs." + outputName + " || '' }}"),
      true,
      `manifest must consume ${outputName}`,
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
  assert.equal(
    manifestEntry.step.env.OMAR_COMMENT_TAG,
    "${{ format('omar-gate-{0}-{1}', github.run_id, github.run_attempt) }}",
  );
  assert.equal(manifestEntry.step.env.OMAR_EVENT_NAME, "${{ github.event_name }}");
  assert.match(manifestEntry.step.run, /event_name: env\("OMAR_EVENT_NAME"\)/);

  assert.equal(validatorEntry.step["continue-on-error"], true);
  assert.match(validatorEntry.step.run, new RegExp(`node ${GENERATED_EVIDENCE_VALIDATOR_PATH}`));
  assert.match(validatorEntry.step.run, /--input\s+omar-validation\/action-evidence-input\.json/);
  assert.match(validatorEntry.step.run, /--summary-out\s+omar-validation\/validated-evidence\.json/);
  assert.match(validatorEntry.step.run, /--github-output\s+"\$\{GITHUB_OUTPUT\}"/);

  const validatorSidecarEntry = findStep(
    steps,
    (step) => step.name === "Verify vendored Omar evidence validator",
    "generated workflow must verify the validator sidecar installed by scan init",
  );
  assert.match(validatorSidecarEntry.step.run, new RegExp(GENERATED_EVIDENCE_VALIDATOR_PATH));
  assert.doesNotMatch(
    validatorSidecarEntry.step.run,
    new RegExp(GENERATED_EVIDENCE_VALIDATOR_SOURCE_PATH),
  );
  assert.doesNotMatch(validatorSidecarEntry.step.run, /\b(?:cp|install|cmp)\b/);
  assert.doesNotMatch(validatorSidecarEntry.step.run, /function\s+validate|class\s+OmarAction/);

  assert.equal(
    artifactEntry.step.env.OMAR_PACK_SUMMARY_PATH,
    "${{ steps.omar_evidence.outputs.pack_summary_path || '' }}",
  );
  assert.equal(
    artifactEntry.step.env.OMAR_FINDINGS_PATH,
    "${{ steps.omar_evidence.outputs.findings_path || '' }}",
  );
  assert.match(artifactEntry.step.run, /original\/PACK_SUMMARY\.json/);
  assert.match(artifactEntry.step.run, /original\/FINDINGS\.jsonl/);
  assert.match(artifactEntry.step.run, /staged_pack_sha256/);
  assert.match(artifactEntry.step.run, /staged_findings_sha256/);
  assert.match(scannerEntry.step.run, new RegExp(GENERATED_ARTIFACT_SCANNER_PATH));
  assert.match(scannerEntry.step.run, /--path\s+omar-artifacts/);
  assert.match(scannerEntry.step.run, /--manifest\s+"\$\{manifest\}"/);
  assert.match(scannerEntry.step.run, /--expected-manifest\s+"\$\{embedded_manifest\}"/);
  assert.match(scannerEntry.step.run, /archive-files\.nul/);
  assert.match(scannerEntry.step.run, /--verbatim-files-from/);
  assert.match(scannerEntry.step.run, /--no-recursion/);
  assert.match(scannerEntry.step.run, /extracted_pack_sha256/);
  assert.match(scannerEntry.step.run, /extracted_findings_sha256/);
  assert.match(scannerEntry.step.run, /archive_path=omar-upload\/omar-gate-artifacts-\$\{archive_sha256\}\.tar/);
  assert.equal(
    uploadEntry.step.if,
    "${{ always() && steps.omar_artifact_secret_scan.outcome == 'success' }}",
  );
  assert.equal(
    uploadEntry.step.with.path,
    "${{ steps.omar_artifact_secret_scan.outputs.archive_path }}",
  );
  assert.equal(uploadEntry.step.with["compression-level"], 0);
  assert.equal(
    workflow.jobs.omar_gate.outputs.archive_sha256,
    "${{ steps.omar_artifact_secret_scan.outputs.archive_sha256 }}",
  );
  assert.equal(
    workflow.jobs.omar_gate.outputs.artifact_id,
    "${{ steps.omar_artifact_upload.outputs.artifact-id }}",
  );
  assert.equal(
    workflow.jobs.omar_gate.outputs.upload_digest,
    "${{ steps.omar_artifact_upload.outputs.artifact-digest }}",
  );
  assert.equal(
    downloadEntry.step.with["artifact-ids"],
    "${{ steps.omar_artifact_upload.outputs.artifact-id }}",
  );
  assert.equal(downloadEntry.step.with.path, "omar-upload-verify");
  assert.equal(downloadEntry.step.with["merge-multiple"], true);
  assert.match(handoffEntry.step.run, /actual_sha256/);
  assert.match(handoffEntry.step.run, /downloaded_sha256/);
  assert.match(handoffEntry.step.run, /OMAR_UPLOAD_DIGEST/);
  assert.match(evidenceGateEntry.step.run, /evidence validation failed closed/);
  assert.match(evidenceGateEntry.step.run, /artifact secret scan/);
  assert.match(evidenceGateEntry.step.run, /artifact handoff was not digest-verified/);
  assert.deepEqual(
    GENERATED_WORKFLOW_SUPPORT_FILES.map(({ targetPath }) => targetPath),
    [GENERATED_EVIDENCE_VALIDATOR_PATH, GENERATED_ARTIFACT_SCANNER_PATH],
  );
  assert.ok(validatorEntry.stepIndex < uploadEntry.stepIndex);
  assert.ok(scannerEntry.stepIndex < uploadEntry.stepIndex);
  assert.ok(uploadEntry.stepIndex < downloadEntry.stepIndex);
  assert.ok(downloadEntry.stepIndex < handoffEntry.stepIndex);
  assert.ok(handoffEntry.stepIndex < evidenceGateEntry.stepIndex);
  assert.ok(evidenceGateEntry.stepIndex < severityEntry.stepIndex);
});

test("Unit scan parity: strict interface rejects movable refs, undeclared inputs, invalid modes, and fallback authority", () => {
  const base = YAML.parse(
    buildSecurityReviewWorkflow({
      profile: { scanMode: "deep", severityGate: "P1" },
    }),
  );
  const locateAction = (workflow) =>
    collectSteps(workflow).find(({ step }) =>
      String(step.uses || "").includes("mrrCarter/sentinelayer-v1-action"),
    ).step;

  const movable = structuredClone(base);
  locateAction(movable).uses = "mrrCarter/sentinelayer-v1-action@v1";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(movable)).valid, false);

  const extraInput = structuredClone(base);
  locateAction(extraInput).with.playwright_mode = "audit";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(extraInput)).valid, false);

  const invalidModes = structuredClone(base);
  invalidModes.on.workflow_dispatch.inputs.scan_mode.options = ["baseline", "deep", "audit"];
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(invalidModes)).valid, false);

  const fallback = structuredClone(base);
  locateAction(fallback).with.llm_failure_policy = "deterministic_only";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(fallback)).valid, false);

  const mutableCheckout = structuredClone(base);
  const mutableCheckoutStep = collectSteps(mutableCheckout).find(({ step }) =>
    String(step.uses || "").startsWith("actions/checkout@"),
  ).step;
  mutableCheckoutStep.uses = "actions/checkout@v4";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(mutableCheckout)).valid, false);

  const mutableUpload = structuredClone(base);
  const mutableUploadStep = collectSteps(mutableUpload).find(
    ({ step }) => step.id === "omar_artifact_upload",
  ).step;
  mutableUploadStep.with.path = "omar-artifacts/**";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(mutableUpload)).valid, false);

  const mutableUploadRef = structuredClone(base);
  const mutableUploadRefStep = collectSteps(mutableUploadRef).find(
    ({ step }) => step.id === "omar_artifact_upload",
  ).step;
  mutableUploadRefStep.uses = "actions/upload-artifact@v4";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(mutableUploadRef)).valid, false);

  const unboundStaging = structuredClone(base);
  const unboundStage = collectSteps(unboundStaging).find(
    ({ step }) => step.name === "Stage validated Omar artifacts",
  ).step;
  unboundStage.run = unboundStage.run.replaceAll("staged_pack_sha256", "unchecked_pack_sha256");
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(unboundStaging)).valid, false);

  const unboundDownload = structuredClone(base);
  const unboundDownloadStep = collectSteps(unboundDownload).find(
    ({ step }) => step.id === "omar_artifact_download",
  ).step;
  unboundDownloadStep.with["artifact-ids"] = "123";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(unboundDownload)).valid, false);

  const missingArchiveVerification = structuredClone(base);
  const missingArchiveScanner = collectSteps(missingArchiveVerification).find(
    ({ step }) => step.id === "omar_artifact_secret_scan",
  ).step;
  missingArchiveScanner.run = missingArchiveScanner.run.replace("--expected-manifest", "--unchecked");
  assert.equal(
    validatePinnedActionWorkflowInterface(YAML.stringify(missingArchiveVerification)).valid,
    false,
  );

  const bypassedHandoff = structuredClone(base);
  const bypassedGate = collectSteps(bypassedHandoff).find(
    ({ step }) => step.name === "Enforce validated Omar evidence",
  ).step;
  delete bypassedGate.env.OMAR_ARTIFACT_HANDOFF_OUTCOME;
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(bypassedHandoff)).valid, false);

  const noOpEvidenceGate = structuredClone(base);
  collectSteps(noOpEvidenceGate).find(
    ({ step }) => step.name === "Enforce validated Omar evidence",
  ).step.run = "true";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(noOpEvidenceGate)).valid, false);

  const noOpSeverityGate = structuredClone(base);
  collectSteps(noOpSeverityGate).find(
    ({ step }) => step.name === "Enforce repository severity policy",
  ).step.run = "true";
  assert.equal(validatePinnedActionWorkflowInterface(YAML.stringify(noOpSeverityGate)).valid, false);

  assert.throws(
    () =>
      buildSecurityReviewWorkflow({
        profile: { scanMode: "full-depth", severityGate: "P1" },
      }),
    /Invalid hosted scan mode/,
  );
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
