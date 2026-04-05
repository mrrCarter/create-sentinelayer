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
  auditTools: ["FileRead", "Grep", "Glob", "FrontendAnalyze"],

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

  // Evidence requirements
  evidenceRequirements: [
    "file_path_and_line",
    "reproduction_steps",
    "user_impact_statement",
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

/**
 * All persona visual identities (used by streaming events + terminal display).
 */
export const PERSONA_VISUALS = Object.freeze({
  frontend:        { color: "cyan",    avatar: "\u{1F3AF}", shortName: "Jules",  fullName: "Jules Tanaka" },
  security:        { color: "red",     avatar: "\u{1F6E1}\uFE0F", shortName: "Nina",   fullName: "Nina Patel" },
  backend:         { color: "blue",    avatar: "\u2699\uFE0F",    shortName: "Maya",   fullName: "Maya Volkov" },
  testing:         { color: "green",   avatar: "\u{1F9EA}",       shortName: "Priya",  fullName: "Priya Raman" },
  release:         { color: "yellow",  avatar: "\u{1F680}",       shortName: "Omar",   fullName: "Omar Singh" },
  "code-quality":  { color: "purple",  avatar: "\u{1F48E}",       shortName: "Ethan",  fullName: "Ethan Park" },
  infrastructure:  { color: "orange",  avatar: "\u{1F3D7}\uFE0F", shortName: "Kat",    fullName: "Kat Hughes" },
  data:            { color: "pink",    avatar: "\u{1F5C4}\uFE0F", shortName: "Linh",   fullName: "Linh Tran" },
  observability:   { color: "magenta", avatar: "\u{1F4CA}",       shortName: "Sofia",  fullName: "Sofia Alvarez" },
  reliability:     { color: "white",   avatar: "\u{1F504}",       shortName: "Noah",   fullName: "Noah Ben-David" },
  documentation:   { color: "gray",    avatar: "\u{1F4DD}",       shortName: "Samir",  fullName: "Samir Okafor" },
  "supply-chain":  { color: "brown",   avatar: "\u{1F4E6}",       shortName: "Nora",   fullName: "Nora Kline" },
  "ai-governance": { color: "violet",  avatar: "\u{1F916}",       shortName: "Amina",  fullName: "Amina Chen" },
});

/**
 * Resolve persona visual identity by agent ID or persona name.
 */
export function resolvePersonaVisual(idOrName) {
  if (!idOrName) return null;
  const lower = String(idOrName).toLowerCase();

  // Direct ID match
  if (PERSONA_VISUALS[lower]) return { id: lower, ...PERSONA_VISUALS[lower] };

  // Name match (first name or full name)
  for (const [id, visual] of Object.entries(PERSONA_VISUALS)) {
    if (visual.shortName.toLowerCase() === lower || visual.fullName.toLowerCase() === lower) {
      return { id, ...visual };
    }
  }

  return null;
}

/**
 * List all persona IDs for autocomplete.
 */
export function listPersonaIds() {
  return Object.keys(PERSONA_VISUALS);
}

/**
 * List all persona names (short + full) for autocomplete.
 */
export function listPersonaNames() {
  const names = [];
  for (const [id, visual] of Object.entries(PERSONA_VISUALS)) {
    names.push(id, visual.shortName.toLowerCase(), visual.fullName.toLowerCase());
  }
  return names;
}
