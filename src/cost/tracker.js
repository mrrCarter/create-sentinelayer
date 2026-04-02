const DEFAULT_MODEL_PRICING = Object.freeze({
  "gpt-4o": Object.freeze({
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10.0,
  }),
  "gpt-5.3-codex": Object.freeze({
    inputPerMillionUsd: 1.5,
    outputPerMillionUsd: 6.0,
  }),
  "claude-sonnet-4": Object.freeze({
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
  }),
  "claude-sonnet-4.5": Object.freeze({
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
  }),
  "gemini-2.5-pro": Object.freeze({
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10.0,
  }),
});

function normalizeTokenCount(value, field) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function normalizeUsd(value, field) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function roundUsd(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

/**
 * Estimate cost in USD from token counts and per-million pricing inputs.
 *
 * @param {{
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   inputPerMillionUsd?: number,
 *   outputPerMillionUsd?: number
 * }} [options]
 * @returns {number}
 */
export function estimateCostUsd({
  inputTokens = 0,
  outputTokens = 0,
  inputPerMillionUsd = 0,
  outputPerMillionUsd = 0,
} = {}) {
  const normalizedInputTokens = normalizeTokenCount(inputTokens, "inputTokens");
  const normalizedOutputTokens = normalizeTokenCount(outputTokens, "outputTokens");
  const normalizedInputRate = normalizeUsd(inputPerMillionUsd, "inputPerMillionUsd");
  const normalizedOutputRate = normalizeUsd(outputPerMillionUsd, "outputPerMillionUsd");

  const inputCost = (normalizedInputTokens / 1_000_000) * normalizedInputRate;
  const outputCost = (normalizedOutputTokens / 1_000_000) * normalizedOutputRate;

  return roundUsd(inputCost + outputCost);
}

/**
 * Estimate cost in USD using a named model pricing table entry.
 *
 * @param {{
 *   modelId: string,
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   pricingTable?: Record<string, { inputPerMillionUsd: number, outputPerMillionUsd: number }>
 * }} [options]
 * @returns {number}
 */
export function estimateModelCost({
  modelId,
  inputTokens = 0,
  outputTokens = 0,
  pricingTable = DEFAULT_MODEL_PRICING,
} = {}) {
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedModelId) {
    throw new Error("modelId is required for model-based cost estimation.");
  }

  const modelPricing = pricingTable[normalizedModelId];
  if (!modelPricing) {
    throw new Error(`No pricing data configured for model '${normalizedModelId}'.`);
  }

  return estimateCostUsd({
    inputTokens,
    outputTokens,
    inputPerMillionUsd: modelPricing.inputPerMillionUsd,
    outputPerMillionUsd: modelPricing.outputPerMillionUsd,
  });
}

/**
 * Aggregate usage rows into a single token and cost summary.
 *
 * @param {Array<{ inputTokens?: number, outputTokens?: number, costUsd?: number }>} [entries]
 * @returns {{ inputTokens: number, outputTokens: number, costUsd: number }}
 */
export function rollupUsage(entries = []) {
  if (!Array.isArray(entries)) {
    throw new Error("entries must be an array.");
  }

  const totals = entries.reduce(
    (accumulator, entry) => {
      const inputTokens = normalizeTokenCount(entry?.inputTokens || 0, "entry.inputTokens");
      const outputTokens = normalizeTokenCount(entry?.outputTokens || 0, "entry.outputTokens");
      const costUsd = normalizeUsd(entry?.costUsd || 0, "entry.costUsd");

      return {
        inputTokens: accumulator.inputTokens + inputTokens,
        outputTokens: accumulator.outputTokens + outputTokens,
        costUsd: accumulator.costUsd + costUsd,
      };
    },
    { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  );

  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    costUsd: roundUsd(totals.costUsd),
  };
}

/**
 * Evaluate whether cumulative cost has exceeded a configured budget.
 *
 * @param {{ totalCostUsd?: number, budgetUsd?: number }} [options]
 * @returns {{ budgetUsd: number, totalCostUsd: number, remainingUsd: number, exceeded: boolean }}
 */
export function enforceCostBudget({ totalCostUsd = 0, budgetUsd = 0 } = {}) {
  const normalizedTotal = normalizeUsd(totalCostUsd, "totalCostUsd");
  const normalizedBudget = normalizeUsd(budgetUsd, "budgetUsd");
  const remainingUsd = roundUsd(Math.max(0, normalizedBudget - normalizedTotal));

  return {
    budgetUsd: roundUsd(normalizedBudget),
    totalCostUsd: roundUsd(normalizedTotal),
    remainingUsd,
    exceeded: normalizedTotal > normalizedBudget,
  };
}

/**
 * Return the built-in model pricing catalog for diagnostics and UI display.
 *
 * @returns {Array<{ modelId: string, inputPerMillionUsd: number, outputPerMillionUsd: number }>}
 */
export function listKnownModelPricing() {
  return Object.entries(DEFAULT_MODEL_PRICING).map(([modelId, pricing]) => ({
    modelId,
    inputPerMillionUsd: pricing.inputPerMillionUsd,
    outputPerMillionUsd: pricing.outputPerMillionUsd,
  }));
}

