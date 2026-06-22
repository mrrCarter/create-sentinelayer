import crypto from "node:crypto";

import { redactEventPayload } from "../session/redact.js";
import { computeProviderCost, PRICE_BOOK_VERSION } from "./price-book.js";

export const PRICED_ACTIONS = Object.freeze([
  "audit_run",
  "audit_security",
  "audit_frontend",
  "chat_ask",
  "investor_dd_devtestbot_planner",
  "investor_dd_file_planner",
  "omargate_deep",
  "proxy_llm",
  "scan_precheck",
  "spec_generate_ai",
]);

const OMIT_METADATA_KEYS = new Set([
  "content",
  "input",
  "message",
  "messages",
  "output",
  "prompt",
  "prompts",
  "raw",
  "rawtext",
  "response",
  "responses",
  "text",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeTokenCount(value, field) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return Math.floor(parsed);
}

function normalizeIsoTimestamp(value, fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (!normalized) return fallbackIso;
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    throw new Error("createdAt must be an ISO timestamp.");
  }
  return new Date(epoch).toISOString();
}

export function stableHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function sanitizeMetadataValue(value, depth = 0) {
  if (depth > 8) return "[REDACTED]";
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeMetadataValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      const normalizedKey = normalizeString(key).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!normalizedKey || OMIT_METADATA_KEYS.has(normalizedKey)) {
        continue;
      }
      const sanitized = sanitizeMetadataValue(inner, depth + 1);
      if (sanitized !== undefined) {
        out[key] = sanitized;
      }
    }
    return out;
  }
  return value;
}

export function sanitizeBillingMetadata(metadata = {}) {
  const sanitized = sanitizeMetadataValue(metadata);
  const redacted = redactEventPayload({ payload: sanitized });
  return redacted?.payload && typeof redacted.payload === "object" ? redacted.payload : {};
}

export function buildBillingRunId({
  sessionId,
  invocationTimestamp,
  configHash,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedTimestamp = normalizeString(invocationTimestamp);
  const normalizedConfigHash = normalizeString(configHash);
  if (!normalizedSessionId) throw new Error("sessionId is required.");
  if (!normalizedTimestamp) throw new Error("invocationTimestamp is required.");
  if (!normalizedConfigHash) throw new Error("configHash is required.");
  return stableHash(`${normalizedSessionId}|${normalizedTimestamp}|${normalizedConfigHash}`).slice(0, 16);
}

export function buildCallIdempotencyKey({ runId, callIndex = 0 } = {}) {
  const normalizedRunId = normalizeString(runId);
  if (!normalizedRunId) throw new Error("runId is required.");
  const normalizedCallIndex = normalizeTokenCount(callIndex, "callIndex");
  return `${normalizedRunId}:${normalizedCallIndex}`;
}

export function buildLedgerEntry({
  sessionId,
  agentId,
  action,
  model,
  inputTokens = 0,
  outputTokens = 0,
  idempotencyKey,
  billingTier = "internal",
  metadata = {},
  createdAt = "",
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedAgentId = normalizeString(agentId);
  const normalizedAction = normalizeString(action);
  const normalizedModel = normalizeString(model);
  const normalizedIdempotencyKey = normalizeString(idempotencyKey);
  if (!normalizedSessionId) throw new Error("sessionId is required.");
  if (!normalizedAgentId) throw new Error("agentId is required.");
  if (!normalizedAction) throw new Error("action is required.");
  if (!normalizedModel) throw new Error("model is required.");
  if (!normalizedIdempotencyKey) throw new Error("idempotencyKey is required.");

  const priced = computeProviderCost({
    model: normalizedModel,
    inputTokens,
    outputTokens,
  });
  const createdIso = normalizeIsoTimestamp(createdAt);
  return {
    ledgerEntryId: `bill_${stableHash(normalizedIdempotencyKey).slice(0, 16)}`,
    schema: "billing/v1",
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    action: normalizedAction,
    model: normalizedModel,
    canonicalModel: priced.canonicalModel,
    priceBookVersion: PRICE_BOOK_VERSION,
    inputTokens: priced.inputTokens,
    outputTokens: priced.outputTokens,
    totalTokens: priced.totalTokens,
    providerCostUsd: priced.providerCostUsd,
    customerCostUsd: null,
    billingTier: normalizeString(billingTier) || "internal",
    idempotencyKey: normalizedIdempotencyKey,
    unpriced: Boolean(priced.unpriced),
    createdAt: createdIso,
    metadata: sanitizeBillingMetadata(metadata),
  };
}

export function countPricedUsageEvents(events = [], pricedActions = PRICED_ACTIONS) {
  const actions = new Set((Array.isArray(pricedActions) ? pricedActions : []).map(normalizeString));
  return (Array.isArray(events) ? events : []).filter((event) => {
    const payload = event?.payload || {};
    return event?.event === "session_usage" && payload.schema === "billing/v1" && actions.has(normalizeString(payload.action));
  }).length;
}
