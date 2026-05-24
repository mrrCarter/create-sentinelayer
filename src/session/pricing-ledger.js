import { createHash } from "node:crypto";

import {
  DEFAULT_PRICE_BOOK_VERSION,
  estimateModelCost,
} from "../cost/tracker.js";

const SESSION_USAGE_EVENT = "session_usage";

function n(value) {
  return String(value == null ? "" : value).trim();
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nonNegativeInt(value) {
  const parsed = nonNegativeNumber(value);
  return parsed == null ? null : Math.floor(parsed);
}

function money(value) {
  const parsed = nonNegativeNumber(value);
  return parsed == null ? null : Math.round(parsed * 1_000_000) / 1_000_000;
}

function pick(sources, keys) {
  for (const source of sources) {
    const bag = object(source);
    for (const key of keys) {
      if (bag[key] != null && bag[key] !== "") return bag[key];
    }
  }
  return null;
}

function pickText(sources, keys) {
  return n(pick(sources, keys));
}

function pickInt(sources, keys) {
  return nonNegativeInt(pick(sources, keys)) ?? 0;
}

function pickMoney(sources, keys) {
  return money(pick(sources, keys));
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

export function createSessionUsageLedgerId({
  sessionId = "",
  agentId = "",
  action = "",
  idempotencyKey = "",
} = {}) {
  const digest = createHash("sha256")
    .update([sessionId, agentId, action, idempotencyKey].map(n).join("\x1f"))
    .digest("hex")
    .slice(0, 32);
  return `bill_${digest}`;
}

function fallbackIdempotencyKey({ sessionId, event, agentId, action, model, totalTokens }) {
  const sequence = n(event.sequenceId ?? event.sequence_id);
  if (sequence) return `seq:${sequence}`;
  const timestamp = n(event.ts || event.timestamp);
  const interaction = n(object(event.payload).interactionId || object(event.payload).interaction_id);
  const source = [sessionId, timestamp, agentId, action, model, totalTokens, interaction].join("\x1f");
  return `event:${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

function providerCostFromPriceBook({ model, inputTokens, outputTokens, explicitProviderCost }) {
  if (explicitProviderCost != null) {
    return { providerCostUsd: explicitProviderCost, unpriced: false };
  }
  if (inputTokens <= 0 && outputTokens <= 0) {
    return { providerCostUsd: 0, unpriced: false };
  }
  try {
    return {
      providerCostUsd: estimateModelCost({ modelId: model, inputTokens, outputTokens }),
      unpriced: false,
    };
  } catch {
    return { providerCostUsd: 0, unpriced: true };
  }
}

export function buildUsageLedgerEntry(
  event,
  { sessionId = "", priceBookVersion = DEFAULT_PRICE_BOOK_VERSION, billingTier = "unknown" } = {},
) {
  const kind = n(event?.event || event?.type);
  if (kind !== SESSION_USAGE_EVENT) return null;

  const payload = object(event?.payload);
  const usage = object(payload.usage);
  const prompt = object(payload.prompt);
  const response = object(payload.response);
  const agent = object(event?.agent);
  const sources = [payload, usage];

  const agentId =
    pickText(sources, ["agentId", "agent_id"]) ||
    n(agent.id || event?.agentId) ||
    "unknown";
  const model =
    pickText(sources, ["model", "modelId", "model_id"]) ||
    n(agent.model || event?.agentModel) ||
    "unknown";
  const action =
    pickText(sources, ["action", "operation", "kind", "billingAction", "billing_action"]) ||
    "agent_message";
  const resolvedPriceBook =
    pickText(sources, ["priceBookVersion", "price_book_version", "pricingVersion", "pricing_version"]) ||
    priceBookVersion;
  const resolvedBillingTier =
    pickText(sources, ["billingTier", "billing_tier", "tier"]) ||
    n(billingTier) ||
    "unknown";

  const inputTokens =
    pickInt(sources, ["inputTokens", "input_tokens", "tokensIn", "tokens_in", "promptTokens", "prompt_tokens"]) ||
    pickInt([prompt], ["tokens", "tokenCount", "token_count"]);
  const outputTokens =
    pickInt(sources, ["outputTokens", "output_tokens", "tokensOut", "tokens_out", "completionTokens", "completion_tokens"]) ||
    pickInt([response], ["tokens", "tokenCount", "token_count"]);
  const explicitTotalTokens = pickInt(sources, ["totalTokens", "total_tokens", "tokens", "tokenTotal", "token_total"]);
  const totalTokens = explicitTotalTokens || inputTokens + outputTokens;
  const explicitProviderCost = pickMoney(sources, ["providerCostUsd", "provider_cost_usd", "costUsd", "cost_usd", "cost"]);
  const customerCostUsd = pickMoney(sources, ["customerCostUsd", "customer_cost_usd", "billableCostUsd", "billable_cost_usd"]);
  const { providerCostUsd, unpriced } = providerCostFromPriceBook({
    model,
    inputTokens,
    outputTokens,
    explicitProviderCost,
  });

  const idempotencyKey =
    pickText(sources, ["idempotencyKey", "idempotency_key", "runKey", "run_key"]) ||
    pickText(sources, ["interactionId", "interaction_id"]) ||
    fallbackIdempotencyKey({ sessionId, event, agentId, action, model, totalTokens });
  const ledgerEntryId =
    pickText(sources, ["ledgerEntryId", "ledger_entry_id", "billingEventId", "billing_event_id"]) ||
    createSessionUsageLedgerId({ sessionId, agentId, action, idempotencyKey });

  return {
    ledgerEntryId,
    idempotencyKey,
    sessionId: n(sessionId),
    agentId,
    action,
    model,
    priceBookVersion: resolvedPriceBook,
    billingTier: resolvedBillingTier,
    provider: pickText(sources, ["provider", "providerName", "provider_name"]),
    inputTokens,
    outputTokens,
    totalTokens,
    providerCostUsd: roundUsd(providerCostUsd),
    customerCostUsd,
    unpriced,
    timestamp: n(event?.ts || event?.timestamp),
    sequenceId: nonNegativeInt(event?.sequenceId ?? event?.sequence_id),
  };
}

function newRollup(label) {
  return {
    label,
    entries: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    providerCostUsd: 0,
    customerCostUsd: 0,
    hasCustomerCost: false,
    unpriced: 0,
  };
}

function addToRollup(rollup, entry) {
  rollup.entries += 1;
  rollup.inputTokens += entry.inputTokens;
  rollup.outputTokens += entry.outputTokens;
  rollup.totalTokens += entry.totalTokens;
  rollup.providerCostUsd += entry.providerCostUsd;
  if (entry.customerCostUsd != null) {
    rollup.customerCostUsd += entry.customerCostUsd;
    rollup.hasCustomerCost = true;
  }
  if (entry.unpriced) rollup.unpriced += 1;
}

function finalizeRollup(rollup) {
  rollup.providerCostUsd = roundUsd(rollup.providerCostUsd);
  rollup.customerCostUsd = roundUsd(rollup.customerCostUsd);
  return rollup;
}

export function buildSessionUsageLedger(events = [], options = {}) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array.");
  }
  const entries = [];
  const totals = newRollup("session");
  const perAgent = new Map();
  const perAction = new Map();
  const priceBookVersions = new Set();
  const seenKeys = new Set();
  let duplicatesSkipped = 0;

  for (const event of events) {
    const entry = buildUsageLedgerEntry(event, options);
    if (!entry) continue;
    const dedupeKeys = [
      entry.idempotencyKey ? `idem:${entry.idempotencyKey}` : "",
      entry.ledgerEntryId ? `ledger:${entry.ledgerEntryId}` : "",
    ].filter(Boolean);
    if (dedupeKeys.some((dedupeKey) => seenKeys.has(dedupeKey))) {
      duplicatesSkipped += 1;
      continue;
    }
    for (const dedupeKey of dedupeKeys) seenKeys.add(dedupeKey);
    entries.push(entry);
    priceBookVersions.add(entry.priceBookVersion);
    addToRollup(totals, entry);

    if (!perAgent.has(entry.agentId)) perAgent.set(entry.agentId, newRollup(entry.agentId));
    addToRollup(perAgent.get(entry.agentId), entry);

    if (!perAction.has(entry.action)) perAction.set(entry.action, newRollup(entry.action));
    addToRollup(perAction.get(entry.action), entry);
  }

  finalizeRollup(totals);
  for (const rollup of perAgent.values()) finalizeRollup(rollup);
  for (const rollup of perAction.values()) finalizeRollup(rollup);

  return {
    entries,
    totals,
    perAgent,
    perAction,
    priceBookVersions: [...priceBookVersions].sort(),
    duplicatesSkipped,
  };
}

export { DEFAULT_PRICE_BOOK_VERSION };
