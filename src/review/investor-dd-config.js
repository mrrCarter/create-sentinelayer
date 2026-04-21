// Investor-DD mode configuration scaffold.
//
// Subsequent PRs in the docs/INVESTOR_DD_ARCHITECTURE.md sequence consume
// these constants. Keeping them in a dedicated module so future PRs can
// extend without touching the command definition or the legacy dispatch.

export const INVESTOR_DD_VERSION = "1.0.0";

// Budget defaults — see architecture doc "Cost model" section.
export const INVESTOR_DD_DEFAULT_MAX_COST_USD = 25.0;
export const INVESTOR_DD_DEFAULT_MAX_RUNTIME_MINUTES = 45;
export const INVESTOR_DD_DEFAULT_MAX_PARALLEL = 3;

// Lower concurrency than /omargate deep (4) — each persona now runs a
// multi-turn per-file loop rather than a single-shot call, so concurrent
// file I/O + LLM calls compete for the same rate-limit pool.

// Compliance pack opt-in flags. HIPAA is opt-in because surfacing PHI
// requires customer consent; SOC 2 / ISO 27001 / GDPR run by default
// once the pack scaffolds land (Batch 6).
export const INVESTOR_DD_SUPPORTED_COMPLIANCE_PACKS = Object.freeze([
  "soc2",        // Trust Service Criteria 2017 + 2022
  "iso27001",    // Annex A relevant controls
  "gdpr",        // Data-subject rights + lawful basis
  "ccpa",        // California equivalents
  "hipaa",       // Opt-in, requires --compliance-pack hipaa
  "license",     // SPDX + SBOM parity
  "dr",          // Disaster recovery / RPO-RTO / failover
]);

// Artifact directory inside the run's root. Each PR in Batch 5 writes a
// specific file here (plan.json, stream.ndjson, report.md, etc.).
export const INVESTOR_DD_ARTIFACT_SUBDIR = "investor-dd";

// Slash command token. Consumers should reference this constant rather
// than a string literal so renaming stays deterministic.
export const INVESTOR_DD_COMMAND_TOKEN = "investor-dd";

export function resolveInvestorDdBudget(options = {}) {
  const maxCostUsd = Number(options.maxCostUsd);
  const maxRuntimeMinutes = Number(options.maxRuntimeMinutes);
  const maxParallel = Number(options.maxParallel);
  return {
    maxCostUsd: Number.isFinite(maxCostUsd) && maxCostUsd > 0
      ? maxCostUsd
      : INVESTOR_DD_DEFAULT_MAX_COST_USD,
    maxRuntimeMinutes: Number.isFinite(maxRuntimeMinutes) && maxRuntimeMinutes > 0
      ? Math.floor(maxRuntimeMinutes)
      : INVESTOR_DD_DEFAULT_MAX_RUNTIME_MINUTES,
    maxParallel: Number.isFinite(maxParallel) && maxParallel > 0
      ? Math.floor(maxParallel)
      : INVESTOR_DD_DEFAULT_MAX_PARALLEL,
  };
}
