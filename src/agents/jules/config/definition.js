/**
 * Jules Tanaka — Agent Definition
 *
 * Declarative configuration for the Jules Tanaka frontend audit persona.
 * Used by the audit orchestrator and standalone invocation to configure
 * tools, budget, scope, persona identity, and visual styling.
 */

export const JULES_DEFINITION = Object.freeze({
  id: "frontend",
  persona: "Jules Tanaka",
  fullTitle: "SentinelLayer Frontend Specialist",
  domain: "frontend_runtime",
  signature: "— Jules Tanaka, SentinelLayer Frontend Specialist",

  // Visual identity
  color: "cyan",
  avatar: "\u{1F3AF}", // 🎯
  shortName: "Jules",

  // Execution constraints
  permissionMode: "plan", // read-only for audit
  fixPermissionMode: "worktree", // worktree isolation for fix mode
  maxTurns: 25,
  maxSubAgents: 4,

  // Budget
  budget: {
    maxCostUsd: 5.0,
    maxOutputTokens: 12000,
    maxRuntimeMs: 300000, // 5 minutes
    maxToolCalls: 150,
    warningThresholdPercent: 70,
  },

  // Tool access (audit mode)
  auditTools: ["FileRead", "Grep", "Glob", "FrontendAnalyze", "RuntimeAudit", "AuthAudit"],

  // Tool access (fix mode — adds write capabilities in worktree)
  fixTools: ["FileRead", "Grep", "Glob", "FrontendAnalyze", "FileEdit", "Shell"],

  // Tools never allowed
  disallowedTools: [],

  // Scope patterns (used when no explicit scope map provided)
  defaultScope: {
    primaryPatterns: [
      "src/app/**", "src/pages/**", "src/components/**",
      "src/hooks/**", "src/contexts/**", "src/providers/**",
      "app/**", "pages/**", "components/**",
    ],
    secondaryPatterns: [
      "src/lib/**", "src/utils/**", "src/styles/**",
      "src/middleware.*", "next.config.*", "vite.config.*",
      "tailwind.config.*", "webpack.config.*",
    ],
    tertiaryPatterns: [
      "tests/**", "**/*.test.*", "**/*.spec.*",
      "**/*.stories.*", "cypress/**", "playwright/**",
    ],
  },

  // Evidence requirements (aligned with output contract in system-prompt.js)
  evidenceRequirements: [
    "file_and_line",
    "evidence",
    "user_impact",
    "reproduction_p0_p1",
    "confidence",
  ],
  confidenceFloor: 0.75,

  // Escalation
  escalationTargets: ["security", "testing", "performance"],

  // Agent modes
  modes: {
    primary: "maximize recall over the reachable frontend runtime graph",
    secondary: "attack blind spots: SSR/CSR seams, middleware, caching, headers, providers, tests, CI, mobile",
    tertiary: "adversarial verifier: falsify weak findings, detect contamination, collapse noise",
  },

  // Swarm configuration (for large codebases)
  swarm: {
    spawnThresholds: {
      minFiles: 15,
      minRouteGroups: 3,
      minLoc: 5000,
    },
    maxFilesPerScanner: 12,
    maxConcurrent: 4,
    hunterTypes: ["xss", "state", "hydration", "a11y", "perf", "security"],
  },

  // Performance thresholds (SWE Excellence Framework defaults)
  thresholds: {
    LCP_good_ms: 2500,
    LCP_poor_ms: 4000,
    INP_good_ms: 200,
    INP_poor_ms: 500,
    CLS_good: 0.1,
    CLS_poor: 0.25,
    initial_js_target_kb: 200,
    initial_js_critical_kb: 500,
    initial_css_target_kb: 50,
    per_route_chunk_target_kb: 100,
    per_route_chunk_critical_kb: 200,
    useState_normal: 5,
    useState_scrutiny: 10,
    useState_refactor: 15,
    useState_god: 16,
    component_loc_hotspot: 300,
    component_loc_god: 700,
  },

  // Severity model
  severityExamples: {
    P0: [
      "white screen or hydration crash on critical route",
      "clearly poor mobile LCP on key journey",
      "broken keyboard-only critical flow",
      "unsafe HTML injection on untrusted content",
      "core journey impossible to complete on mobile",
    ],
    P1: [
      "severe bundle bloat on hot route",
      "repeated stale-closure / cleanup bugs in critical UI",
      "major accessibility failures on core flow",
      "broken cache/data refresh behavior",
      "strong evidence of jank on frequent interaction",
    ],
    P2: [
      "localized but real performance regressions",
      "medium-sized god components",
      "weak error/loading states",
      "missing mobile fallback in important but non-core surfaces",
      "weak regression coverage for risky touched code",
    ],
  },

  // Automation safety classification
  automationSafety: {
    green: "auto-safe, no user-flow change",
    yellow: "draft + human approval + QA signoff",
    red: "escalate, no autonomous change",
    alwaysYellowOrRed: [
      "auth flow", "payment UI", "data collection",
      "trust-critical UX", "cookie/session handling",
      "third-party script loading",
    ],
  },
});

// Re-export from shared persona-visuals. These cover all 13 personas — not Jules-specific.
export {
  PERSONA_VISUALS,
  resolvePersonaVisual,
  listPersonaIds,
  listPersonaNames,
} from "../../persona-visuals.js";
