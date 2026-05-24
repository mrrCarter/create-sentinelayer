import { recordCliLlmSessionUsage, usageNumber } from "../billing/llm-session-usage.js";
import { sanitizeBillingMetadata } from "../billing/ledger-entry.js";

export const INVESTOR_DD_USAGE_ACTIONS = Object.freeze({
  devTestBotPlanner: "investor_dd_devtestbot_planner",
  filePlanner: "investor_dd_file_planner",
});

export class InvestorDdUsageLedgerError extends Error {
  constructor(message, result = null) {
    super(message);
    this.name = "InvestorDdUsageLedgerError";
    this.code = "INVESTOR_DD_USAGE_LEDGER_FAILED";
    this.result = result;
  }
}

export function isInvestorDdUsageLedgerError(error) {
  return error instanceof InvestorDdUsageLedgerError
    || String(error?.code || "") === "INVESTOR_DD_USAGE_LEDGER_FAILED";
}

function normalizeString(value) {
  return String(value || "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeBool(value) {
  return value === true || value === "true" || value === "1";
}

function modelFrom(response, fallback) {
  return normalizeString(response?.usage?.model)
    || normalizeString(response?.model)
    || normalizeString(fallback)
    || "gpt-5.3-codex";
}

function providerFrom(response, fallback) {
  return normalizeString(response?.usage?.provider)
    || normalizeString(response?.provider)
    || normalizeString(fallback);
}

function normalizeUsageContext(usageContext = {}, defaults = {}) {
  const context = plainObject(usageContext);
  const fallback = plainObject(defaults);
  return {
    sessionId: normalizeString(context.sessionId || fallback.sessionId),
    agentId: normalizeString(context.agentId || fallback.agentId),
    model: normalizeString(context.model || fallback.model),
    provider: normalizeString(context.provider || fallback.provider),
    targetPath: normalizeString(context.targetPath || fallback.targetPath),
    billingTier: normalizeString(context.billingTier || fallback.billingTier) || "internal",
    sourceCommand: normalizeString(context.sourceCommand || fallback.sourceCommand) || "omargate investor-dd",
    syncRemote: context.syncRemote !== undefined ? context.syncRemote !== false : fallback.syncRemote !== false,
    required: normalizeBool(context.required ?? fallback.required),
    recorder: typeof context.recorder === "function"
      ? context.recorder
      : typeof fallback.recorder === "function"
        ? fallback.recorder
        : recordCliLlmSessionUsage,
  };
}

function firstProviderUsageNumber(usage, keys) {
  const source = plainObject(usage);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const parsed = Number(source[key]);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return { found: true, value: Math.floor(parsed) };
    }
  }
  return { found: false, value: 0 };
}

function usageFailure(context, reason, message) {
  const result = {
    ok: false,
    reason,
    required: context.required,
  };
  if (context.required) {
    throw new InvestorDdUsageLedgerError(message, result);
  }
  return result;
}

export function assertInvestorDdUsageContextReady({
  usageContext = {},
  defaults = {},
  action,
  agentId = "",
  model = "",
  targetPath = "",
} = {}) {
  const context = normalizeUsageContext(usageContext, {
    ...defaults,
    agentId,
    model,
    targetPath,
  });
  if (!context.required) {
    return { ok: true, required: false };
  }
  const normalizedAction = normalizeString(action);
  const normalizedAgentId = normalizeString(agentId || context.agentId);
  const normalizedModel = normalizeString(model || context.model);
  if (!context.sessionId || !normalizedAgentId || !normalizedAction || !normalizedModel) {
    throw new InvestorDdUsageLedgerError(
      "Investor-DD required usage ledger context is incomplete before planner spend.",
      {
        ok: false,
        reason: "missing_session_usage_context",
        required: true,
      },
    );
  }
  return { ok: true, required: true };
}

export async function recordInvestorDdLlmUsage({
  usageContext = {},
  defaults = {},
  action,
  agentId = "",
  phase = "",
  response = "",
  model = "",
  provider = "",
  startedAtIso = "",
  targetPath = "",
  metadata = {},
} = {}) {
  const context = normalizeUsageContext(usageContext, {
    ...defaults,
    agentId,
    model,
    provider,
    targetPath,
  });
  const normalizedAction = normalizeString(action);
  const normalizedAgentId = normalizeString(agentId || context.agentId);
  const normalizedModel = modelFrom(response, model || context.model);
  const normalizedProvider = providerFrom(response, provider || context.provider);
  const createdAt = normalizeString(startedAtIso) || new Date().toISOString();

  if (!context.sessionId || !normalizedAgentId || !normalizedAction || !normalizedModel) {
    const result = {
      ok: false,
      reason: "missing_session_usage_context",
      required: context.required,
    };
    if (context.required) {
      throw new InvestorDdUsageLedgerError("Investor-DD session usage context is required.", result);
    }
    return result;
  }

  const usage = plainObject(response?.usage);
  const input = firstProviderUsageNumber(usage, ["inputTokens", "input_tokens", "tokens_in"]);
  const output = firstProviderUsageNumber(usage, ["outputTokens", "output_tokens", "tokens_out"]);
  if (!input.found && !output.found) {
    return usageFailure(
      context,
      "missing_provider_usage",
      "Investor-DD planner response did not include provider token usage.",
    );
  }
  const inputTokens = usageNumber(input.value, 0);
  const outputTokens = usageNumber(output.value, 0);
  if (inputTokens + outputTokens <= 0) {
    return usageFailure(
      context,
      "zero_provider_tokens",
      "Investor-DD planner response reported zero provider tokens.",
    );
  }

  try {
    const result = await context.recorder({
      sessionId: context.sessionId,
      agentId: normalizedAgentId,
      action: normalizedAction,
      model: normalizedModel,
      inputTokens,
      outputTokens,
      startedAtIso: createdAt,
      targetPath: context.targetPath,
      billingTier: context.billingTier,
      sourceCommand: context.sourceCommand,
      provider: normalizedProvider,
      syncRemote: context.syncRemote,
      metadata: sanitizeBillingMetadata({
        phase,
        ...plainObject(metadata),
      }),
    });
    if ((!result || result.ok === false) && context.required) {
      throw new InvestorDdUsageLedgerError(
        `Investor-DD session usage ledger failed: ${result?.reason || "unknown"}`,
        result || null,
      );
    }
    return {
      ...(result || { ok: false, reason: "missing_result" }),
      inputTokens,
      outputTokens,
      action: normalizedAction,
    };
  } catch (error) {
    if (error instanceof InvestorDdUsageLedgerError) throw error;
    const result = {
      ok: false,
      reason: error instanceof Error ? error.message : String(error || "session_usage_failed"),
      required: context.required,
    };
    if (context.required) {
      throw new InvestorDdUsageLedgerError(result.reason, result);
    }
    return result;
  }
}
