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

const FULL_DEPTH_PERSONAS = [
  "security",
  "architecture",
  "testing",
  "performance",
  "compliance",
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
