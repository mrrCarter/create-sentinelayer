/**
 * Scan mode → persona list resolution for Omar Gate.
 *
 * baseline: security only (~30s)
 * deep:     6 key personas (~2min)
 * audit:    alias for full-depth
 * full-depth: all 13 personas (~5min)
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
  deep: ["security", "architecture", "testing", "performance", "compliance", "reliability"],
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
