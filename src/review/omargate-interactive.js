/**
 * Interactive post-scan menu for Omar Gate deep-dive.
 *
 * After the scan completes, prompts the user to select a domain agent
 * for full agentic loop analysis (multi-turn, tool-using).
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import pc from "picocolors";

import { PERSONA_IDS } from "./persona-prompts.js";

/**
 * Show interactive persona selection after Omar Gate scan.
 *
 * @param {object} options
 * @param {object} options.scanResult - Result from runOmarGateOrchestrator
 * @returns {Promise<string|null>} Selected persona ID, "all", or null (skip)
 */
export async function promptPersonaDeepDive({ scanResult } = {}) {
  const summary = scanResult?.summary || {};
  const personas = scanResult?.personas || [];

  console.log("");
  console.log(pc.bold("Omar Gate scan complete."));
  console.log(
    `Findings: P0=${summary.P0 || 0} P1=${summary.P1 || 0} P2=${summary.P2 || 0} P3=${summary.P3 || 0} | ` +
      `Cost: $${(scanResult?.totalCostUsd || 0).toFixed(4)} | ` +
      `Duration: ${((scanResult?.totalDurationMs || 0) / 1000).toFixed(1)}s`
  );
  console.log("");

  // Show persona results
  for (const p of personas) {
    const icon = p.status === "ok" ? pc.green("✓") : p.status === "skipped" ? pc.gray("○") : pc.red("✗");
    const count = p.findings || 0;
    console.log(`  ${icon} ${p.id} — ${count} finding${count === 1 ? "" : "s"}`);
  }

  console.log("");
  console.log(pc.gray("Deep-dive runs a full agentic loop (multi-turn, tool-using) for deeper analysis."));
  console.log(pc.gray(`Available: ${PERSONA_IDS.join(", ")}, all, none`));
  console.log("");

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(pc.cyan("Deep-dive into which agent? [none] "));
    const normalized = String(answer || "").trim().toLowerCase();

    if (!normalized || normalized === "none" || normalized === "n" || normalized === "skip") {
      return null;
    }

    if (normalized === "all") {
      return "all";
    }

    if (PERSONA_IDS.includes(normalized)) {
      return normalized;
    }

    console.log(pc.yellow(`Unknown agent '${normalized}'. Skipping deep-dive.`));
    return null;
  } finally {
    rl.close();
  }
}
