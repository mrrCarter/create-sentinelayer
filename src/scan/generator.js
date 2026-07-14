import YAML from "yaml";

export const DEFAULT_SCAN_WORKFLOW_PATH = ".github/workflows/omar-gate.yml";
export const DEFAULT_SCAN_SECRET_NAME = "SENTINELAYER_TOKEN";
export const SENTINELAYER_ACTION_SHA = "52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5";
export const SENTINELAYER_ACTION_REF =
  `mrrCarter/sentinelayer-v1-action@${SENTINELAYER_ACTION_SHA}`;
export const SUPPORTED_HOSTED_SCAN_MODES = Object.freeze(["pr-diff", "deep", "nightly"]);
export const PINNED_ACTION_INPUT_NAMES = Object.freeze([
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
]);
export const PINNED_ACTION_OUTPUT_NAMES = Object.freeze([
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
]);
export const GENERATED_EVIDENCE_VALIDATOR_SOURCE_PATH =
  "src/scan/omar-action-evidence-validator.mjs";
export const GENERATED_EVIDENCE_VALIDATOR_PATH =
  ".github/scripts/omar-action-evidence-validator.mjs";
export const GENERATED_ARTIFACT_SCANNER_SOURCE_PATH =
  ".github/scripts/scan-omar-artifacts.js";
export const GENERATED_ARTIFACT_SCANNER_PATH = ".github/scripts/scan-omar-artifacts.mjs";
export const GENERATED_WORKFLOW_SUPPORT_FILES = Object.freeze([
  Object.freeze({
    sourcePath: GENERATED_EVIDENCE_VALIDATOR_SOURCE_PATH,
    targetPath: GENERATED_EVIDENCE_VALIDATOR_PATH,
  }),
  Object.freeze({
    sourcePath: GENERATED_ARTIFACT_SCANNER_SOURCE_PATH,
    targetPath: GENERATED_ARTIFACT_SCANNER_PATH,
  }),
]);
export const SUPPORTED_E2E_HINTS = Object.freeze(["auto", "yes", "no"]);
export const SUPPORTED_PLAYWRIGHT_MODES = Object.freeze(["auto", "off", "baseline", "audit"]);

const CHECKOUT_ACTION_REF = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const SETUP_NODE_ACTION_REF = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const UPLOAD_ARTIFACT_ACTION_REF = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const DOWNLOAD_ARTIFACT_ACTION_REF = "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";
const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;
const REPO_SLUG_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normalizeChoice(rawValue, allowed, label) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    return allowed[0];
  }
  if (!allowed.includes(normalized)) {
    throw new Error(
      `Invalid ${label} '${rawValue}'. Allowed values: ${allowed.join(", ")}`
    );
  }
  return normalized;
}

function normalizeSeverityGate(rawValue) {
  const normalized = String(rawValue || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "NONE") {
    return "none";
  }
  if (normalized === "P0" || normalized === "P1" || normalized === "P2") {
    return normalized;
  }
  return normalized;
}

function normalizeMode(rawValue, fallback) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  return normalized || fallback;
}

function normalizeHostedScanMode(rawValue, fallback = "deep") {
  return normalizeChoice(rawValue || fallback, SUPPORTED_HOSTED_SCAN_MODES, "hosted scan mode");
}

function hasAnyKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function computeRiskScore(text) {
  const weightedSignals = [
    ["auth", 2],
    ["authorization", 2],
    ["oauth", 2],
    ["token", 2],
    ["payment", 3],
    ["billing", 2],
    ["pii", 3],
    ["compliance", 2],
    ["encryption", 2],
    ["secrets", 2],
    ["supply_chain", 2],
    ["supply chain", 2],
    ["dependency", 1],
    ["admin", 1],
    ["tenant", 1],
    ["security checklist", 1],
    ["critical", 1],
  ];

  return weightedSignals.reduce(
    (score, [keyword, weight]) => (text.includes(keyword) ? score + weight : score),
    0
  );
}

function parseSecretReference(rawValue) {
  const text = String(rawValue || "");
  const match = text.match(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/);
  return match ? String(match[1]).toUpperCase() : "";
}

export function sanitizeSecretName(secretName) {
  const normalized = String(secretName || "")
    .trim()
    .toUpperCase();
  return SECRET_NAME_REGEX.test(normalized) ? normalized : DEFAULT_SCAN_SECRET_NAME;
}

export function inferScanProfile({ specMarkdown, hasE2ETests = "auto", playwrightMode = "auto" } = {}) {
  const specText = String(specMarkdown || "").trim().toLowerCase();
  if (!specText) {
    throw new Error("Spec content is empty. Generate or provide a spec before configuring scan workflow.");
  }

  const normalizedE2EHint = normalizeChoice(hasE2ETests, SUPPORTED_E2E_HINTS, "has-e2e-tests");
  const normalizedPlaywrightMode = normalizeChoice(
    playwrightMode,
    SUPPORTED_PLAYWRIGHT_MODES,
    "playwright-mode"
  );

  const inferredHasE2E = hasAnyKeyword(specText, [
    "e2e",
    "end-to-end",
    "playwright",
    "cypress",
    "integration test",
  ]);
  const riskScore = computeRiskScore(specText);
  const deepScanRecommended = riskScore >= 7;

  const scanMode = deepScanRecommended ? "deep" : "pr-diff";
  const severityGate = deepScanRecommended ? "P2" : "P1";

  const hasSupplyChainSignal = hasAnyKeyword(specText, [
    "supply_chain",
    "supply chain",
    "dependency",
    "dependencies",
    "sbom",
  ]);
  const sbomMode = hasSupplyChainSignal ? (deepScanRecommended ? "audit" : "baseline") : "off";

  let resolvedPlaywrightMode = "off";
  if (normalizedPlaywrightMode !== "auto") {
    resolvedPlaywrightMode = normalizedPlaywrightMode;
  } else if (normalizedE2EHint === "yes") {
    resolvedPlaywrightMode = deepScanRecommended ? "audit" : "baseline";
  } else if (normalizedE2EHint === "auto" && inferredHasE2E) {
    resolvedPlaywrightMode = deepScanRecommended ? "audit" : "baseline";
  }

  return {
    scanMode,
    severityGate,
    playwrightMode: resolvedPlaywrightMode,
    sbomMode,
    riskScore,
    inferredHasE2E,
    hasE2ETests: normalizedE2EHint,
  };
}

export function buildSecurityReviewWorkflow({
  secretName = DEFAULT_SCAN_SECRET_NAME,
  profile,
  specId = "",
  workflowName = "Omar Gate",
} = {}) {
  if (!profile) {
    throw new Error("Scan profile is required to build workflow config.");
  }
  const normalizedSecret = sanitizeSecretName(secretName);
  const normalizedSpecId = String(specId || "").trim();
  const hostedScanMode = normalizeHostedScanMode(profile.scanMode, "deep");
  const consumerSeverityGate = normalizeSeverityGate(profile.severityGate || "P1");
  if (!["P0", "P1", "P2", "none"].includes(consumerSeverityGate)) {
    throw new Error(
      `Invalid consumer severity gate '${profile.severityGate}'. Allowed values: P0, P1, P2, none`
    );
  }
  const scanModeExpression =
    `\${{ github.event_name == 'workflow_dispatch' && inputs.scan_mode || '${hostedScanMode}' }}`;
  const severityGateExpression =
    `\${{ github.event_name == 'workflow_dispatch' && inputs.severity_gate || '${consumerSeverityGate}' }}`;
  const commentTagExpression =
    "${{ format('omar-gate-{0}-{1}', github.run_id, github.run_attempt) }}";

  const document = {
    name: String(workflowName || "Omar Gate").trim() || "Omar Gate",
    on: {
      pull_request: {
        types: ["opened", "synchronize", "reopened"],
      },
      workflow_dispatch: {
        inputs: {
          scan_mode: {
            description: "Hosted Sentinelayer Action scan mode",
            required: false,
            default: hostedScanMode,
            type: "choice",
            options: [...SUPPORTED_HOSTED_SCAN_MODES],
          },
          severity_gate: {
            description: "Repository severity threshold applied after live evidence validation",
            required: false,
            default: consumerSeverityGate,
            type: "choice",
            options: ["P0", "P1", "P2", "none"],
          },
          p2_max_allowed: {
            description: "Maximum allowed P2 findings",
            required: false,
            default: "5",
            type: "string",
          },
        },
      },
    },
    permissions: {
      actions: "read",
      contents: "read",
      "pull-requests": "write",
      checks: "write",
      "id-token": "write",
    },
    env: {
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true",
    },
    jobs: {
      omar_gate: {
        name: "Omar Gate",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 20,
        outputs: {
          run_id: "${{ steps.omar_evidence.outputs.run_id }}",
          gate_status: "${{ steps.omar_evidence.outputs.gate_status }}",
          p0_count: "${{ steps.omar_evidence.outputs.p0_count }}",
          p1_count: "${{ steps.omar_evidence.outputs.p1_count }}",
          p2_count: "${{ steps.omar_evidence.outputs.p2_count }}",
          p3_count: "${{ steps.omar_evidence.outputs.p3_count }}",
          evidence_digest: "${{ steps.omar_evidence.outputs.evidence_digest }}",
          idempotency_key: "${{ steps.omar_evidence.outputs.idempotency_key }}",
          archive_sha256: "${{ steps.omar_artifact_secret_scan.outputs.archive_sha256 }}",
          artifact_id: "${{ steps.omar_artifact_upload.outputs.artifact-id }}",
          upload_digest: "${{ steps.omar_artifact_upload.outputs.artifact-digest }}",
        },
        permissions: {
          actions: "read",
          contents: "read",
          checks: "write",
          "pull-requests": "write",
          "id-token": "write",
        },
        steps: [
          {
            name: "Checkout",
            uses: CHECKOUT_ACTION_REF,
            with: {
              ref: "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
              "persist-credentials": false,
            },
          },
          {
            name: "Verify vendored Omar evidence validator",
            shell: "bash",
            run: [
              "set -euo pipefail",
              `test -f ${GENERATED_EVIDENCE_VALIDATOR_PATH}`,
              `node --check ${GENERATED_EVIDENCE_VALIDATOR_PATH}`,
            ].join("\n"),
          },
          {
            name: "Bind Omar workflow provenance",
            id: "omar_provenance",
            shell: "bash",
            env: {
              TARGET_SUBJECT_SHA:
                "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
              WORKFLOW_SHA: "${{ github.workflow_sha }}",
            },
            run: [
              "set -euo pipefail",
              'subject_sha="$(git rev-parse HEAD)"',
              'expected_subject_sha="$(echo "${TARGET_SUBJECT_SHA}" | tr \'[:upper:]\' \'[:lower:]\' | xargs)"',
              'workflow_sha="$(echo "${WORKFLOW_SHA}" | tr \'[:upper:]\' \'[:lower:]\' | xargs)"',
              'workflow_ref="${GITHUB_WORKFLOW_REF#${GITHUB_REPOSITORY}/}"',
              'workflow_path="${workflow_ref%@*}"',
              'if ! echo "${expected_subject_sha}" | grep -Eq \'^[0-9a-f]{40}$\'; then echo "::error::Invalid expected subject SHA"; exit 1; fi',
              'if [ "${subject_sha}" != "${expected_subject_sha}" ]; then echo "::error::Checked-out subject does not match expected subject"; exit 1; fi',
              'if ! echo "${workflow_sha}" | grep -Eq \'^[0-9a-f]{40}$\'; then echo "::error::Invalid workflow SHA"; exit 1; fi',
              'test -f "${workflow_path}"',
              `test -f ${GENERATED_EVIDENCE_VALIDATOR_PATH}`,
              'workflow_file_sha256="$(sha256sum "${workflow_path}" | awk \'{print $1}\')"',
              `validator_sha256="$(sha256sum ${GENERATED_EVIDENCE_VALIDATOR_PATH} | awk '{print $1}')"`,
              'echo "subject_sha=${subject_sha}" >> "${GITHUB_OUTPUT}"',
              'echo "workflow_sha=${workflow_sha}" >> "${GITHUB_OUTPUT}"',
              'echo "workflow_file_sha256=${workflow_file_sha256}" >> "${GITHUB_OUTPUT}"',
              'echo "validator_sha256=${validator_sha256}" >> "${GITHUB_OUTPUT}"',
            ].join("\n"),
          },
          {
            name: "Validate Sentinelayer token",
            shell: "bash",
            env: {
              SENTINELAYER_TOKEN: `\${{ secrets.${normalizedSecret} }}`,
            },
            run: [
              'set -euo pipefail',
              'if [ -z "${SENTINELAYER_TOKEN}" ]; then',
              `  echo "::warning::${normalizedSecret} not set. Run: gh secret set ${normalizedSecret} --body <token>"`,
              '  echo "Omar Gate remains fail-closed unless another configured live provider succeeds."',
              'fi',
            ].join("\n"),
          },
          {
            name: "Run Omar Gate",
            id: "omar",
            "continue-on-error": true,
            uses: SENTINELAYER_ACTION_REF,
            with: {
              github_token: "${{ github.token }}",
              comment_tag: commentTagExpression,
              publish_github: "false",
              openai_api_key: "${{ secrets.OPENAI_API_KEY }}",
              google_api_key:
                "${{ secrets.GOOGLE_GEMINI_API_KEY != '' && secrets.GOOGLE_GEMINI_API_KEY || secrets.GOOGLE_API_KEY }}",
              llm_provider:
                "${{ secrets.OPENAI_API_KEY != '' && 'openai' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'google' || 'openai') }}",
              sentinelayer_token: `\${{ secrets.${normalizedSecret} }}`,
              ...(normalizedSpecId ? { sentinelayer_spec_id: normalizedSpecId } : {}),
              sentinelayer_managed_llm: `\${{ secrets.${normalizedSecret} != '' }}`,
              scan_mode: scanModeExpression,
              severity_gate: "none",
              model:
                "${{ secrets.OPENAI_API_KEY != '' && 'gpt-5.3-codex' || ((secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-5.3-codex') }}",
              codex_model: "gpt-5.3-codex",
              model_fallback:
                "${{ (secrets.GOOGLE_GEMINI_API_KEY != '' || secrets.GOOGLE_API_KEY != '') && 'gemini-2.5-flash' || 'gpt-4.1-mini' }}",
              use_codex:
                "${{ secrets.OPENAI_API_KEY != '' || (secrets.GOOGLE_GEMINI_API_KEY == '' && secrets.GOOGLE_API_KEY == '') }}",
              codex_only: "false",
              llm_failure_policy: "block",
              max_daily_scans: "${{ vars.OMAR_MAX_DAILY_SCANS || '200' }}",
              min_scan_interval_minutes: "${{ vars.OMAR_MIN_SCAN_INTERVAL_MINUTES || '0' }}",
              rate_limit_fail_mode: "closed",
            },
          },
          {
            name: "Build Omar evidence manifest",
            id: "omar_manifest",
            if: "${{ always() }}",
            shell: "bash",
            env: {
              OMAR_ACTION_REF: SENTINELAYER_ACTION_REF,
              OMAR_ACTION_OUTCOME: "${{ steps.omar.outcome || '' }}",
              OMAR_GATE_STATUS: "${{ steps.omar.outputs.gate_status || '' }}",
              OMAR_RUN_ID: "${{ steps.omar.outputs.run_id || '' }}",
              OMAR_IDEMPOTENCY_KEY: "${{ steps.omar.outputs.idempotency_key || '' }}",
              OMAR_ACTION_SCAN_MODE: "${{ steps.omar.outputs.scan_mode || '' }}",
              OMAR_POLICY_PACK: "${{ steps.omar.outputs.policy_pack || '' }}",
              OMAR_POLICY_PACK_VERSION:
                "${{ steps.omar.outputs.policy_pack_version || '' }}",
              OMAR_P0: "${{ steps.omar.outputs.p0_count || '' }}",
              OMAR_P1: "${{ steps.omar.outputs.p1_count || '' }}",
              OMAR_P2: "${{ steps.omar.outputs.p2_count || '' }}",
              OMAR_P3: "${{ steps.omar.outputs.p3_count || '' }}",
              OMAR_FINDINGS_ARTIFACT: "${{ steps.omar.outputs.findings_artifact || '' }}",
              OMAR_PACK_SUMMARY_ARTIFACT:
                "${{ steps.omar.outputs.pack_summary_artifact || '' }}",
              OMAR_LLM_ATTEMPTED: "${{ steps.omar.outputs.llm_attempted || '' }}",
              OMAR_LLM_SUCCESS: "${{ steps.omar.outputs.llm_success || '' }}",
              OMAR_LLM_OUTPUT_VALID: "${{ steps.omar.outputs.llm_output_valid || '' }}",
              OMAR_LLM_NO_FINDINGS_REPORTED:
                "${{ steps.omar.outputs.llm_no_findings_reported || '' }}",
              OMAR_LLM_FINDINGS_COUNT:
                "${{ steps.omar.outputs.llm_findings_count || '' }}",
              OMAR_LLM_PARSE_ERROR_COUNT:
                "${{ steps.omar.outputs.llm_parse_error_count || '' }}",
              OMAR_LLM_FAILURE_CLASS: "${{ steps.omar.outputs.llm_failure_class || '' }}",
              OMAR_SUBJECT_SHA: "${{ steps.omar_provenance.outputs.subject_sha || '' }}",
              OMAR_WORKFLOW_SHA: "${{ steps.omar_provenance.outputs.workflow_sha || '' }}",
              OMAR_WORKFLOW_FILE_SHA256:
                "${{ steps.omar_provenance.outputs.workflow_file_sha256 || '' }}",
              OMAR_VALIDATOR_SHA256:
                "${{ steps.omar_provenance.outputs.validator_sha256 || '' }}",
              OMAR_WORKFLOW_REF: "${{ github.workflow_ref }}",
              OMAR_EVENT_NAME: "${{ github.event_name }}",
              OMAR_PULL_REQUEST_NUMBER: "${{ github.event.pull_request.number || '0' }}",
              OMAR_COMMENT_TAG: commentTagExpression,
            },
            run: [
              "set -euo pipefail",
              "mkdir -p omar-validation",
              "node --input-type=module <<'NODE'",
              'import fs from "node:fs";',
              "",
              'const env = (name) => process.env[name] ?? "";',
              "const manifest = {",
              '  schema_version: "1.0",',
              "  action: {",
              '    ref: env("OMAR_ACTION_REF"),',
              '    outcome: env("OMAR_ACTION_OUTCOME"),',
              '    gate_status: env("OMAR_GATE_STATUS"),',
              '    run_id: env("OMAR_RUN_ID"),',
              '    idempotency_key: env("OMAR_IDEMPOTENCY_KEY"),',
              '    scan_mode: env("OMAR_ACTION_SCAN_MODE"),',
              '    policy_pack: env("OMAR_POLICY_PACK"),',
              '    policy_pack_version: env("OMAR_POLICY_PACK_VERSION"),',
              '    p0_count: env("OMAR_P0"),',
              '    p1_count: env("OMAR_P1"),',
              '    p2_count: env("OMAR_P2"),',
              '    p3_count: env("OMAR_P3"),',
              '    findings_artifact: env("OMAR_FINDINGS_ARTIFACT"),',
              '    pack_summary_artifact: env("OMAR_PACK_SUMMARY_ARTIFACT"),',
              '    llm_attempted: env("OMAR_LLM_ATTEMPTED"),',
              '    llm_success: env("OMAR_LLM_SUCCESS"),',
              '    llm_output_valid: env("OMAR_LLM_OUTPUT_VALID"),',
              '    llm_no_findings_reported: env("OMAR_LLM_NO_FINDINGS_REPORTED"),',
              '    llm_findings_count: env("OMAR_LLM_FINDINGS_COUNT"),',
              '    llm_parse_error_count: env("OMAR_LLM_PARSE_ERROR_COUNT"),',
              '    llm_failure_class: env("OMAR_LLM_FAILURE_CLASS"),',
              "  },",
              "  provenance: {",
              '    subject_sha: env("OMAR_SUBJECT_SHA"),',
              '    workflow_sha: env("OMAR_WORKFLOW_SHA"),',
              '    workflow_ref: env("OMAR_WORKFLOW_REF"),',
              '    workflow_file_sha256: env("OMAR_WORKFLOW_FILE_SHA256"),',
              '    validator_sha256: env("OMAR_VALIDATOR_SHA256"),',
              '    repository: env("GITHUB_REPOSITORY"),',
              '    event_name: env("OMAR_EVENT_NAME"),',
              '    github_run_id: env("GITHUB_RUN_ID"),',
              '    github_run_attempt: env("GITHUB_RUN_ATTEMPT"),',
              '    pull_request_number: env("OMAR_PULL_REQUEST_NUMBER"),',
              '    comment_tag: env("OMAR_COMMENT_TAG"),',
              "  },",
              "};",
              "fs.writeFileSync(",
              '  "omar-validation/action-evidence-input.json",',
              "  `${JSON.stringify(manifest, null, 2)}\\n`,",
              '  { encoding: "utf8", mode: 0o600 },',
              ");",
              "NODE",
            ].join("\n"),
          },
          {
            name: "Validate live Omar evidence",
            id: "omar_evidence",
            if: "${{ always() }}",
            "continue-on-error": true,
            shell: "bash",
            env: {
              EXPECTED_SUBJECT_SHA: "${{ steps.omar_provenance.outputs.subject_sha || '' }}",
              EXPECTED_WORKFLOW_SHA: "${{ steps.omar_provenance.outputs.workflow_sha || '' }}",
              EXPECTED_WORKFLOW_REF: "${{ github.workflow_ref }}",
            },
            run: [
              "set -euo pipefail",
              `node ${GENERATED_EVIDENCE_VALIDATOR_PATH} \\`,
              "  --input omar-validation/action-evidence-input.json \\",
              '  --workspace-root "${GITHUB_WORKSPACE}" \\',
              '  --expected-subject-sha "${EXPECTED_SUBJECT_SHA}" \\',
              '  --expected-workflow-sha "${EXPECTED_WORKFLOW_SHA}" \\',
              '  --expected-workflow-ref "${EXPECTED_WORKFLOW_REF}" \\',
              "  --summary-out omar-validation/validated-evidence.json \\",
              '  --github-output "${GITHUB_OUTPUT}"',
            ].join("\n"),
          },
          {
            name: "Stage validated Omar artifacts",
            if: "${{ always() }}",
            shell: "bash",
            env: {
              OMAR_ACTION_OUTCOME: "${{ steps.omar.outcome || '' }}",
              OMAR_VALIDATION_OUTCOME: "${{ steps.omar_evidence.outcome || '' }}",
              OMAR_RUN_ID: "${{ steps.omar_evidence.outputs.run_id || '' }}",
              OMAR_GATE_STATUS: "${{ steps.omar_evidence.outputs.gate_status || '' }}",
              OMAR_P0: "${{ steps.omar_evidence.outputs.p0_count || '0' }}",
              OMAR_P1: "${{ steps.omar_evidence.outputs.p1_count || '0' }}",
              OMAR_P2: "${{ steps.omar_evidence.outputs.p2_count || '0' }}",
              OMAR_P3: "${{ steps.omar_evidence.outputs.p3_count || '0' }}",
              OMAR_PACK_SUMMARY_PATH:
                "${{ steps.omar_evidence.outputs.pack_summary_path || '' }}",
              OMAR_FINDINGS_PATH: "${{ steps.omar_evidence.outputs.findings_path || '' }}",
              OMAR_PACK_SHA256: "${{ steps.omar_evidence.outputs.pack_sha256 || '' }}",
              OMAR_FINDINGS_SHA256:
                "${{ steps.omar_evidence.outputs.findings_sha256 || '' }}",
              OMAR_EVIDENCE_DIGEST:
                "${{ steps.omar_evidence.outputs.evidence_digest || '' }}",
              OMAR_SUBJECT_SHA: "${{ steps.omar_evidence.outputs.subject_sha || '' }}",
              OMAR_WORKFLOW_SHA: "${{ steps.omar_evidence.outputs.workflow_sha || '' }}",
              OMAR_LLM_FAILURE_CLASS: "${{ steps.omar.outputs.llm_failure_class || '' }}",
              OMAR_IDEMPOTENCY_KEY:
                "${{ steps.omar_evidence.outputs.idempotency_key || '' }}",
              OMAR_SCAN_MODE: scanModeExpression,
              OMAR_SEVERITY_GATE: severityGateExpression,
              OMAR_P2_MAX_ALLOWED:
                "${{ github.event_name == 'workflow_dispatch' && inputs.p2_max_allowed || '5' }}",
            },
            run: [
              "set -euo pipefail",
              "rm -rf omar-artifacts",
              "mkdir -p omar-artifacts/original omar-artifacts/validation",
              "cp omar-validation/action-evidence-input.json omar-artifacts/validation/action-evidence-input.json",
              'if [ -f "omar-validation/validated-evidence.json" ]; then',
              "  cp omar-validation/validated-evidence.json omar-artifacts/validation/validated-evidence.json",
              'fi',
              'if [ "${OMAR_VALIDATION_OUTCOME}" = "success" ]; then',
              '  test -f "${OMAR_PACK_SUMMARY_PATH}"',
              '  test -f "${OMAR_FINDINGS_PATH}"',
              '  cp "${OMAR_PACK_SUMMARY_PATH}" omar-artifacts/original/PACK_SUMMARY.json',
              '  cp "${OMAR_FINDINGS_PATH}" omar-artifacts/original/FINDINGS.jsonl',
              '  staged_pack_sha256="$(sha256sum omar-artifacts/original/PACK_SUMMARY.json | awk \'{print $1}\')"',
              '  staged_findings_sha256="$(sha256sum omar-artifacts/original/FINDINGS.jsonl | awk \'{print $1}\')"',
              '  if [ "${staged_pack_sha256}" != "${OMAR_PACK_SHA256}" ] || [ "${staged_findings_sha256}" != "${OMAR_FINDINGS_SHA256}" ]; then',
              '    echo "::error::Staged Omar evidence differs from the validated Action bytes."',
              "    exit 1",
              "  fi",
              'fi',
              "node --input-type=module <<'NODE'",
              'import fs from "node:fs";',
              "",
              'const env = (name, fallback = "") => process.env[name] ?? fallback;',
              "const integer = (name) => {",
              '  const value = env(name, "0");',
              "  return /^\\d+$/.test(value) ? Number(value) : 0;",
              "};",
              "const summary = {",
              '  schema_version: "2.0",',
              '  kind: "validated_omar_gate_summary",',
              '  validation_succeeded: env("OMAR_VALIDATION_OUTCOME") === "success",',
              '  action_outcome: env("OMAR_ACTION_OUTCOME"),',
              '  validation_outcome: env("OMAR_VALIDATION_OUTCOME"),',
              '  run_id: env("OMAR_RUN_ID"),',
              '  gate_status: env("OMAR_GATE_STATUS"),',
              "  findings: {",
              '    P0: integer("OMAR_P0"),',
              '    P1: integer("OMAR_P1"),',
              '    P2: integer("OMAR_P2"),',
              '    P3: integer("OMAR_P3"),',
              "  },",
              "  threshold: {",
              '    severity_gate: env("OMAR_SEVERITY_GATE", "P1"),',
              '    p2_max_allowed: integer("OMAR_P2_MAX_ALLOWED"),',
              "  },",
              "  evidence: {",
              `    action_ref: "${SENTINELAYER_ACTION_REF}",`,
              '    llm_failure_policy: "block",',
              '    failure_class: env("OMAR_LLM_FAILURE_CLASS"),',
              '    pack_sha256: env("OMAR_PACK_SHA256"),',
              '    findings_sha256: env("OMAR_FINDINGS_SHA256"),',
              '    evidence_digest: env("OMAR_EVIDENCE_DIGEST"),',
              '    idempotency_key: env("OMAR_IDEMPOTENCY_KEY"),',
              "  },",
              "  provenance: {",
              '    subject_sha: env("OMAR_SUBJECT_SHA"),',
              '    workflow_sha: env("OMAR_WORKFLOW_SHA"),',
              '    workflow_ref: env("GITHUB_WORKFLOW_REF"),',
              "  },",
              "};",
              "fs.writeFileSync(",
              '  "omar-artifacts/summary.json",',
              "  `${JSON.stringify(summary, null, 2)}\\n`,",
              '  { encoding: "utf8", mode: 0o600 },',
              ");",
              "NODE",
            ].join("\n"),
          },
          {
            name: "Seal and scan staged Omar artifacts",
            id: "omar_artifact_secret_scan",
            if: "${{ always() }}",
            shell: "bash",
            env: {
              OMAR_PACK_SHA256: "${{ steps.omar_evidence.outputs.pack_sha256 || '' }}",
              OMAR_FINDINGS_SHA256:
                "${{ steps.omar_evidence.outputs.findings_sha256 || '' }}",
            },
            run: [
              "set -euo pipefail",
              `test -f ${GENERATED_ARTIFACT_SCANNER_PATH}`,
              "rm -rf omar-upload omar-archive-verify omar-upload-verify",
              "mkdir -p omar-upload omar-validation",
              "report=omar-validation/secret-scan.json",
              "manifest=omar-validation/artifact-manifest.json",
              `node ${GENERATED_ARTIFACT_SCANNER_PATH} --path omar-artifacts --report "\${report}" --manifest "\${manifest}"`,
              "manifest_sha256=\"$(sha256sum \"${manifest}\" | awk '{print $1}')\"",
              "cp \"${manifest}\" omar-artifacts/validation/artifact-manifest.json",
              "archive_file_list=\"$(pwd)/omar-validation/archive-files.nul\"",
              'MANIFEST_PATH="${manifest}" ARCHIVE_FILE_LIST="${archive_file_list}" node --input-type=module <<\'NODE\'',
              'import fs from "node:fs";',
              "",
              'const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));',
              "const paths = [",
              "  ...manifest.files.map((entry) => entry.path),",
              '  "validation/artifact-manifest.json",',
              "].sort();",
              "if (",
              "  paths.some(",
              "    (entry) =>",
              '      typeof entry !== "string" ||',
              "      entry.length === 0 ||",
              '      entry.includes("\\0") ||',
              '      entry.startsWith("/") ||',
              '      entry.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),',
              "  ) ||",
              "  new Set(paths).size !== paths.length",
              ") {",
              '  throw new Error("Artifact manifest contains an unsafe archive member path");',
              "}",
              'const chunks = paths.flatMap((entry) => [Buffer.from(entry, "utf8"), Buffer.from([0])]);',
              "fs.writeFileSync(process.env.ARCHIVE_FILE_LIST, Buffer.concat(chunks), {",
              "  mode: 0o600,",
              "});",
              "NODE",
              "archive_tmp=omar-upload/omar-gate-artifacts.tar.tmp",
              "tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --format=posix --pax-option=delete=atime,delete=ctime -cf \"${archive_tmp}\" -C omar-artifacts --null --verbatim-files-from --no-recursion -T \"${archive_file_list}\"",
              "mkdir -p omar-archive-verify",
              "tar -xf \"${archive_tmp}\" -C omar-archive-verify --no-same-owner",
              "embedded_manifest=omar-archive-verify/validation/artifact-manifest.json",
              "test \"$(sha256sum \"${embedded_manifest}\" | awk '{print $1}')\" = \"${manifest_sha256}\"",
              `node ${GENERATED_ARTIFACT_SCANNER_PATH} --path omar-archive-verify --report omar-validation/archive-secret-scan.json --expected-manifest "\${embedded_manifest}"`,
              'extracted_pack_sha256="$(sha256sum omar-archive-verify/original/PACK_SUMMARY.json | awk \'{print $1}\')"',
              'extracted_findings_sha256="$(sha256sum omar-archive-verify/original/FINDINGS.jsonl | awk \'{print $1}\')"',
              'if [ "${extracted_pack_sha256}" != "${OMAR_PACK_SHA256}" ] || [ "${extracted_findings_sha256}" != "${OMAR_FINDINGS_SHA256}" ]; then',
              '  echo "::error::Sealed Omar archive differs from the validated Action bytes."',
              "  exit 1",
              "fi",
              "archive_sha256=\"$(sha256sum \"${archive_tmp}\" | awk '{print $1}')\"",
              "case \"${archive_sha256}\" in (''|*[!0-9a-f]*) echo \"::error::Invalid sealed archive digest\"; exit 1;; esac",
              "archive_path=omar-upload/omar-gate-artifacts-${archive_sha256}.tar",
              "mv \"${archive_tmp}\" \"${archive_path}\"",
              "chmod 0444 \"${archive_path}\"",
              "rm -rf omar-artifacts omar-archive-verify",
              "echo \"archive_path=${archive_path}\" >> \"${GITHUB_OUTPUT}\"",
              "echo \"archive_sha256=${archive_sha256}\" >> \"${GITHUB_OUTPUT}\"",
            ].join("\n"),
          },
          {
            name: "Upload Omar artifacts",
            id: "omar_artifact_upload",
            if: "${{ always() && steps.omar_artifact_secret_scan.outcome == 'success' }}",
            uses: UPLOAD_ARTIFACT_ACTION_REF,
            with: {
              name: "omar-gate-artifacts",
              path: "${{ steps.omar_artifact_secret_scan.outputs.archive_path }}",
              "if-no-files-found": "error",
              "compression-level": 0,
            },
          },
          {
            name: "Download uploaded Omar artifact for verification",
            id: "omar_artifact_download",
            if: "${{ always() && steps.omar_artifact_upload.outcome == 'success' }}",
            uses: DOWNLOAD_ARTIFACT_ACTION_REF,
            with: {
              "artifact-ids": "${{ steps.omar_artifact_upload.outputs.artifact-id }}",
              path: "omar-upload-verify",
              "merge-multiple": true,
            },
          },
          {
            name: "Verify sealed artifact handoff",
            id: "omar_artifact_handoff",
            if: "${{ always() && steps.omar_artifact_download.outcome == 'success' }}",
            shell: "bash",
            env: {
              OMAR_ARCHIVE_PATH:
                "${{ steps.omar_artifact_secret_scan.outputs.archive_path || '' }}",
              OMAR_ARCHIVE_SHA256:
                "${{ steps.omar_artifact_secret_scan.outputs.archive_sha256 || '' }}",
              OMAR_ARTIFACT_ID:
                "${{ steps.omar_artifact_upload.outputs.artifact-id || '' }}",
              OMAR_UPLOAD_DIGEST:
                "${{ steps.omar_artifact_upload.outputs.artifact-digest || '' }}",
              OMAR_DOWNLOAD_PATH:
                "${{ steps.omar_artifact_download.outputs.download-path || '' }}",
            },
            run: [
              "set -euo pipefail",
              'test -n "${OMAR_ARCHIVE_PATH}"',
              'test -f "${OMAR_ARCHIVE_PATH}"',
              'test ! -L "${OMAR_ARCHIVE_PATH}"',
              'test "$(basename "${OMAR_ARCHIVE_PATH}")" = "omar-gate-artifacts-${OMAR_ARCHIVE_SHA256}.tar"',
              'actual_sha256="$(sha256sum "${OMAR_ARCHIVE_PATH}" | awk \'{print $1}\')"',
              'test "${actual_sha256}" = "${OMAR_ARCHIVE_SHA256}"',
              'case "${OMAR_ARTIFACT_ID}" in (\'\'|*[!0-9]*) echo "::error::Upload action did not return a canonical artifact id"; exit 1;; esac',
              'case "${OMAR_UPLOAD_DIGEST}" in (????????????????????????????????????????????????????????????????) ;; (*) echo "::error::Upload action did not return a canonical artifact digest"; exit 1;; esac',
              'case "${OMAR_UPLOAD_DIGEST}" in (*[!0-9a-f]*) echo "::error::Upload action returned an invalid artifact digest"; exit 1;; esac',
              'test -d "${OMAR_DOWNLOAD_PATH}"',
              'expected_filename="$(basename "${OMAR_ARCHIVE_PATH}")"',
              'downloaded_archive="${OMAR_DOWNLOAD_PATH}/${expected_filename}"',
              'test -f "${downloaded_archive}"',
              'test ! -L "${downloaded_archive}"',
              'test "$(find "${OMAR_DOWNLOAD_PATH}" -type f | wc -l | xargs)" = "1"',
              'test -z "$(find "${OMAR_DOWNLOAD_PATH}" -type l -print -quit)"',
              'downloaded_sha256="$(sha256sum "${downloaded_archive}" | awk \'{print $1}\')"',
              'test "${downloaded_sha256}" = "${OMAR_ARCHIVE_SHA256}"',
            ].join("\n"),
          },
          {
            name: "Enforce validated Omar evidence",
            if: "${{ always() }}",
            shell: "bash",
            env: {
              OMAR_ACTION_OUTCOME: "${{ steps.omar.outcome || '' }}",
              OMAR_VALIDATION_OUTCOME: "${{ steps.omar_evidence.outcome || '' }}",
              OMAR_SECRET_SCAN_OUTCOME:
                "${{ steps.omar_artifact_secret_scan.outcome || '' }}",
              OMAR_ARTIFACT_UPLOAD_OUTCOME:
                "${{ steps.omar_artifact_upload.outcome || '' }}",
              OMAR_ARTIFACT_DOWNLOAD_OUTCOME:
                "${{ steps.omar_artifact_download.outcome || '' }}",
              OMAR_ARTIFACT_HANDOFF_OUTCOME:
                "${{ steps.omar_artifact_handoff.outcome || '' }}",
              OMAR_LLM_FAILURE_CLASS: "${{ steps.omar.outputs.llm_failure_class || '' }}",
            },
            run: [
              "set -euo pipefail",
              'if [ "${OMAR_ACTION_OUTCOME}" != "success" ]; then',
              '  echo "::error::Omar Action did not produce authoritative live evidence (failure_class=${OMAR_LLM_FAILURE_CLASS:-unclassified})."',
              "  exit 1",
              "fi",
              'if [ "${OMAR_VALIDATION_OUTCOME}" != "success" ]; then',
              '  echo "::error::Omar Action evidence validation failed closed."',
              "  exit 1",
              "fi",
              'if [ "${OMAR_SECRET_SCAN_OUTCOME}" != "success" ]; then',
              '  echo "::error::Retained Omar evidence did not pass the artifact secret scan."',
              "  exit 1",
              "fi",
              'if [ "${OMAR_ARTIFACT_UPLOAD_OUTCOME}" != "success" ]; then',
              '  echo "::error::Validated Omar evidence was not retained."',
              "  exit 1",
              "fi",
              'if [ "${OMAR_ARTIFACT_DOWNLOAD_OUTCOME}" != "success" ]; then',
              '  echo "::error::Uploaded Omar evidence could not be downloaded for verification."',
              "  exit 1",
              "fi",
              'if [ "${OMAR_ARTIFACT_HANDOFF_OUTCOME}" != "success" ]; then',
              '  echo "::error::Sealed Omar artifact handoff was not digest-verified."',
              "  exit 1",
              "fi",
            ].join("\n"),
          },
          {
            name: "Enforce repository severity policy",
            shell: "bash",
            env: {
              P0_COUNT: "${{ steps.omar_evidence.outputs.p0_count || '' }}",
              P1_COUNT: "${{ steps.omar_evidence.outputs.p1_count || '' }}",
              P2_COUNT: "${{ steps.omar_evidence.outputs.p2_count || '' }}",
              P2_MAX: "${{ github.event_name == 'workflow_dispatch' && inputs.p2_max_allowed || '5' }}",
              SEVERITY_GATE: severityGateExpression,
            },
            run: [
              'set -euo pipefail',
              'p0="$(echo "${P0_COUNT}" | tr -d \'\\r\' | xargs)"',
              'p1="$(echo "${P1_COUNT}" | tr -d \'\\r\' | xargs)"',
              'p2="$(echo "${P2_COUNT}" | tr -d \'\\r\' | xargs)"',
              'p2_max="$(echo "${P2_MAX}" | tr -d \'\\r\' | xargs)"',
              'severity_gate="$(echo "${SEVERITY_GATE}" | tr -d \'\\r\' | xargs)"',
              'case "${p0}" in (\'\'|*[!0-9]*) echo "::error::Invalid validated P0 count"; exit 1;; esac',
              'case "${p1}" in (\'\'|*[!0-9]*) echo "::error::Invalid validated P1 count"; exit 1;; esac',
              'case "${p2}" in (\'\'|*[!0-9]*) echo "::error::Invalid validated P2 count"; exit 1;; esac',
              'case "${p2_max}" in (\'\'|*[!0-9]*) echo "::error::Invalid P2 maximum"; exit 1;; esac',
              'case "${severity_gate}" in',
              '  P0) [ "${p0}" -eq 0 ] || { echo "::error::Omar Gate blocked: P0=${p0}"; exit 1; } ;;',
              '  P1) [ "${p0}" -eq 0 ] && [ "${p1}" -eq 0 ] || { echo "::error::Omar Gate blocked: P0=${p0}, P1=${p1}"; exit 1; } ;;',
              '  P2) [ "${p0}" -eq 0 ] && [ "${p1}" -eq 0 ] && [ "${p2}" -le "${p2_max}" ] || { echo "::error::Omar Gate blocked: P0=${p0}, P1=${p1}, P2=${p2} (max ${p2_max})"; exit 1; } ;;',
              "  none) ;;",
              '  *) echo "::error::Invalid repository severity gate: ${severity_gate}"; exit 1 ;;',
              "esac",
            ].join("\n"),
          },
          {
            name: "Omar summary",
            shell: "bash",
            run: [
              'echo "## Omar Gate" >> "$GITHUB_STEP_SUMMARY"',
              'echo "- gate: \\`${{ steps.omar_evidence.outputs.gate_status }}\\`" >> "$GITHUB_STEP_SUMMARY"',
              'echo "- findings: P0=${{ steps.omar_evidence.outputs.p0_count }} P1=${{ steps.omar_evidence.outputs.p1_count }} P2=${{ steps.omar_evidence.outputs.p2_count }} P3=${{ steps.omar_evidence.outputs.p3_count }}" >> "$GITHUB_STEP_SUMMARY"',
              'echo "- evidence: \\`${{ steps.omar_evidence.outputs.evidence_digest }}\\`" >> "$GITHUB_STEP_SUMMARY"',
              'echo "- idempotency_key: \\`${{ steps.omar_evidence.outputs.idempotency_key }}\\`" >> "$GITHUB_STEP_SUMMARY"',
            ].join("\n"),
          },
        ],
      },
    },
  };

  return YAML.stringify(document, { lineWidth: 0 });
}

export function extractScanActionStep(workflowMarkdown) {
  const parsed = YAML.parse(String(workflowMarkdown || "")) || {};
  const jobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};

  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex] || {};
      const uses = String(step.uses || "").trim();
      if (uses.includes("mrrCarter/sentinelayer-v1-action")) {
        return {
          jobId,
          stepIndex,
          uses,
          with: step.with && typeof step.with === "object" ? step.with : {},
        };
      }
    }
  }

  return null;
}

function collectWorkflowSteps(parsedWorkflow) {
  const jobs = parsedWorkflow?.jobs && typeof parsedWorkflow.jobs === "object"
    ? parsedWorkflow.jobs
    : {};
  const collected = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    steps.forEach((step, stepIndex) => {
      collected.push({ jobId, stepIndex, step: step || {} });
    });
  }
  return collected;
}

export function validatePinnedActionWorkflowInterface(
  workflowMarkdown,
  { requireEvidenceValidator = true } = {}
) {
  const errors = [];
  let parsed;
  try {
    parsed = YAML.parse(String(workflowMarkdown || "")) || {};
  } catch (error) {
    return {
      valid: false,
      errors: [`Workflow YAML is invalid: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const allSteps = collectWorkflowSteps(parsed);
  const actionSteps = allSteps.filter(({ step }) =>
    String(step.uses || "").includes("mrrCarter/sentinelayer-v1-action")
  );
  if (actionSteps.length !== 1) {
    errors.push(`Expected exactly one Sentinelayer Action step, found ${actionSteps.length}.`);
  }

  const declaredInputs = new Set(PINNED_ACTION_INPUT_NAMES);
  for (const { step } of actionSteps) {
    const uses = String(step.uses || "").trim();
    if (uses !== SENTINELAYER_ACTION_REF) {
      errors.push(`Sentinelayer Action must use exact ref ${SENTINELAYER_ACTION_REF}; received ${uses}.`);
    }

    const withConfig = step.with && typeof step.with === "object" ? step.with : {};
    const unsupportedInputs = Object.keys(withConfig).filter((inputName) => !declaredInputs.has(inputName));
    if (unsupportedInputs.length > 0) {
      errors.push(`Sentinelayer Action uses unsupported inputs: ${unsupportedInputs.join(", ")}.`);
    }
    if (String(withConfig.publish_github) !== "false") {
      errors.push("Sentinelayer Action publish_github must be false.");
    }
    if (String(withConfig.severity_gate) !== "none") {
      errors.push("Sentinelayer Action severity_gate must be none.");
    }
    if (String(withConfig.llm_failure_policy) !== "block") {
      errors.push("Sentinelayer Action llm_failure_policy must be block.");
    }

    const scanMode = String(withConfig.scan_mode || "").trim();
    if (!scanMode.includes("${{") && !SUPPORTED_HOSTED_SCAN_MODES.includes(scanMode)) {
      errors.push(`Sentinelayer Action scan_mode is unsupported: ${scanMode || "(missing)"}.`);
    }
    const commentTag = String(withConfig.comment_tag || "");
    if (!commentTag.includes("github.run_id") || !commentTag.includes("github.run_attempt")) {
      errors.push("Sentinelayer Action comment_tag must bind github.run_id and github.run_attempt.");
    }
  }

  const dispatchModes = parsed?.on?.workflow_dispatch?.inputs?.scan_mode?.options;
  if (!Array.isArray(dispatchModes)) {
    errors.push("workflow_dispatch scan_mode options are required.");
  } else if (
    dispatchModes.length !== SUPPORTED_HOSTED_SCAN_MODES.length ||
    dispatchModes.some((mode, index) => mode !== SUPPORTED_HOSTED_SCAN_MODES[index])
  ) {
    errors.push(
      `workflow_dispatch scan_mode options must be exactly ${SUPPORTED_HOSTED_SCAN_MODES.join(", ")}.`
    );
  }

  const serializedWorkflow = JSON.stringify(parsed);
  if (!serializedWorkflow.includes("outputs.idempotency_key")) {
    errors.push("Workflow must surface the Action idempotency_key output.");
  }

  const checkoutStep = allSteps.find(({ step }) => String(step.uses || "").startsWith("actions/checkout@"));
  if (!checkoutStep) {
    errors.push("Workflow must check out the reviewed subject.");
  } else {
    if (String(checkoutStep.step.uses || "") !== CHECKOUT_ACTION_REF) {
      errors.push(`Checkout must use exact ref ${CHECKOUT_ACTION_REF}.`);
    }
    const checkoutRef = String(checkoutStep.step.with?.ref || "");
    if (!checkoutRef.includes("pull_request.head.sha") || !checkoutRef.includes("github.sha")) {
      errors.push("Checkout ref must bind the exact pull-request head or github.sha.");
    }
    if (String(checkoutStep.step.with?.["persist-credentials"]) !== "false") {
      errors.push("Checkout must set persist-credentials to false.");
    }
  }

  const provenanceStep = allSteps.find(({ step }) => step.id === "omar_provenance");
  if (
    !provenanceStep ||
    String(provenanceStep.step.env?.WORKFLOW_SHA || "") !== "${{ github.workflow_sha }}" ||
    !String(provenanceStep.step.run || "").includes("Checked-out subject does not match")
  ) {
    errors.push("Workflow must independently bind checked-out subject and github.workflow_sha provenance.");
  }

  if (requireEvidenceValidator) {
    const validatorSidecarStep = allSteps.find(({ step }) => {
      const run = String(step.run || "");
      return run.includes(`test -f ${GENERATED_EVIDENCE_VALIDATOR_PATH}`);
    });
    if (
      !validatorSidecarStep ||
      String(validatorSidecarStep.step.run || "").includes(GENERATED_EVIDENCE_VALIDATOR_SOURCE_PATH)
    ) {
      errors.push("Workflow must verify the vendored evidence validator without copying repo-local source.");
    }

    const manifestStep = allSteps.find(
      ({ step }) => step.id === "omar_manifest" || step.id === "evidence_manifest"
    );
    if (
      !manifestStep ||
      String(manifestStep.step.env?.OMAR_EVENT_NAME || "") !== "${{ github.event_name }}" ||
      !String(manifestStep.step.run || "").includes('event_name: env("OMAR_EVENT_NAME")')
    ) {
      errors.push("Evidence provenance must bind event_name from github.event_name.");
    }

    const validatorStep = allSteps.find(({ step }) => {
      const run = String(step.run || "");
      return run.includes(GENERATED_EVIDENCE_VALIDATOR_PATH) && run.includes("--input");
    });
    if (!validatorStep) {
      errors.push(`Workflow must invoke ${GENERATED_EVIDENCE_VALIDATOR_PATH}.`);
    } else {
      const validatorRun = String(validatorStep.step.run || "");
      for (const requiredFlag of [
        "--summary-out",
        "--github-output",
        "--workspace-root",
        "--expected-subject-sha",
        "--expected-workflow-sha",
        "--expected-workflow-ref",
      ]) {
        if (!validatorRun.includes(requiredFlag)) {
          errors.push(`Evidence validator invocation is missing ${requiredFlag}.`);
        }
      }
    }

    for (const outputName of [
      "llm_attempted",
      "llm_success",
      "llm_output_valid",
      "llm_no_findings_reported",
      "llm_findings_count",
      "llm_parse_error_count",
      "llm_failure_class",
      "pack_summary_artifact",
      "findings_artifact",
    ]) {
      if (!serializedWorkflow.includes(`outputs.${outputName}`)) {
        errors.push(`Workflow evidence manifest is missing Action output ${outputName}.`);
      }
    }

    const artifactStep = allSteps.find(({ step }) => {
      const run = String(step.run || "");
      return run.includes("original/PACK_SUMMARY.json") && run.includes("original/FINDINGS.jsonl");
    });
    if (!artifactStep) {
      errors.push("Workflow must retain validated original PACK_SUMMARY.json and FINDINGS.jsonl artifacts.");
    } else {
      const artifactRun = String(artifactStep.step.run || "");
      if (
        !artifactRun.includes("staged_pack_sha256") ||
        !artifactRun.includes("staged_findings_sha256") ||
        !artifactRun.includes("OMAR_PACK_SHA256") ||
        !artifactRun.includes("OMAR_FINDINGS_SHA256")
      ) {
        errors.push("Retained PACK_SUMMARY.json and FINDINGS.jsonl must match validated digests.");
      }
    }

    const artifactScannerStep = allSteps.find(({ step }) => {
      const run = String(step.run || "");
      return run.includes(GENERATED_ARTIFACT_SCANNER_PATH) && run.includes("--report");
    });
    if (!artifactScannerStep) {
      errors.push(`Workflow must scan staged evidence with ${GENERATED_ARTIFACT_SCANNER_PATH}.`);
    } else {
      const scannerRun = String(artifactScannerStep.step.run || "");
      for (const fragment of [
        "--manifest",
        "--expected-manifest",
        "archive-files.nul",
        "--verbatim-files-from",
        "--no-recursion",
        "archive_path=omar-upload/omar-gate-artifacts-${archive_sha256}.tar",
        "extracted_pack_sha256",
        "extracted_findings_sha256",
        "rm -rf omar-artifacts omar-archive-verify",
      ]) {
        if (!scannerRun.includes(fragment)) {
          errors.push(`Artifact sealing step is missing ${fragment}.`);
        }
      }
      const uploadStep = allSteps.find(({ step }) => step.id === "omar_artifact_upload");
      if (
        !uploadStep ||
        uploadStep.step.uses !== UPLOAD_ARTIFACT_ACTION_REF ||
        !String(uploadStep.step.if || "").includes("omar_artifact_secret_scan.outcome == 'success'") ||
        String(uploadStep.step.with?.path || "") !==
          "${{ steps.omar_artifact_secret_scan.outputs.archive_path }}" ||
        Number(uploadStep.step.with?.["compression-level"]) !== 0
      ) {
        errors.push("Artifact upload must consume only the sealed scanner output without recompression.");
      }
      const jobOutputs = parsed?.jobs?.[artifactScannerStep.jobId]?.outputs || {};
      if (
        String(jobOutputs.archive_sha256 || "") !==
          "${{ steps.omar_artifact_secret_scan.outputs.archive_sha256 }}" ||
        String(jobOutputs.artifact_id || "") !==
          "${{ steps.omar_artifact_upload.outputs.artifact-id }}" ||
        String(jobOutputs.upload_digest || "") !==
          "${{ steps.omar_artifact_upload.outputs.artifact-digest }}"
      ) {
        errors.push("Workflow outputs must expose the sealed archive and uploaded artifact digests.");
      }
      const downloadStep = allSteps.find(({ step }) => step.id === "omar_artifact_download");
      if (
        !downloadStep ||
        downloadStep.step.uses !== DOWNLOAD_ARTIFACT_ACTION_REF ||
        !String(downloadStep.step.if || "").includes("omar_artifact_upload.outcome == 'success'") ||
        String(downloadStep.step.with?.["artifact-ids"] || "") !==
          "${{ steps.omar_artifact_upload.outputs.artifact-id }}" ||
        downloadStep.step.with?.["merge-multiple"] !== true
      ) {
        errors.push("The exact uploaded artifact id must be downloaded with the pinned verifier Action.");
      }
      const handoffStep = allSteps.find(({ step }) => step.id === "omar_artifact_handoff");
      if (
        !handoffStep ||
        !String(handoffStep.step.if || "").includes("omar_artifact_download.outcome == 'success'") ||
        !String(handoffStep.step.run || "").includes("OMAR_UPLOAD_DIGEST") ||
        !String(handoffStep.step.run || "").includes("actual_sha256") ||
        !String(handoffStep.step.run || "").includes("downloaded_sha256")
      ) {
        errors.push("Artifact upload must be followed by a sealed digest handoff check.");
      }
      const evidenceGateStep = allSteps.find(
        ({ step }) => step.name === "Enforce validated Omar evidence",
      );
      if (
        !evidenceGateStep ||
        !String(evidenceGateStep.step.env?.OMAR_ARTIFACT_HANDOFF_OUTCOME || "").includes(
          "omar_artifact_handoff.outcome",
        ) ||
        !String(evidenceGateStep.step.env?.OMAR_ARTIFACT_DOWNLOAD_OUTCOME || "").includes(
          "omar_artifact_download.outcome",
        )
      ) {
        errors.push("Evidence enforcement must require the sealed artifact handoff.");
      }
      const evidenceGateRun = String(evidenceGateStep?.step.run || "");
      for (const fragment of [
        "OMAR_ACTION_OUTCOME",
        "OMAR_VALIDATION_OUTCOME",
        "OMAR_SECRET_SCAN_OUTCOME",
        "OMAR_ARTIFACT_UPLOAD_OUTCOME",
        "OMAR_ARTIFACT_DOWNLOAD_OUTCOME",
        "OMAR_ARTIFACT_HANDOFF_OUTCOME",
        "exit 1",
      ]) {
        if (!evidenceGateRun.includes(fragment)) {
          errors.push(`Evidence enforcement command is missing ${fragment}.`);
        }
      }
      if (
        uploadStep &&
        downloadStep &&
        handoffStep &&
        (uploadStep.jobId !== downloadStep.jobId ||
          downloadStep.jobId !== handoffStep.jobId ||
          uploadStep.stepIndex >= downloadStep.stepIndex ||
          downloadStep.stepIndex >= handoffStep.stepIndex)
      ) {
        errors.push("Sealed artifact handoff must run after artifact upload.");
      }
    }

    if (validatorStep) {
      const severityStep = allSteps.find(
        ({ jobId, stepIndex, step }) =>
          jobId === validatorStep.jobId &&
          stepIndex > validatorStep.stepIndex &&
          /severity policy|merge thresholds/i.test(String(step.name || ""))
      );
      if (!severityStep) {
        errors.push("Repository severity policy must run after evidence validation.");
      } else {
        const severityRun = String(severityStep.step.run || "");
        for (const fragment of [
          'case "${severity_gate}"',
          '"${p0}"',
          '"${p1}"',
          '"${p2}"',
          "exit 1",
        ]) {
          if (!severityRun.includes(fragment)) {
            errors.push(`Repository severity command is missing ${fragment}.`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateSecurityReviewWorkflow({
  workflowMarkdown,
  expectedProfile,
  expectedSecretName = DEFAULT_SCAN_SECRET_NAME,
} = {}) {
  if (!expectedProfile) {
    throw new Error("Expected scan profile is required for validation.");
  }

  const parsedWorkflow = YAML.parse(String(workflowMarkdown || "")) || {};
  const actionStep = extractScanActionStep(workflowMarkdown);
  const dispatchInputs = parsedWorkflow?.on?.workflow_dispatch?.inputs || {};
  const expected = {
    action: SENTINELAYER_ACTION_REF,
    scan_mode: normalizeHostedScanMode(expectedProfile.scanMode, "deep"),
    action_severity_gate: "none",
    consumer_severity_gate: normalizeSeverityGate(expectedProfile.severityGate),
    publish_github: "false",
    llm_failure_policy: "block",
    secret_name: sanitizeSecretName(expectedSecretName),
  };

  if (!actionStep) {
    return {
      aligned: false,
      expected,
      actual: null,
      mismatches: [
        {
          field: "action",
          expected: expected.action,
          actual: "not found",
          message: "Workflow does not include mrrCarter/sentinelayer-v1-action step.",
        },
      ],
    };
  }

  const withConfig = actionStep.with || {};
  const actual = {
    action: actionStep.uses,
    scan_mode: normalizeMode(dispatchInputs?.scan_mode?.default, ""),
    action_scan_mode: String(withConfig.scan_mode || "").trim(),
    action_severity_gate: normalizeSeverityGate(withConfig.severity_gate),
    consumer_severity_gate: normalizeSeverityGate(dispatchInputs?.severity_gate?.default),
    publish_github: String(withConfig.publish_github || ""),
    llm_failure_policy: String(withConfig.llm_failure_policy || ""),
    secret_name: parseSecretReference(withConfig.sentinelayer_token),
  };

  const interfaceValidation = validatePinnedActionWorkflowInterface(workflowMarkdown);
  const mismatches = interfaceValidation.errors.map((message) => ({
    field: "action_contract",
    expected: "exact pinned Action interface and validated evidence workflow",
    actual: message,
    message,
  }));
  const expectedWorkflowMarkdown = buildSecurityReviewWorkflow({
    secretName: expectedSecretName,
    profile: expectedProfile,
  });
  const normalizeWorkflowText = (value) => String(value).replaceAll("\r\n", "\n");
  if (
    normalizeWorkflowText(workflowMarkdown) !==
    normalizeWorkflowText(expectedWorkflowMarkdown)
  ) {
    mismatches.push({
      field: "workflow_template",
      expected: "byte-identical trusted generated workflow (line endings normalized)",
      actual: "content mismatch",
      message: "Workflow contains executable or policy drift from the trusted generated template.",
    });
  }

  if (actual.action !== expected.action) {
    mismatches.push({
      field: "action",
      expected: expected.action,
      actual: actual.action || "(missing)",
      message: "Action ref does not match the immutable hosted contract.",
    });
  }

  if (actual.scan_mode !== expected.scan_mode) {
    mismatches.push({
      field: "scan_mode",
      expected: expected.scan_mode,
      actual: actual.scan_mode || "(missing)",
      message: "scan_mode does not match spec-derived recommendation.",
    });
  }
  if (
    !actual.action_scan_mode.includes("inputs.scan_mode") ||
    !actual.action_scan_mode.includes(`'${expected.scan_mode}'`)
  ) {
    mismatches.push({
      field: "action_scan_mode",
      expected: `workflow_dispatch scan_mode or '${expected.scan_mode}'`,
      actual: actual.action_scan_mode || "(missing)",
      message: "Action scan_mode is not bound to the validated hosted workflow input.",
    });
  }
  if (actual.action_severity_gate !== expected.action_severity_gate) {
    mismatches.push({
      field: "action_severity_gate",
      expected: expected.action_severity_gate,
      actual: actual.action_severity_gate || "(missing)",
      message: "Action severity must be disabled until live evidence is validated.",
    });
  }
  if (actual.consumer_severity_gate !== expected.consumer_severity_gate) {
    mismatches.push({
      field: "severity_gate",
      expected: expected.consumer_severity_gate,
      actual: actual.consumer_severity_gate || "(missing)",
      message: "Consumer severity_gate does not match the spec-derived recommendation.",
    });
  }
  if (actual.secret_name !== expected.secret_name) {
    mismatches.push({
      field: "sentinelayer_token",
      expected: `\${{ secrets.${expected.secret_name} }}`,
      actual: actual.secret_name ? `\${{ secrets.${actual.secret_name} }}` : "(missing)",
      message: "sentinelayer_token secret binding does not match expected secret name.",
    });
  }

  return {
    aligned: mismatches.length === 0,
    expected,
    actual,
    mismatches,
    location: {
      jobId: actionStep.jobId,
      stepIndex: actionStep.stepIndex,
    },
  };
}

export function buildSecretSetupInstructions(
  secretName = DEFAULT_SCAN_SECRET_NAME,
  { repoSlug = "" } = {}
) {
  const normalizedSecret = sanitizeSecretName(secretName);
  const normalizedRepoSlug = String(repoSlug || "").trim();
  const resolvedRepoSlug = REPO_SLUG_REGEX.test(normalizedRepoSlug)
    ? normalizedRepoSlug
    : "<owner/repo>";
  return [
    "Set the Sentinelayer token secret before relying on this workflow in PR checks:",
    `- gh secret set ${normalizedSecret} --repo ${resolvedRepoSlug}`,
    `- Verify secret visibility: gh secret list --repo ${resolvedRepoSlug}`,
    "- Commit and push .github/workflows/omar-gate.yml",
    "- For manual setup: https://github.com/mrrCarter/create-sentinelayer#manual-fallback-if-auto-injection-is-skipped",
  ];
}


