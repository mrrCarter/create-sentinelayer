/**
 * devTestBot agent definition.
 *
 * Declarative configuration for the AIdenID-backed browser/system test persona.
 * This persona is intentionally scan-only: it collects runtime evidence and
 * returns redacted findings/artifact paths, never raw user or credential data.
 */

export const DEVTESTBOT_LANES = Object.freeze([
  "console_errors",
  "network_errors",
  "a11y",
  "lighthouse",
  "click_coverage",
  "password_reset_e2e",
]);

export const DEVTESTBOT_DEFINITION = Object.freeze({
  id: "devtestbot",
  persona: "AIdenID devTestBot",
  fullTitle: "SentinelLayer System Test Bot",
  domain: "system_test_runtime",
  signature: "- devTestBot, SentinelLayer System Test Bot",

  color: "green",
  avatar: "DT",
  shortName: "devTestBot",

  permissionMode: "runtime-readonly",
  fixPermissionMode: "none",
  maxTurns: 8,
  maxSubAgents: 4,

  budget: {
    maxCostUsd: 1.5,
    maxOutputTokens: 6000,
    maxRuntimeMs: 600000,
    maxToolCalls: 40,
    warningThresholdPercent: 70,
  },

  auditTools: ["devtestbot.run_session"],
  fixTools: [],
  disallowedTools: ["FileEdit", "Shell"],

  scope: {
    mandate: "scan_only",
    systemTestScope: "full_system_test",
    dataPolicy: "no_data_extraction",
    allowedStateChanges: [
      "explicit test-flow actions against approved targets",
      "ephemeral AIdenID identity flows",
    ],
  },

  lanes: DEVTESTBOT_LANES,

  evidenceRequirements: [
    "artifact_path",
    "runtime_evidence",
    "reproduction",
    "user_impact",
    "confidence",
  ],
  confidenceFloor: 0.8,

  severityExamples: {
    P0: [
      "critical user journey cannot load or complete",
      "password reset exposes credential material",
      "browser execution proves sensitive data disclosure",
    ],
    P1: [
      "password reset cannot complete",
      "runtime exception blocks core flow",
      "server error on critical interaction",
      "critical accessibility blocker on core flow",
    ],
    P2: [
      "non-critical 4xx/5xx response during smoke path",
      "material Lighthouse regression",
      "moderate accessibility violation",
      "uncovered expected click target in configured scope",
    ],
    P3: [
      "runtime evidence gap",
      "non-blocking capture warning",
    ],
  },

  thresholds: {
    lighthousePoorScore: 0.5,
    lighthouseNeedsWorkScore: 0.9,
    confidenceFloor: 0.8,
  },
});

export function listDevTestBotLanes() {
  return [...DEVTESTBOT_LANES];
}
