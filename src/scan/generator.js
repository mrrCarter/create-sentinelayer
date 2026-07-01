import YAML from "yaml";

export const DEFAULT_SCAN_WORKFLOW_PATH = ".github/workflows/omar-gate.yml";
export const DEFAULT_SCAN_SECRET_NAME = "SENTINELAYER_TOKEN";
export const SENTINELAYER_ACTION_REF = "mrrCarter/sentinelayer-v1-action@03d7369cba7de2e9f15b959275c982111f0ee493";
export const SUPPORTED_E2E_HINTS = Object.freeze(["auto", "yes", "no"]);
export const SUPPORTED_PLAYWRIGHT_MODES = Object.freeze(["auto", "off", "baseline", "audit"]);

const CHECKOUT_ACTION_REF = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const SETUP_NODE_ACTION_REF = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const UPLOAD_ARTIFACT_ACTION_REF = "actions/upload-artifact@50769540e7f4bd5e21e526ee35c689e35e0d6874";
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

  const scanMode = deepScanRecommended ? "deep" : "baseline";
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

export function buildSecurityReviewWorkflow({ secretName = DEFAULT_SCAN_SECRET_NAME, profile } = {}) {
  if (!profile) {
    throw new Error("Scan profile is required to build workflow config.");
  }
  const normalizedSecret = sanitizeSecretName(secretName);

  const document = {
    name: "Omar Gate",
    on: {
      pull_request: {
        types: ["opened", "synchronize", "reopened"],
      },
      workflow_dispatch: {
        inputs: {
          scan_mode: {
            description: "Sentinelayer scan profile",
            required: false,
            default: profile.scanMode || "deep",
            type: "choice",
            options: ["baseline", "deep", "audit", "full-depth"],
          },
          severity_gate: {
            description: "Severity threshold that blocks merge",
            required: false,
            default: profile.severityGate || "P1",
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
        permissions: {
          contents: "read",
          checks: "write",
          "pull-requests": "write",
          "id-token": "write",
        },
        steps: [
          {
            name: "Checkout",
            uses: CHECKOUT_ACTION_REF,
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
              '  echo "Skipping — run locally: npx sentinelayer-cli@latest /omargate deep --path ."',
              '  exit 0',
              'fi',
            ].join("\n"),
          },
          {
            name: "Run Omar Gate",
            id: "omar",
            uses: SENTINELAYER_ACTION_REF,
            with: {
              github_token: "${{ github.token }}",
              sentinelayer_token: `\${{ secrets.${normalizedSecret} }}`,
              sentinelayer_managed_llm: "true",
              scan_mode: profile.scanMode || "deep",
              severity_gate: profile.severityGate || "P1",
              model: "gpt-5.3-codex",
              codex_model: "gpt-5.3-codex",
              model_fallback: "gpt-4.1-mini",
              use_codex: "true",
              codex_only: "false",
              llm_failure_policy: "block",
              max_daily_scans: "${{ vars.OMAR_MAX_DAILY_SCANS || '200' }}",
              min_scan_interval_minutes: "${{ vars.OMAR_MIN_SCAN_INTERVAL_MINUTES || '0' }}",
              rate_limit_fail_mode: "closed",
              playwright_mode: profile.playwrightMode || "off",
              sbom_mode: profile.sbomMode || "off",
              wait_for_completion: "true",
            },
          },
          {
            name: "Enforce merge thresholds",
            shell: "bash",
            env: {
              P0_COUNT: "${{ steps.omar.outputs.p0_count || '0' }}",
              P1_COUNT: "${{ steps.omar.outputs.p1_count || '0' }}",
              P2_COUNT: "${{ steps.omar.outputs.p2_count || '0' }}",
              P2_MAX: "${{ github.event_name == 'workflow_dispatch' && inputs.p2_max_allowed || '5' }}",
            },
            run: [
              'set -euo pipefail',
              'p0="$(echo "${P0_COUNT}" | tr -d \'\\r\' | xargs)"',
              'p1="$(echo "${P1_COUNT}" | tr -d \'\\r\' | xargs)"',
              'p2="$(echo "${P2_COUNT}" | tr -d \'\\r\' | xargs)"',
              'p2_max="$(echo "${P2_MAX}" | tr -d \'\\r\' | xargs)"',
              'if [ "${p0:-0}" -gt 0 ] || [ "${p1:-0}" -gt 0 ]; then',
              '  echo "::error::Omar Gate blocked: P0=${p0}, P1=${p1}"',
              '  exit 1',
              'fi',
              'if [ "${p2:-0}" -gt "${p2_max:-5}" ]; then',
              '  echo "::error::Omar Gate blocked: P2=${p2} exceeds max ${p2_max}"',
              '  exit 1',
              'fi',
            ].join("\n"),
          },
          {
            name: "Omar summary",
            shell: "bash",
            run: [
              'echo "## Omar Gate" >> "$GITHUB_STEP_SUMMARY"',
              'echo "- gate: \\`${{ steps.omar.outputs.gate_status }}\\`" >> "$GITHUB_STEP_SUMMARY"',
              'echo "- findings: P0=${{ steps.omar.outputs.p0_count }} P1=${{ steps.omar.outputs.p1_count }} P2=${{ steps.omar.outputs.p2_count }} P3=${{ steps.omar.outputs.p3_count }}" >> "$GITHUB_STEP_SUMMARY"',
            ].join("\n"),
          },
          {
            name: "Stage Omar summary artifact",
            shell: "bash",
            env: {
              OMAR_RUN_ID: "${{ steps.omar.outputs.run_id || '' }}",
              OMAR_GATE_STATUS: "${{ steps.omar.outputs.gate_status || '' }}",
              OMAR_P0: "${{ steps.omar.outputs.p0_count || '0' }}",
              OMAR_P1: "${{ steps.omar.outputs.p1_count || '0' }}",
              OMAR_P2: "${{ steps.omar.outputs.p2_count || '0' }}",
              OMAR_P3: "${{ steps.omar.outputs.p3_count || '0' }}",
              OMAR_SCAN_MODE: "${{ github.event_name == 'workflow_dispatch' && inputs.scan_mode || 'deep' }}",
              OMAR_SEVERITY_GATE: "${{ github.event_name == 'workflow_dispatch' && inputs.severity_gate || 'P1' }}",
              OMAR_P2_MAX_ALLOWED: "${{ github.event_name == 'workflow_dispatch' && inputs.p2_max_allowed || '5' }}",
            },
            run: [
              "set -euo pipefail",
              "mkdir -p omar-artifacts",
              "python3 - <<'PY'",
              "import json",
              "import os",
              "from pathlib import Path",
              "",
              "def env(name, default=''):",
              "    return os.environ.get(name, default)",
              "",
              "def int_env(name):",
              "    value = env(name, '0').strip()",
              "    return int(value) if value.isdigit() else 0",
              "",
              "github_run_id = env('GITHUB_RUN_ID')",
              "server_url = env('GITHUB_SERVER_URL', 'https://github.com').rstrip('/')",
              "repository = env('GITHUB_REPOSITORY')",
              "run_url = f'{server_url}/{repository}/actions/runs/{github_run_id}' if repository and github_run_id else ''",
              "summary = {",
              "    'schema_version': 1,",
              "    'kind': 'omar_gate_summary',",
              "    'run_id': env('OMAR_RUN_ID'),",
              "    'gate_status': env('OMAR_GATE_STATUS'),",
              "    'findings': {",
              "        'P0': int_env('OMAR_P0'),",
              "        'P1': int_env('OMAR_P1'),",
              "        'P2': int_env('OMAR_P2'),",
              "        'P3': int_env('OMAR_P3'),",
              "    },",
              "    'threshold': {",
              "        'severity_gate': env('OMAR_SEVERITY_GATE', 'P1'),",
              "        'p2_max_allowed': int_env('OMAR_P2_MAX_ALLOWED'),",
              "    },",
              "    'scan': {",
              "        'mode': env('OMAR_SCAN_MODE', 'deep'),",
              `        'action_ref': '${SENTINELAYER_ACTION_REF}',`,
              "        'managed_llm': True,",
              "        'llm_failure_policy': 'block',",
              "    },",
              "    'github': {",
              "        'repository': repository,",
              "        'sha': env('GITHUB_SHA'),",
              "        'ref': env('GITHUB_REF'),",
              "        'event_name': env('GITHUB_EVENT_NAME'),",
              "        'workflow': env('GITHUB_WORKFLOW'),",
              "        'run_id': github_run_id,",
              "        'run_attempt': env('GITHUB_RUN_ATTEMPT'),",
              "        'run_url': run_url,",
              "    },",
              "}",
              "Path('omar-artifacts/summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\\n', encoding='utf-8')",
              "PY",
            ].join("\n"),
          },
          {
            name: "Upload Omar summary artifact",
            uses: UPLOAD_ARTIFACT_ACTION_REF,
            with: {
              name: "omar-gate-artifacts",
              path: "omar-artifacts/summary.json",
              "if-no-files-found": "error",
            },
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

export function validateSecurityReviewWorkflow({
  workflowMarkdown,
  expectedProfile,
  expectedSecretName = DEFAULT_SCAN_SECRET_NAME,
} = {}) {
  if (!expectedProfile) {
    throw new Error("Expected scan profile is required for validation.");
  }

  const actionStep = extractScanActionStep(workflowMarkdown);
  const expected = {
    action: "mrrCarter/sentinelayer-v1-action",
    scan_mode: normalizeMode(expectedProfile.scanMode, "deep"),
    severity_gate: normalizeSeverityGate(expectedProfile.severityGate),
    playwright_mode: normalizeMode(expectedProfile.playwrightMode, "off"),
    sbom_mode: normalizeMode(expectedProfile.sbomMode, "off"),
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
    scan_mode: normalizeMode(withConfig.scan_mode, ""),
    severity_gate: normalizeSeverityGate(withConfig.severity_gate),
    playwright_mode: normalizeMode(withConfig.playwright_mode, "off"),
    sbom_mode: normalizeMode(withConfig.sbom_mode, "off"),
    secret_name: parseSecretReference(withConfig.sentinelayer_token),
  };

  const mismatches = [];

  if (actual.scan_mode !== expected.scan_mode) {
    mismatches.push({
      field: "scan_mode",
      expected: expected.scan_mode,
      actual: actual.scan_mode || "(missing)",
      message: "scan_mode does not match spec-derived recommendation.",
    });
  }
  if (actual.severity_gate !== expected.severity_gate) {
    mismatches.push({
      field: "severity_gate",
      expected: expected.severity_gate,
      actual: actual.severity_gate || "(missing)",
      message: "severity_gate does not match spec-derived recommendation.",
    });
  }
  if (actual.playwright_mode !== expected.playwright_mode) {
    mismatches.push({
      field: "playwright_mode",
      expected: expected.playwright_mode,
      actual: actual.playwright_mode || "(missing)",
      message: "playwright_mode does not match e2e/spec profile.",
    });
  }
  if (actual.sbom_mode !== expected.sbom_mode) {
    mismatches.push({
      field: "sbom_mode",
      expected: expected.sbom_mode,
      actual: actual.sbom_mode || "(missing)",
      message: "sbom_mode does not match supply-chain profile.",
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


