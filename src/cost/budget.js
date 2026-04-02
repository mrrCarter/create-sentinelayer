function normalizeNumber(value, field) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function formatNumber(value, decimals = 0) {
  return Number(value || 0).toFixed(decimals);
}

function normalizeWarningThresholdPercent(value) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error("warningThresholdPercent must be between 0 and 100.");
  }
  return normalized;
}

function collectLimitStatusWithThreshold({
  reasons,
  warnings,
  usageValue,
  limitValue,
  warningThresholdPercent,
  stopCode,
  warningCode,
  stopMessage,
  warningMessage,
}) {
  const normalizedUsage = normalizeNumber(usageValue, "usageValue");
  const normalizedLimit = normalizeNumber(limitValue, "limitValue");
  const normalizedWarningThresholdPercent =
    normalizeWarningThresholdPercent(warningThresholdPercent);

  if (normalizedLimit <= 0) {
    return;
  }

  if (normalizedUsage > normalizedLimit) {
    reasons.push({
      code: stopCode,
      message: stopMessage(normalizedUsage, normalizedLimit),
    });
    return;
  }

  if (normalizedWarningThresholdPercent <= 0) {
    return;
  }

  const thresholdValue = (normalizedWarningThresholdPercent / 100) * normalizedLimit;
  if (normalizedUsage >= thresholdValue) {
    warnings.push({
      code: warningCode,
      message: warningMessage(normalizedUsage, normalizedLimit, normalizedWarningThresholdPercent),
    });
  }
}

/**
 * Evaluate runtime/cost/token/tool/no-progress budgets and return deterministic stop/warning signals.
 *
 * @param {{
 *   sessionSummary?: {
 *     costUsd?: number,
 *     outputTokens?: number,
 *     noProgressStreak?: number,
 *     durationMs?: number,
 *     toolCalls?: number
 *   },
 *   maxCostUsd?: number,
 *   maxOutputTokens?: number,
 *   maxNoProgress?: number,
 *   maxRuntimeMs?: number,
 *   maxToolCalls?: number,
 *   warningThresholdPercent?: number
 * }} [options]
 * @returns {{
 *   blocking: boolean,
 *   warnings: Array<{ code: string, message: string }>,
 *   reasons: Array<{ code: string, message: string }>,
 *   limits: {
 *     maxCostUsd: number,
 *     maxOutputTokens: number,
 *     maxNoProgress: number,
 *     maxRuntimeMs: number,
 *     maxToolCalls: number,
 *     warningThresholdPercent: number
 *   },
 *   usage: {
 *     costUsd: number,
 *     outputTokens: number,
 *     noProgressStreak: number,
 *     runtimeMs: number,
 *     toolCalls: number
 *   }
 * }}
 */
export function evaluateBudget({
  sessionSummary = {},
  maxCostUsd = 1.0,
  maxOutputTokens = 0,
  maxNoProgress = 3,
  maxRuntimeMs = 0,
  maxToolCalls = 0,
  warningThresholdPercent = 80,
} = {}) {
  const normalizedMaxCost = normalizeNumber(maxCostUsd, "maxCostUsd");
  const normalizedMaxOutputTokens = normalizeNumber(maxOutputTokens, "maxOutputTokens");
  const normalizedMaxNoProgress = Math.max(1, normalizeNumber(maxNoProgress, "maxNoProgress"));
  const normalizedMaxRuntimeMs = normalizeNumber(maxRuntimeMs, "maxRuntimeMs");
  const normalizedMaxToolCalls = normalizeNumber(maxToolCalls, "maxToolCalls");
  const normalizedWarningThresholdPercent = normalizeWarningThresholdPercent(
    warningThresholdPercent
  );

  const totalCostUsd = normalizeNumber(sessionSummary.costUsd || 0, "sessionSummary.costUsd");
  const totalOutputTokens = normalizeNumber(
    sessionSummary.outputTokens || 0,
    "sessionSummary.outputTokens"
  );
  const noProgressStreak = normalizeNumber(
    sessionSummary.noProgressStreak || 0,
    "sessionSummary.noProgressStreak"
  );
  const totalRuntimeMs = normalizeNumber(sessionSummary.durationMs || 0, "sessionSummary.durationMs");
  const totalToolCalls = normalizeNumber(
    sessionSummary.toolCalls || 0,
    "sessionSummary.toolCalls"
  );

  const reasons = [];
  const warnings = [];

  collectLimitStatusWithThreshold({
    reasons,
    warnings,
    usageValue: totalCostUsd,
    limitValue: normalizedMaxCost,
    warningThresholdPercent: normalizedWarningThresholdPercent,
    stopCode: "MAX_COST_EXCEEDED",
    warningCode: "COST_BUDGET_NEAR_LIMIT",
    stopMessage: (usage, limit) =>
      `Cost budget exceeded (${formatNumber(usage, 6)} > ${formatNumber(limit, 6)}).`,
    warningMessage: (usage, limit, thresholdPercent) =>
      `Cost budget near limit (${formatNumber(usage, 6)} / ${formatNumber(limit, 6)} at ${formatNumber(
        thresholdPercent,
        0
      )}%).`,
  });

  collectLimitStatusWithThreshold({
    reasons,
    warnings,
    usageValue: totalOutputTokens,
    limitValue: normalizedMaxOutputTokens,
    warningThresholdPercent: normalizedWarningThresholdPercent,
    stopCode: "MAX_OUTPUT_TOKENS_EXCEEDED",
    warningCode: "OUTPUT_TOKENS_NEAR_LIMIT",
    stopMessage: (usage, limit) =>
      `Output token budget exceeded (${formatNumber(usage, 0)} > ${formatNumber(limit, 0)}).`,
    warningMessage: (usage, limit, thresholdPercent) =>
      `Output token budget near limit (${formatNumber(usage, 0)} / ${formatNumber(
        limit,
        0
      )} at ${formatNumber(thresholdPercent, 0)}%).`,
  });

  collectLimitStatusWithThreshold({
    reasons,
    warnings,
    usageValue: totalRuntimeMs,
    limitValue: normalizedMaxRuntimeMs,
    warningThresholdPercent: normalizedWarningThresholdPercent,
    stopCode: "MAX_RUNTIME_MS_EXCEEDED",
    warningCode: "RUNTIME_MS_NEAR_LIMIT",
    stopMessage: (usage, limit) =>
      `Runtime budget exceeded (${formatNumber(usage, 0)}ms > ${formatNumber(limit, 0)}ms).`,
    warningMessage: (usage, limit, thresholdPercent) =>
      `Runtime budget near limit (${formatNumber(usage, 0)}ms / ${formatNumber(
        limit,
        0
      )}ms at ${formatNumber(thresholdPercent, 0)}%).`,
  });

  collectLimitStatusWithThreshold({
    reasons,
    warnings,
    usageValue: totalToolCalls,
    limitValue: normalizedMaxToolCalls,
    warningThresholdPercent: normalizedWarningThresholdPercent,
    stopCode: "MAX_TOOL_CALLS_EXCEEDED",
    warningCode: "TOOL_CALLS_NEAR_LIMIT",
    stopMessage: (usage, limit) =>
      `Tool-call budget exceeded (${formatNumber(usage, 0)} > ${formatNumber(limit, 0)}).`,
    warningMessage: (usage, limit, thresholdPercent) =>
      `Tool-call budget near limit (${formatNumber(usage, 0)} / ${formatNumber(
        limit,
        0
      )} at ${formatNumber(thresholdPercent, 0)}%).`,
  });

  if (noProgressStreak >= normalizedMaxNoProgress) {
    reasons.push({
      code: "DIMINISHING_RETURNS",
      message: `No-progress streak reached ${formatNumber(noProgressStreak, 0)} (threshold ${formatNumber(
        normalizedMaxNoProgress,
        0
      )}).`,
    });
  }

  return {
    blocking: reasons.length > 0,
    warnings,
    reasons,
    limits: {
      maxCostUsd: normalizedMaxCost,
      maxOutputTokens: normalizedMaxOutputTokens,
      maxNoProgress: normalizedMaxNoProgress,
      maxRuntimeMs: normalizedMaxRuntimeMs,
      maxToolCalls: normalizedMaxToolCalls,
      warningThresholdPercent: normalizedWarningThresholdPercent,
    },
    usage: {
      costUsd: totalCostUsd,
      outputTokens: totalOutputTokens,
      noProgressStreak,
      runtimeMs: totalRuntimeMs,
      toolCalls: totalToolCalls,
    },
  };
}
