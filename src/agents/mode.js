// Persona mode selector (#A27, spec §Phase 5 / PR #A27).
//
// The persona envelope (PR #A8) is identical between audit and code-gen
// modes. The only per-mode variation:
//   1. The allowed-tools subset. Audit gets read-only tools + domain scans.
//      Codegen gets the read-only tools PLUS file-edit + shell (sandboxed)
//      so the persona can apply fixes.
//   2. The system-prompt suffix. Audit mode appends "Emit findings only.
//      Do not modify files." Codegen mode appends "Apply fixes as minimal
//      edits with clear commit-message summaries."
//
// This module is the single source of truth for those two deltas. Every
// caller that spawns a persona does so through `buildPersonaConfigForMode`;
// same persona, same domain tools, same budget knobs — only the two deltas
// change.

// Persona tool id lists are inlined here instead of imported from each
// persona module. Rationale: this module has to be importable before all
// 12 persona PRs (#A13-A24) have merged to main. Once they do, a future
// refactor can swap these for real imports — the tool-id strings are
// stable anyway.

export const PERSONA_MODES = Object.freeze(["audit", "codegen"]);

// Read-only tool ids that exist in every persona — the audit baseline.
// When a persona is invoked in `audit` mode, it gets the union of its own
// domain tools and these shared scanners. Code-gen mode adds the edit /
// shell tools below on top.
const READONLY_BASELINE = Object.freeze([
  "FileRead",
  "Grep",
  "Glob",
]);

const CODEGEN_EXTRA_TOOLS = Object.freeze([
  "FileEdit",
  "Shell",
]);

const DOMAIN_TOOL_IDS_BY_PERSONA = Object.freeze({
  "ai-governance": Object.freeze(["eval-regression", "hitl-audit", "prompt-drift", "provenance-check"]),
  "backend": Object.freeze(["circuit-breaker-check", "idempotency-audit", "retry-audit", "timeout-audit"]),
  "code-quality": Object.freeze(["complexity-measure", "coupling-analysis", "cycle-detect", "dep-graph"]),
  "data-layer": Object.freeze(["index-audit", "migration-scan", "query-explain", "tenancy-scan"]),
  "documentation": Object.freeze(["api-diff", "dead-link-check", "docstring-coverage", "readme-freshness"]),
  "infrastructure": Object.freeze(["checkov-run", "drift-detect", "iam-least-priv-check", "tflint-run"]),
  "observability": Object.freeze(["alert-audit", "dashboard-gap", "log-schema-check", "span-coverage"]),
  "release": Object.freeze(["changelog-diff", "feature-flag-audit", "rollback-verify", "semver-check"]),
  "reliability": Object.freeze(["backpressure-check", "chaos-probe", "graceful-degradation-check", "health-check-audit"]),
  "security": Object.freeze(["authz-audit", "crypto-review", "sast-scan", "secrets-scan"]),
  "supply-chain": Object.freeze(["attestation-check", "lockfile-integrity", "package-verify", "sbom-diff"]),
  "testing": Object.freeze(["coverage-gap", "flake-detect", "mutation-test", "snapshot-diff"]),
});

const MODE_PROMPT_SUFFIXES = Object.freeze({
  audit: [
    "",
    "You are operating in AUDIT mode.",
    "Emit findings only. Do not modify files. Your output is structured JSON that downstream tooling will rank, dedupe, and present to the reviewer.",
    "When you call a domain tool, the tool writes Finding objects. You decide which of those to elevate into your final report and how to prioritize them.",
  ].join("\n"),
  codegen: [
    "",
    "You are operating in CODE-GEN mode.",
    "Apply fixes as minimal, reviewable edits. Every file you touch must compile / parse; every change should include a one-line commit-message-style rationale.",
    "When you call a domain tool, treat the resulting Finding list as the work queue. Your output is a set of file edits plus an explanation of what you did and what you deliberately left for a human.",
  ].join("\n"),
});

export function normalizePersonaMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (PERSONA_MODES.includes(normalized)) {
    return normalized;
  }
  return "audit";
}

// Return { mode, allowedTools, promptSuffix, personaId } for a persona in
// the requested mode. The only values that depend on mode are allowedTools
// and promptSuffix; everything else (budget, identity, system prompt body)
// is supplied by the persona's own definition.
export function buildPersonaConfigForMode(personaId, mode) {
  const normalizedMode = normalizePersonaMode(mode);
  const normalizedPersona = String(personaId || "").trim().toLowerCase();
  const domainTools = DOMAIN_TOOL_IDS_BY_PERSONA[normalizedPersona] || [];

  const allowedTools = new Set([...READONLY_BASELINE, ...domainTools]);
  if (normalizedMode === "codegen") {
    for (const tool of CODEGEN_EXTRA_TOOLS) {
      allowedTools.add(tool);
    }
  }
  return {
    personaId: normalizedPersona,
    mode: normalizedMode,
    allowedTools: Array.from(allowedTools),
    promptSuffix: MODE_PROMPT_SUFFIXES[normalizedMode],
  };
}

// Quick boolean for callers that just want "can this mode write files?"
export function modeAllowsWrites(mode) {
  return normalizePersonaMode(mode) === "codegen";
}

// Which personas does the mode selector recognize? Useful for tests /
// diagnostics — callers can detect a typo in a persona id before they
// dispatch.
export function listKnownPersonaIds() {
  return Object.keys(DOMAIN_TOOL_IDS_BY_PERSONA).slice().sort();
}

export { READONLY_BASELINE, CODEGEN_EXTRA_TOOLS, MODE_PROMPT_SUFFIXES };
