/**
 * Deterministic file routing engine for investor-DD.
 *
 * Given the full list of files in a target repo and the persona roster,
 * produce a routing table `{ personaId: filesInScope[] }` based on
 * domain-specific include/exclude patterns. The router is deterministic
 * (same inputs → same routing) so a run is replayable, and overlap is
 * allowed — a single file can land in multiple persona queues if the
 * patterns match.
 *
 * When a persona has NO matches after pattern filtering, the router
 * falls back to a capped subset of "risk-surface" files (entry points,
 * config, routes) so the persona still has something to look at rather
 * than silently reporting empty coverage.
 */

const POSIX_SEP = "/";

/**
 * Per-persona include/exclude rules. Rules are substring checks against
 * POSIX-normalized relative paths (so they survive Windows/linux). Glob
 * matchers are intentionally avoided here — every rule is a simple
 * includes() check so the routing is easy to reason about and unit-test.
 */
export const INVESTOR_DD_PERSONA_RULES = Object.freeze({
  security: {
    include: [
      "/auth",
      "/security",
      "/crypto",
      "/token",
      "/password",
      "/session",
      "/login",
      "/oauth",
      "/permission",
      "/role",
      "/sanitiz",
      "/escape",
      "/middleware",
    ],
    extensions: [".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java"],
    exclude: ["/__fixtures__/", "/test-data/"],
  },
  backend: {
    include: [
      "/server",
      "/api",
      "/handler",
      "/route",
      "/controller",
      "/service",
      "/worker",
      "/queue",
      "/job",
      "/middleware",
    ],
    extensions: [".js", ".ts", ".py", ".go", ".rs", ".java"],
    exclude: ["/__fixtures__/", "/test-data/", "/web/", "/frontend/"],
  },
  "code-quality": {
    include: [
      "/src/",
      "/lib/",
      "/app/",
      "/packages/",
    ],
    extensions: [".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java"],
    exclude: ["/node_modules/", "/dist/", "/build/", "/__snapshots__/", "/vendor/"],
  },
  testing: {
    include: [
      "/test/",
      "/tests/",
      "/__tests__/",
      ".test.",
      ".spec.",
      "_test.",
      "/conftest.py",
    ],
    extensions: [".js", ".ts", ".tsx", ".jsx", ".mjs", ".py", ".go", ".rs", ".java"],
    exclude: ["/node_modules/", "/dist/"],
  },
  "data-layer": {
    include: [
      "/db/",
      "/database/",
      "/models/",
      "/schema",
      "/migration",
      "/query",
      "/repository",
      "/repositories/",
      "/dao",
      ".sql",
      "/prisma/",
      "/sequelize/",
      "/orm/",
    ],
    extensions: [".js", ".ts", ".py", ".sql", ".prisma"],
    exclude: ["/node_modules/"],
  },
  reliability: {
    include: [
      "/health",
      "/readiness",
      "/liveness",
      "/retry",
      "/circuit",
      "/fallback",
      "/backpressure",
      "/rate-limit",
      "/degradation",
    ],
    extensions: [".js", ".ts", ".py", ".go"],
    exclude: ["/node_modules/"],
  },
  release: {
    include: [
      ".github/workflows/",
      "/ci/",
      "CHANGELOG",
      "/release",
      "/deploy",
      "/rollout",
      "/version",
      "/feature-flag",
      "/feature_flag",
      "/flags",
    ],
    extensions: [".yml", ".yaml", ".js", ".ts", ".py", ".md"],
    exclude: [],
  },
  observability: {
    include: [
      "/logger",
      "/logging",
      "/metric",
      "/trace",
      "/telemetry",
      "/span",
      "/dashboard",
      "/grafana",
      "/alert",
      "/monitor",
    ],
    extensions: [".js", ".ts", ".py", ".go", ".yml", ".yaml", ".json"],
    exclude: [],
  },
  infrastructure: {
    include: [
      "/terraform/",
      ".tf",
      ".tfvars",
      "/kubernetes/",
      "/k8s/",
      "/manifests/",
      "/helm/",
      "/docker",
      "Dockerfile",
      ".github/workflows/",
      "/cdk/",
      "/pulumi/",
      "/serverless",
    ],
    extensions: [".tf", ".yaml", ".yml", ".json", ".hcl"],
    exclude: [],
  },
  "supply-chain": {
    include: [
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "requirements.txt",
      "pyproject.toml",
      "Pipfile.lock",
      "go.mod",
      "go.sum",
      "Cargo.toml",
      "Cargo.lock",
      "Gemfile",
      "Gemfile.lock",
      ".github/workflows/",
      "SBOM",
      "sbom",
    ],
    extensions: [],
    exclude: ["/node_modules/"],
  },
  frontend: {
    include: [
      "/frontend/",
      "/web/",
      "/client/",
      "/pages/",
      "/components/",
      "/app/",
      "/ui/",
      "/views/",
      "/templates/",
      ".vue",
      ".svelte",
      ".astro",
    ],
    extensions: [".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".html", ".css", ".scss"],
    exclude: ["/server/", "/api/", "/node_modules/"],
  },
  documentation: {
    include: [
      "README",
      "CHANGELOG",
      "CONTRIBUTING",
      "SECURITY",
      "CODE_OF_CONDUCT",
      "/docs/",
      ".md",
      ".mdx",
      ".rst",
    ],
    extensions: [".md", ".mdx", ".rst", ".txt"],
    exclude: ["/node_modules/"],
  },
  "ai-governance": {
    include: [
      "/prompt",
      "/prompts/",
      "/llm/",
      "/ai/",
      "/agent",
      "/eval",
      "/evals/",
      "/guardrail",
      "/safety",
      "/completion",
      "/inference",
      "/embeddings",
      "/rag",
    ],
    extensions: [".py", ".js", ".ts", ".yaml", ".yml", ".json", ".md"],
    exclude: [],
  },
});

const DEFAULT_FALLBACK_CAP = 20;

const RISK_SURFACE_HINTS = Object.freeze([
  "/server",
  "/api",
  "/main",
  "/index",
  "/app",
  "/route",
  "/handler",
  "/auth",
  "Dockerfile",
  "/.github/workflows/",
]);

/**
 * Normalize a path to POSIX separators so the substring rules are
 * portable across OSes.
 *
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return String(p || "").split(/[\\/]/).join(POSIX_SEP);
}

/**
 * Return true if `file` matches the persona rule: includes any of the
 * include substrings AND (extensions empty OR matches an extension) AND
 * excludes none of the exclude substrings.
 *
 * @param {string} file           - POSIX-normalized path.
 * @param {object} rule
 * @param {string[]} rule.include
 * @param {string[]} rule.exclude
 * @param {string[]} rule.extensions
 * @returns {boolean}
 */
export function matchesRule(file, rule) {
  if (!rule) return false;
  const include = rule.include || [];
  const exclude = rule.exclude || [];
  const extensions = rule.extensions || [];

  for (const pattern of exclude) {
    if (file.includes(pattern)) return false;
  }

  let includeMatch = false;
  for (const pattern of include) {
    if (file.includes(pattern)) {
      includeMatch = true;
      break;
    }
  }
  if (!includeMatch) return false;

  if (extensions.length === 0) return true;

  for (const ext of extensions) {
    if (file.endsWith(ext)) return true;
  }

  // Files with no extension (e.g. Dockerfile, Makefile, Procfile) should
  // still match when the rule's include pattern explicitly names them —
  // the include hit already proved domain relevance.
  const basename = file.split(POSIX_SEP).pop() || "";
  if (!basename.includes(".")) {
    for (const pattern of include) {
      if (basename === pattern || basename.includes(pattern)) return true;
    }
  }
  return false;
}

/**
 * Simple heuristic scoring for fallback ranking. Higher = more risk-
 * surface-like. Path segments known to harbor crosscutting concerns
 * (auth/server/api/middleware/index/main) score higher.
 *
 * @param {string} file
 * @returns {number}
 */
export function scoreRiskSurface(file) {
  let score = 0;
  for (const hint of RISK_SURFACE_HINTS) {
    if (file.includes(hint)) score += 10;
  }
  // Prefer shallower files (closer to repo root → more likely entry points)
  const depth = file.split(POSIX_SEP).length;
  score += Math.max(0, 10 - depth);
  return score;
}

/**
 * Route the full file list to each persona's queue.
 *
 * @param {object} params
 * @param {string[]} params.files          - All candidate files (relative POSIX paths or raw).
 * @param {string[]} params.personas       - Persona IDs to route to.
 * @param {object}   [params.rules]        - Custom rule map (defaults to INVESTOR_DD_PERSONA_RULES).
 * @param {number}   [params.fallbackCap]  - Max fallback files when rule yields 0 (default 20).
 * @returns {Record<string, string[]>}     - { personaId: filesInScope[] }
 */
export function routeFilesToPersonas({
  files = [],
  personas = [],
  rules = INVESTOR_DD_PERSONA_RULES,
  fallbackCap = DEFAULT_FALLBACK_CAP,
} = {}) {
  const normalized = files.map(toPosix);
  const routing = {};

  // Pre-compute fallback list once: risk-surface-sorted, capped.
  const fallbackPool = [...normalized]
    .sort((a, b) => scoreRiskSurface(b) - scoreRiskSurface(a))
    .slice(0, fallbackCap);

  for (const personaId of personas) {
    const rule = rules[personaId];
    if (!rule) {
      routing[personaId] = [];
      continue;
    }

    const matched = normalized.filter((f) => matchesRule(f, rule));
    routing[personaId] = matched.length > 0 ? matched : [...fallbackPool];
  }

  return routing;
}

/**
 * Produce a dense coverage summary suitable for persisting as part of a
 * run's `plan.json` artifact.
 *
 * @param {Record<string, string[]>} routing
 * @returns {{ totalFilesByPersona: Record<string, number>, uniqueFiles: number, dedupIndex: Record<string, string[]> }}
 */
export function summarizeRouting(routing) {
  const totalFilesByPersona = {};
  const fileToPersonas = new Map();

  for (const [personaId, files] of Object.entries(routing || {})) {
    totalFilesByPersona[personaId] = files.length;
    for (const file of files) {
      if (!fileToPersonas.has(file)) fileToPersonas.set(file, []);
      fileToPersonas.get(file).push(personaId);
    }
  }

  const dedupIndex = {};
  for (const [file, personas] of fileToPersonas.entries()) {
    dedupIndex[file] = [...personas];
  }

  return {
    totalFilesByPersona,
    uniqueFiles: fileToPersonas.size,
    dedupIndex,
  };
}
