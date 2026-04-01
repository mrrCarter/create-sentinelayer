function normalizeNumber(value, field) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

export function evaluateBudget({
  sessionSummary = {},
  maxCostUsd = 1.0,
  maxOutputTokens = 0,
  maxNoProgress = 3,
} = {}) {
  const normalizedMaxCost = normalizeNumber(maxCostUsd, "maxCostUsd");
  const normalizedMaxOutputTokens = normalizeNumber(maxOutputTokens, "maxOutputTokens");
  const normalizedMaxNoProgress = Math.max(1, normalizeNumber(maxNoProgress, "maxNoProgress"));

  const totalCostUsd = normalizeNumber(sessionSummary.costUsd || 0, "sessionSummary.costUsd");
  const totalOutputTokens = normalizeNumber(
    sessionSummary.outputTokens || 0,
    "sessionSummary.outputTokens"
  );
  const noProgressStreak = normalizeNumber(
    sessionSummary.noProgressStreak || 0,
    "sessionSummary.noProgressStreak"
  );

  const reasons = [];
  if (totalCostUsd > normalizedMaxCost) {
    reasons.push({
      code: "MAX_COST_EXCEEDED",
      message: `Cost budget exceeded (${totalCostUsd.toFixed(6)} > ${normalizedMaxCost.toFixed(6)}).`,
    });
  }

  if (normalizedMaxOutputTokens > 0 && totalOutputTokens > normalizedMaxOutputTokens) {
    reasons.push({
      code: "MAX_OUTPUT_TOKENS_EXCEEDED",
      message: `Output token budget exceeded (${totalOutputTokens} > ${normalizedMaxOutputTokens}).`,
    });
  }

  if (noProgressStreak >= normalizedMaxNoProgress) {
    reasons.push({
      code: "DIMINISHING_RETURNS",
      message: `No-progress streak reached ${noProgressStreak} (threshold ${normalizedMaxNoProgress}).`,
    });
  }

  return {
    blocking: reasons.length > 0,
    reasons,
    limits: {
      maxCostUsd: normalizedMaxCost,
      maxOutputTokens: normalizedMaxOutputTokens,
      maxNoProgress: normalizedMaxNoProgress,
    },
    usage: {
      costUsd: totalCostUsd,
      outputTokens: totalOutputTokens,
      noProgressStreak,
    },
  };
}

