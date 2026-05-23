import { buildBillingRunId, buildCallIdempotencyKey, stableHash } from "./ledger-entry.js";
import { recordSessionUsage } from "./session-usage.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function nonNegativeInteger(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function usageNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  const parsedFallback = Number(fallback || 0);
  return Number.isFinite(parsedFallback) && parsedFallback >= 0 ? parsedFallback : 0;
}

export async function recordCliLlmSessionUsage({
  sessionId,
  agentId,
  action,
  model,
  inputTokens = 0,
  outputTokens = 0,
  startedAtIso = "",
  targetPath,
  billingTier = "internal",
  sourceCommand = "",
  provider = "",
  metadata = {},
  syncRemote = true,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedAgentId = normalizeString(agentId);
  const normalizedAction = normalizeString(action);
  const normalizedModel = normalizeString(model);
  const createdAt = normalizeString(startedAtIso) || new Date().toISOString();
  const safeInputTokens = nonNegativeInteger(inputTokens);
  const safeOutputTokens = nonNegativeInteger(outputTokens);

  if (!normalizedSessionId || !normalizedAgentId || !normalizedAction || !normalizedModel) {
    return { ok: false, reason: "missing_session_usage_fields" };
  }
  if (safeInputTokens + safeOutputTokens <= 0) {
    return { ok: false, reason: "zero_tokens" };
  }

  try {
    const configHash = stableHash(
      JSON.stringify({
        action: normalizedAction,
        agentId: normalizedAgentId,
        model: normalizedModel,
        provider: normalizeString(provider),
        sourceCommand: normalizeString(sourceCommand),
        metadata,
      }),
    );
    const billingRunId = buildBillingRunId({
      sessionId: normalizedSessionId,
      invocationTimestamp: createdAt,
      configHash,
    });
    return await recordSessionUsage(
      normalizedSessionId,
      {
        agentId: normalizedAgentId,
        action: normalizedAction,
        model: normalizedModel,
        inputTokens: safeInputTokens,
        outputTokens: safeOutputTokens,
        idempotencyKey: buildCallIdempotencyKey({ runId: billingRunId, callIndex: 0 }),
        billingTier,
        createdAt,
        metadata: {
          sourceCommand,
          provider,
          ...metadata,
        },
      },
      { targetPath, syncRemote },
    );
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error || "session_usage_failed"),
    };
  }
}
