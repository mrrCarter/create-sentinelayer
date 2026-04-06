import YAML from "yaml";

export const DEFAULT_SCAN_WORKFLOW_PATH = ".github/workflows/omar-gate.yml";
export const DEFAULT_SCAN_SECRET_NAME = "SENTINELAYER_TOKEN";
export const SENTINELAYER_ACTION_REF = "mrrCarter/sentinelayer-v1-action@55a2c158f637d7d92e26ab0ef3ba81db791da4be";
export const SUPPORTED_E2E_HINTS = Object.freeze(["auto", "yes", "no"]);
export const SUPPORTED_PLAYWRIGHT_MODES = Object.freeze(["auto", "off", "baseline", "audit"]);

const CHECKOUT_ACTION_REF = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683";
const SETUP_NODE_ACTION_REF = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
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
      workflow_dispatch: {},
    },
    permissions: {
      contents: "read",
      "pull-requests": "write",
      checks: "write",
    },
    jobs: {
      omar_gate: {
        name: "Omar Gate",
        "runs-on": "ubuntu-22.04",
        "timeout-minutes": 20,
        steps: [
          {
            name: "Checkout",
            uses: CHECKOUT_ACTION_REF,
          },
          {
            name: "Setup Node",
            uses: SETUP_NODE_ACTION_REF,
            with: {
              "node-version": "20",
              cache: "npm",
            },
          },
          {
            name: "Install dependencies",
            run: "npm ci",
          },
          {
            name: "Run repository verification",
            run: "npm run verify",
          },
          {
            name: "Run Omar Gate",
            uses: SENTINELAYER_ACTION_REF,
            with: {
              sentinelayer_token: `\${{ secrets.${normalizedSecret} }}`,
              scan_mode: profile.scanMode,
              severity_gate: profile.severityGate,
              playwright_mode: profile.playwrightMode,
              sbom_mode: profile.sbomMode,
              wait_for_completion: "true",
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
    "- For manual setup: https://sentinelayer.com/docs/getting-started/install-workflow",
  ];
}


