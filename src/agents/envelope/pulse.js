/**
 * Stuck-detection pulse (#A8 envelope).
 *
 * Called by the loop after each turn. If the agent has emitted zero
 * tool calls for `threshold` consecutive turns, the loop short-circuits
 * with stuckReason="no-tool-calls" — prevents infinite reasoning
 * without action.
 */

/**
 * @param {Array<{turn: number, hadToolCalls: boolean}>} turnStates
 * @param {number} threshold
 */
export function detectStuck(turnStates, threshold = 2) {
  if (!Array.isArray(turnStates) || turnStates.length < threshold) return false;
  const recent = turnStates.slice(-threshold);
  return recent.every((state) => state.hadToolCalls === false);
}
