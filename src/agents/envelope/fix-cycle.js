/**
 * Iterative fix-cycle helper (#A8 envelope).
 *
 * Pattern: when the envelope loop reports stuckReason or remaining
 * findings, a fix-cycle re-runs the loop with an amended prompt and a
 * reduced toolset, bounded by maxCycles. Used by personas that want
 * Jules-tier "try until green" behavior.
 */

import { runEnvelopeLoop } from "./loop.js";

export const DEFAULT_MAX_CYCLES = 3;

/**
 * @param {object} params
 * @param {Function} params.runCycle         — async ({ cycle }) => { findings, messages, stuckReason, ... }
 * @param {Function} [params.isResolved]     — sync (result) => boolean; default: findings empty AND no stuckReason
 * @param {number}   [params.maxCycles]
 */
export async function runFixCycle({
  runCycle,
  isResolved,
  maxCycles = DEFAULT_MAX_CYCLES,
} = {}) {
  if (typeof runCycle !== "function") {
    throw new TypeError("runFixCycle requires a runCycle function");
  }
  const checkResolved = typeof isResolved === "function"
    ? isResolved
    : (result) => Array.isArray(result?.findings) && result.findings.length === 0 && !result?.stuckReason;

  const history = [];
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const result = await runCycle({ cycle });
    history.push(result);
    if (checkResolved(result)) {
      return { resolved: true, cyclesUsed: cycle, history };
    }
  }
  return { resolved: false, cyclesUsed: maxCycles, history };
}

// Re-export runEnvelopeLoop so consumers can import the whole kit
// from one module path in downstream PRs.
export { runEnvelopeLoop };
