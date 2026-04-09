/**
 * Scan mode → persona list resolution for Omar Gate.
 *
 * baseline: security only (~30s)
 * deep:     6 key personas (~2min)
 * full-depth: all 13 personas (~5min)
 */

const SCAN_MODES = {
  baseline: ["security"],
  deep: ["security", "architecture", "testing", "performance", "compliance", "reliability"],
  "full-depth": [
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
  ],
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
