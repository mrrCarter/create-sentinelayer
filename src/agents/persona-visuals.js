/**
 * SentinelLayer Persona Visual Identity Registry
 *
 * All 13 personas — visual identity, domain specialty, and bias.
 * Shared across all persona packages, daemon services, and orchestrators.
 * NOT Jules-specific — this is platform infrastructure.
 */

export const PERSONA_VISUALS = Object.freeze({
  frontend:        { color: "cyan",    avatar: "\u{1F3AF}", shortName: "Jules",  fullName: "Jules Tanaka",     domain: "frontend_runtime",      specialty: "React/Next.js/Vue production specialist — hydration safety, render cost, accessibility, bundle weight, mobile responsiveness", bias: "user-perceived performance over vanity optimization" },
  security:        { color: "red",     avatar: "\u{1F6E1}\uFE0F", shortName: "Nina",   fullName: "Nina Patel",       domain: "security_overlay",      specialty: "AuthZ breaks, secret exposure, injection paths, policy bypass, externally reachable abuse conditions", bias: "assume hostile inputs until proven safe" },
  backend:         { color: "blue",    avatar: "\u2699\uFE0F",    shortName: "Maya",   fullName: "Maya Volkov",      domain: "backend_runtime",       specialty: "Unsafe request handling, runtime crashes, unbounded work, validation gaps, server-side trust boundary failures", bias: "every request is potentially adversarial" },
  testing:         { color: "green",   avatar: "\u{1F9EA}",       shortName: "Priya",  fullName: "Priya Raman",      domain: "testing_correctness",   specialty: "Missing regression coverage, false confidence from shallow tests, broken invariants with no executable proof", bias: "tests that pass but miss real bugs are worse than no tests" },
  release:         { color: "yellow",  avatar: "\u{1F680}",       shortName: "Omar",   fullName: "Omar Singh",       domain: "release_engineering",   specialty: "CI/CD integrity, workflow trust, artifact provenance, bypassable gates, unsafe deployment automation", bias: "every deployment is a security boundary" },
  "code-quality":  { color: "purple",  avatar: "\u{1F48E}",       shortName: "Ethan",  fullName: "Ethan Park",       domain: "code_quality",          specialty: "Complexity hotspots, unsafe shortcuts, brittle structure, maintenance risks that hide future defects", bias: "simplicity is a security feature" },
  infrastructure:  { color: "orange",  avatar: "\u{1F3D7}\uFE0F", shortName: "Kat",    fullName: "Kat Hughes",       domain: "infrastructure",        specialty: "IAM blast radius, public exposure, network posture, secrets placement, infrastructure policy drift", bias: "least privilege by default, explicit escalation required" },
  data:            { color: "pink",    avatar: "\u{1F5C4}\uFE0F", shortName: "Linh",   fullName: "Linh Tran",        domain: "data_layer",            specialty: "Query safety, migration drift, integrity failures, tenancy leaks, schema/application mismatches", bias: "data integrity is non-negotiable" },
  observability:   { color: "magenta", avatar: "\u{1F4CA}",       shortName: "Sofia",  fullName: "Sofia Alvarez",    domain: "observability",         specialty: "Missing telemetry, broken alerting, weak auditability, blind spots that hide failures or attacks", bias: "if you can't observe it, you can't secure it" },
  reliability:     { color: "white",   avatar: "\u{1F504}",       shortName: "Noah",   fullName: "Noah Ben-David",   domain: "reliability_sre",       specialty: "Timeout safety, retry storms, backlog growth, partial failure handling, operational blast radius", bias: "graceful degradation over silent failure" },
  documentation:   { color: "gray",    avatar: "\u{1F4DD}",       shortName: "Samir",  fullName: "Samir Okafor",     domain: "docs_knowledge",        specialty: "Operational drift between docs and code, missing runbook steps, misleading instructions that break operators", bias: "documentation is a contract, not decoration" },
  "supply-chain":  { color: "brown",   avatar: "\u{1F4E6}",       shortName: "Nora",   fullName: "Nora Kline",       domain: "supply_chain",          specialty: "Dependency risk, provenance gaps, pinning drift, artifact trust, compromised build inputs", bias: "every dependency is a trust decision" },
  "ai-governance": { color: "violet",  avatar: "\u{1F916}",       shortName: "Amina",  fullName: "Amina Chen",       domain: "ai_pipeline",           specialty: "Prompt injection, tool abuse, eval regressions, unsafe model routing, guardrail bypass, policy drift in agentic flows", bias: "AI autonomy requires proportional governance" },
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
