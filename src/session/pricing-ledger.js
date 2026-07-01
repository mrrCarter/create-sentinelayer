import { createHash } from "node:crypto";

import {
  DEFAULT_PRICE_BOOK_VERSION,
  estimateModelCost,
} from "../cost/tracker.js";
import { estimateTokens } from "../cost/tokenizer.js";

const SESSION_USAGE_EVENT = "session_usage";
export const BILLING_SESSION_USAGE_SCHEMA = "billing/v1";
export const LOCAL_SESSION_USAGE_SCHEMA = "session_usage/local-v1";
export const ESTIMATED_MESSAGE_USAGE_SCHEMA = "session_usage/estimated-message-v1";
const LEGACY_SESSION_USAGE_SCHEMAS = new Set(["", "session_usage/v0"]);
const SUPPORTED_SESSION_USAGE_SCHEMAS = new Set([
  BILLING_SESSION_USAGE_SCHEMA,
  LOCAL_SESSION_USAGE_SCHEMA,
  ...LEGACY_SESSION_USAGE_SCHEMAS,
]);
const USAGE_HINT_KEYS = [
  "totalTokens",
  "total_tokens",
  "tokens",
  "tokenTotal",
  "token_total",
  "inputTokens",
  "input_tokens",
  "tokensIn",
  "tokens_in",
  "promptTokens",
  "prompt_tokens",
  "outputTokens",
  "output_tokens",
  "tokensOut",
  "tokens_out",
  "completionTokens",
  "completion_tokens",
  "providerCostUsd",
  "provider_cost_usd",
  "costUsd",
  "cost_usd",
  "cost",
];
const ESTIMATED_MESSAGE_EVENT_KINDS = new Set([
  "agent_response",
  "session_message",
  "session_say",
]);
const HUMAN_AGENT_IDS = new Set([
  "cli-user",
  "human",
  "user",
  "you",
]);
const DEFAULT_ESTIMATED_MESSAGE_USAGE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_ESTIMATED_MESSAGE_USAGE_DEDUPE_SEQUENCE_WINDOW = 3;

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

function hasUsageHints(value) {
  const bag = object(value);
  return USAGE_HINT_KEYS.some((key) => bag[key] != null && bag[key] !== "");
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

function positiveInteger(value, fallbackValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
  return Math.floor(parsed);
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

function messageEstimateIdempotencyKey({ sessionId, event, agentId, model, text }) {
  const payload = object(event?.payload);
  const explicit =
    n(payload.clientMessageId || payload.client_message_id) ||
    n(event?.eventId || event?.event_id) ||
    n(event?.idempotencyToken || event?.idempotency_token) ||
    n(event?.cursor);
  if (explicit) return `estimated-message:${explicit}`;
  const sequence = n(event?.sequenceId ?? event?.sequence_id);
  if (sequence) return `estimated-message:seq:${sequence}`;
  const timestamp = n(event?.ts || event?.timestamp);
  const source = [sessionId, timestamp, agentId, model, text].join("\x1f");
  return `estimated-message:${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

function isLikelyHumanAgent({ agentId = "", role = "", model = "" } = {}) {
  const id = n(agentId).toLowerCase();
  const normalizedRole = n(role).toLowerCase();
  const normalizedModel = n(model).toLowerCase();
  if (!id && !normalizedModel) return true;
  if (HUMAN_AGENT_IDS.has(id)) return true;
  if (id.startsWith("human-") || id.startsWith("user-")) return true;
  if (normalizedModel === "human") return true;
  const agentLikeRole = ["coder", "reviewer", "tester", "observer", "orchestrator"].includes(normalizedRole);
  const agentLikeId = /(codex|claude|gpt|gemini|grok|senti|kai-chen|agent|bot|warden|architect|builder)/i.test(id);
  const agentLikeModel = /(gpt|claude|gemini|grok|codex|sonnet|opus|haiku)/i.test(normalizedModel);
  if (normalizedRole === "human") return true;
  if (normalizedRole === "participant" && !agentLikeId && !agentLikeModel) return true;
  if (!agentLikeRole && !agentLikeId && !agentLikeModel && (!normalizedModel || normalizedModel === "unknown")) {
    return true;
  }
  return false;
}

function responseText(payload = {}) {
  if (payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)) {
    return n(payload.response.text);
  }
  return n(payload.response);
}

function messageText(event = {}) {
  const payload = object(event?.payload);
  return n(payload.message) || responseText(payload) || n(payload.text);
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
  const rawPayload = event?.payload;
  const payload = object(rawPayload);
  const payloadWasObject = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload);
  if (kind === SESSION_USAGE_EVENT && !payloadWasObject) return null;
  const schema = n(payload.schema);
  const usage = object(payload.usage);
  const legacyUsageEvent = kind !== SESSION_USAGE_EVENT && hasUsageHints(usage);
  if (!legacyUsageEvent) {
    if (kind !== SESSION_USAGE_EVENT) return null;
    if (!SUPPORTED_SESSION_USAGE_SCHEMAS.has(schema)) return null;
  }
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
    schema: schema || "legacy",
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
    estimated: false,
  };
}

export function buildEstimatedMessageLedgerEntry(
  event,
  {
    sessionId = "",
    priceBookVersion = DEFAULT_PRICE_BOOK_VERSION,
    billingTier = "estimated",
    includeHumanMessages = false,
    action = "estimated_agent_message",
  } = {},
) {
  const kind = n(event?.event || event?.type);
  if (!ESTIMATED_MESSAGE_EVENT_KINDS.has(kind)) return null;

  const payload = object(event?.payload);
  if (hasUsageHints(payload) || hasUsageHints(payload.usage)) return null;

  const text = messageText(event);
  if (!text) return null;

  const agent = object(event?.agent);
  const agentId = n(agent.id || event?.agentId) || "unknown";
  const model = n(agent.model || event?.agentModel || payload.model) || "unknown";
  const role = n(agent.role || payload.role);
  const lowerAgentId = agentId.toLowerCase();
  if (lowerAgentId === "senti" || lowerAgentId === "kai-chen") {
    return null;
  }
  if (!includeHumanMessages && isLikelyHumanAgent({ agentId, role, model })) {
    return null;
  }

  const outputTokens = estimateTokens(text, {
    model,
    provider: n(agent.provider || payload.provider),
  });
  if (outputTokens <= 0) return null;

  const actionName = n(action) || "estimated_agent_message";
  const idempotencyKey = messageEstimateIdempotencyKey({
    sessionId,
    event,
    agentId,
    model,
    text,
  });
  const ledgerEntryId = createSessionUsageLedgerId({
    sessionId,
    agentId,
    action: actionName,
    idempotencyKey,
  });
  const { providerCostUsd, unpriced } = providerCostFromPriceBook({
    model,
    inputTokens: 0,
    outputTokens,
    explicitProviderCost: null,
  });

  return {
    ledgerEntryId,
    idempotencyKey,
    schema: ESTIMATED_MESSAGE_USAGE_SCHEMA,
    sessionId: n(sessionId),
    agentId,
    action: actionName,
    model,
    priceBookVersion: n(priceBookVersion) || DEFAULT_PRICE_BOOK_VERSION,
    billingTier: n(billingTier) || "estimated",
    provider: n(agent.provider || payload.provider),
    inputTokens: 0,
    outputTokens,
    totalTokens: outputTokens,
    providerCostUsd: roundUsd(providerCostUsd),
    customerCostUsd: null,
    unpriced,
    timestamp: n(event?.ts || event?.timestamp),
    sequenceId: nonNegativeInt(event?.sequenceId ?? event?.sequence_id),
    estimated: true,
  };
}

function collectRealUsageAnchors(events = [], options = {}) {
  const anchors = new Map();
  for (const event of events) {
    const entry = buildUsageLedgerEntry(event, options);
    if (!entry || entry.estimated) continue;
    if (!anchors.has(entry.agentId)) anchors.set(entry.agentId, []);
    anchors.get(entry.agentId).push({
      timestampMs: Date.parse(n(entry.timestamp)),
      sequenceId: Number.isFinite(entry.sequenceId) ? entry.sequenceId : null,
    });
  }
  return anchors;
}

function hasNearbyRealUsageAnchor(entry, anchors, options = {}) {
  if (!entry || !entry.estimated || !anchors || anchors.size === 0) return false;
  const agentAnchors = anchors.get(entry.agentId);
  if (!agentAnchors || agentAnchors.length === 0) return false;
  const windowMs = positiveInteger(
    options.estimatedMessageUsageDedupeWindowMs,
    DEFAULT_ESTIMATED_MESSAGE_USAGE_DEDUPE_WINDOW_MS,
  );
  const sequenceWindow = positiveInteger(
    options.estimatedMessageUsageDedupeSequenceWindow,
    DEFAULT_ESTIMATED_MESSAGE_USAGE_DEDUPE_SEQUENCE_WINDOW,
  );
  const entryTimestampMs = Date.parse(n(entry.timestamp));
  const hasEntryTimestamp = Number.isFinite(entryTimestampMs);
  const entrySequenceId = Number.isFinite(entry.sequenceId) ? entry.sequenceId : null;
  return agentAnchors.some((anchor) => {
    if (
      entrySequenceId !== null &&
      Number.isFinite(anchor.sequenceId) &&
      Math.abs(entrySequenceId - anchor.sequenceId) <= sequenceWindow
    ) {
      return true;
    }
    if (
      hasEntryTimestamp &&
      Number.isFinite(anchor.timestampMs) &&
      Math.abs(entryTimestampMs - anchor.timestampMs) <= windowMs
    ) {
      return true;
    }
    return false;
  });
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
    estimatedEntries: 0,
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
  if (entry.estimated) rollup.estimatedEntries += 1;
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
  const realUsageAnchors = options.includeEstimatedMessages
    ? collectRealUsageAnchors(events, options)
    : new Map();
  const entries = [];
  const totals = newRollup("session");
  const perAgent = new Map();
  const perAction = new Map();
  const priceBookVersions = new Set();
  const seenKeys = new Set();
  let duplicatesSkipped = 0;

  for (const event of events) {
    const entry =
      buildUsageLedgerEntry(event, options) ||
      (options.includeEstimatedMessages
        ? buildEstimatedMessageLedgerEntry(event, options)
        : null);
    if (!entry) continue;
    if (hasNearbyRealUsageAnchor(entry, realUsageAnchors, options)) continue;
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
