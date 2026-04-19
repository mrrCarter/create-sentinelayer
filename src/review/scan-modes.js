/**
 * Scan mode → persona list resolution for Omar Gate.
 *
 * baseline:   security only (~30s)
 * deep:       all 13 personas (~3-5min) — alias of full-depth from v0.7+
 * audit:      alias for full-depth
 * full-depth: all 13 personas (~3-5min)
 *
 * v0.7 change (2026-04-16): `deep` was a 6-persona subset and missed
 * domain specialists (Maya/backend, Jules/frontend, Nora/supply-chain,
 * Samir/documentation, etc.). Users running `sl /omargate deep` expected
 * a full dispatch. Deep now matches full-depth to prevent silent coverage
 * gaps; run `baseline` when you only need security.
 */

// AUTHORITATIVE dispatch list. Anything not in this array does not run,
// regardless of whether it has a persona prompt or visual identity elsewhere.
//
// Cross-reference (keep in sync):
// - src/review/persona-prompts.js PERSONA_PROMPTS keys → must match this list
// - src/review/persona-prompts.js SWE_FRAMEWORK_CHECKLIST keys → must match this list
// - src/agents/persona-visuals.js → may define SUPERSET (visuals for sub-specialties
//   are allowed, e.g. Maya Volkov has both "architecture" and "backend" visuals
//   because both roles fold into her architecture dispatch).
//
// Canon update (2026-04-18): "backend" (Maya Volkov, ex-AWS Platform),
// "code-quality" (Ethan Park, ex-Meta Code Health), and "data-layer"
// (Dr. Linh Tran, ex-Netflix Data Platforms) are now dispatched personas
// per Carter's canonical 13.
// Removed:
// - "architecture" — structural concerns fold into code-quality; runtime
//   concerns fold into backend.
// - "performance" — concerns distributed across backend / data-layer /
//   frontend / observability / reliability.
// - "compliance" — cross-cutting; distributed across security / ai-governance /
//   supply-chain / infrastructure / documentation via subagent dispatch.
const FULL_DEPTH_PERSONAS = [
  "security",
  "backend",
  "code-quality",
  "testing",
  "data-layer",
  "reliability",
  "release",
  "observability",
  "infrastructure",
  "supply-chain",
  "frontend",
  "documentation",
  "ai-governance",
];

const SCAN_MODES = {
  baseline: ["security"],
  deep: FULL_DEPTH_PERSONAS,
  "full-depth": FULL_DEPTH_PERSONAS,
  audit: FULL_DEPTH_PERSONAS,
};

export function resolveScanMode(mode = "deep") {
  const normalized = String(mode || "deep").trim().toLowerCase();
  const personas = SCAN_MODES[normalized];
  if (!personas) {
    throw new Error(`Unknown scan mode '${mode}'. Use: ${Object.keys(SCAN_MODES).join(", ")}`);
  }
  return { mode: normalized, personas: [...personas] };
}

export const AVAILABLE_SCAN_MODES = Object.keys(SCAN_MODES);

/**
 * Parse a comma-separated persona ID list from CLI input.
 *
 * Trims whitespace, lowercases, drops empty entries, deduplicates.
 *
 * @param {string | string[] | null | undefined} value
 * @returns {string[]} Cleaned persona ID list.
 */
export function parsePersonaCsv(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const cleaned = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...new Set(cleaned)];
}

/**
 * Resolve a scan mode and then filter the persona list by opt-in / opt-out lists.
 *
 * Precedence:
 *   1. Start with the base persona list for `mode`.
 *   2. If `includeOnly` is a non-empty array, restrict to those IDs (in the
 *      order they appear in the base list, for deterministic dispatch).
 *   3. Remove any IDs in `skipPersonas`.
 *
 * If a caller passes `includeOnly` IDs that aren't in the base list, they
 * are silently dropped (not errored) so typos don't block a run. The caller
 * can check `result.unknown` to surface warnings in the UI.
 *
 * @param {string} [mode="deep"]
 * @param {object} [options]
 * @param {string[]} [options.includeOnly]  Only run these personas.
 * @param {string[]} [options.skipPersonas] Skip these personas.
 * @returns {{mode: string, personas: string[], dropped: string[], unknown: string[]}}
 */
export function resolveFilteredPersonas(mode = "deep", options = {}) {
  const { includeOnly = null, skipPersonas = [] } = options || {};
  const { mode: normalized, personas: base } = resolveScanMode(mode);

  const basePersonas = [...base];
  let filtered = basePersonas;
  const unknown = [];

  if (Array.isArray(includeOnly) && includeOnly.length > 0) {
    const normalizedInclude = new Set(
      includeOnly.map((p) => String(p).trim().toLowerCase()).filter(Boolean),
    );
    // Surface any include entries that aren't in the base mode list.
    for (const id of normalizedInclude) {
      if (!basePersonas.includes(id)) unknown.push(id);
    }
    filtered = basePersonas.filter((id) => normalizedInclude.has(id));
  }

  const dropped = [];
  if (Array.isArray(skipPersonas) && skipPersonas.length > 0) {
    const normalizedSkip = new Set(
      skipPersonas.map((p) => String(p).trim().toLowerCase()).filter(Boolean),
    );
    filtered = filtered.filter((id) => {
      if (normalizedSkip.has(id)) {
        dropped.push(id);
        return false;
      }
      return true;
    });
  }

  return {
    mode: normalized,
    personas: filtered,
    dropped,
    unknown,
  };
}
