/**
 * SentinelLayer LLM proxy provider.
 *
 * Routes LLM calls through POST /api/v1/proxy/llm using the stored
 * sentinelayer_token. Users never need their own OpenAI/Anthropic key.
 *
 * Request:  { model, system_prompt, user_content, max_tokens, temperature }
 * Response: { content, usage: { model, provider, tokens_in, tokens_out, cost_usd, latency_ms } }
 */

import { resolveActiveAuthSession } from "../auth/service.js";
import { authLoginHint } from "../ui/command-hints.js";

const DEFAULT_PROXY_MODEL = "gpt-5.3-codex";
const PROXY_TIMEOUT_MS = 120_000;
const PROXY_MAX_RETRIES = 2;
const PROXY_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const ACTIONABLE_PROXY_DENIAL_CODES = new Set([
  "FREE_TRIAL_EXPIRED",
  "DAILY_SCAN_LIMIT_EXCEEDED",
  "WEEKLY_SCAN_LIMIT_EXCEEDED",
  "DAILY_BUDGET_EXCEEDED",
  "RATE_LIMIT_EXCEEDED",
]);

export class SentinelayerProxyError extends Error {
  constructor(message, {
    status = 0,
    code = "PROXY_ERROR",
    requestId = "",
    retryAfterMs = undefined,
    quota = null,
    raw = null,
  } = {}) {
    super(message);
    this.name = "SentinelayerProxyError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
    this.quota = quota;
    this.raw = raw;
  }
}

export function serializeProxyError(error) {
  if (!error || typeof error !== "object") {
    return null;
  }
  const status = normalizeInteger(error.status);
  const code = String(error.code || "").trim();
  const requestId = String(error.requestId || "").trim();
  const retryAfterMs = normalizeInteger(error.retryAfterMs);
  const quota =
    error.quota && typeof error.quota === "object" && !Array.isArray(error.quota)
      ? JSON.parse(JSON.stringify(error.quota))
      : null;
  const serialized = {
    status,
    code: code || undefined,
    requestId: requestId || undefined,
    retryAfterMs,
    quota,
  };
  for (const key of Object.keys(serialized)) {
    if (serialized[key] === undefined || serialized[key] === null || serialized[key] === "") {
      delete serialized[key];
    }
  }
  return Object.keys(serialized).length > 0 ? serialized : null;
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeInteger(value) {
  const numeric = normalizeNumber(value);
  return numeric === undefined ? undefined : Math.max(0, Math.floor(numeric));
}

function getHeader(headers, name) {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }
  return headers.get(name) || headers.get(name.toLowerCase()) || null;
}

function parseRetryAfterMs(raw) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const asSeconds = Number.parseFloat(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.ceil(asSeconds * 1000);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) {
    return undefined;
  }
  return Math.max(0, asDate - Date.now());
}

function chooseObject(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate;
    }
  }
  return {};
}

function normalizeQuotaDetails(details = {}, headers = null) {
  const policy = String(details.policy || "").trim();
  const scope = String(details.scope || "").trim();
  const unit = String(details.unit || "").trim();
  const resetAt = String(details.resetAt || details.reset_at || "").trim();
  const upgradeUrl = String(details.upgradeUrl || details.upgrade_url || "").trim();
  const checkoutMode = String(details.checkoutMode || details.checkout_mode || "").trim();
  const limit =
    normalizeInteger(details.limit) ??
    normalizeInteger(getHeader(headers, "X-RateLimit-Limit"));
  const remaining =
    normalizeInteger(details.remaining) ??
    normalizeInteger(getHeader(headers, "X-RateLimit-Remaining"));
  const used = normalizeInteger(details.used);
  const resetAfterSeconds =
    normalizeInteger(details.resetAfterSeconds ?? details.reset_after_seconds) ??
    normalizeInteger(details.retryAfterSeconds ?? details.retry_after_seconds);
  const retryAfterSeconds =
    normalizeInteger(details.retryAfterSeconds ?? details.retry_after_seconds) ??
    normalizeInteger(resetAfterSeconds);
  const retryAfterMs =
    retryAfterSeconds !== undefined
      ? retryAfterSeconds * 1000
      : parseRetryAfterMs(getHeader(headers, "Retry-After"));
  const headerReset = getHeader(headers, "X-RateLimit-Reset");
  const headerPolicy = getHeader(headers, "X-RateLimit-Policy");

  const quota = {
    policy: policy || String(headerPolicy || "").trim() || undefined,
    scope: scope || undefined,
    limit,
    remaining,
    used,
    unit: unit || undefined,
    resetAfterSeconds,
    resetAt: resetAt || String(headerReset || "").trim() || undefined,
    retryAfterSeconds,
    retryAfterMs,
    upgradeUrl: upgradeUrl || undefined,
    checkoutMode: checkoutMode || undefined,
  };

  for (const key of Object.keys(quota)) {
    if (quota[key] === undefined || quota[key] === "") {
      delete quota[key];
    }
  }

  return Object.keys(quota).length > 0 ? quota : null;
}

function formatSeconds(seconds) {
  const normalized = normalizeInteger(seconds);
  if (normalized === undefined) {
    return "";
  }
  if (normalized < 60) {
    return `${normalized}s`;
  }
  const minutes = Math.ceil(normalized / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.ceil(hours / 24);
  return `${days}d`;
}

function buildProxyErrorMessage({ status, code, message, quota }) {
  const parts = [`SentinelLayer LLM proxy error (${status}${code ? ` ${code}` : ""}): ${message || "Request denied"}`];
  if (quota?.policy || quota?.scope) {
    parts.push(`policy=${quota.policy || "unknown"}${quota.scope ? ` scope=${quota.scope}` : ""}`);
  }
  if (quota?.limit !== undefined || quota?.remaining !== undefined || quota?.used !== undefined) {
    const unit = quota.unit ? ` ${quota.unit}` : "";
    const limit = quota.limit !== undefined ? quota.limit : "?";
    const remaining = quota.remaining !== undefined ? quota.remaining : "?";
    const used = quota.used !== undefined ? quota.used : "?";
    parts.push(`quota used=${used} remaining=${remaining} limit=${limit}${unit}`);
  }
  if (quota?.resetAt) {
    parts.push(`resets at ${quota.resetAt}`);
  } else if (quota?.resetAfterSeconds !== undefined) {
    parts.push(`resets in ${formatSeconds(quota.resetAfterSeconds)}`);
  } else if (quota?.retryAfterSeconds !== undefined) {
    parts.push(`retry after ${formatSeconds(quota.retryAfterSeconds)}`);
  }
  if (quota?.upgradeUrl) {
    parts.push(`upgrade: ${quota.upgradeUrl}`);
  }
  if (quota?.checkoutMode) {
    parts.push(`checkout=${quota.checkoutMode}`);
  }
  return parts.join(" | ");
}

async function parseProxyErrorResponse(response) {
  let payload = null;
  let text = "";
  try {
    payload = await response.json();
  } catch {
    text = await response.text().catch(() => "");
  }

  const detailObject =
    payload?.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
      ? payload.detail
      : null;
  const nestedError = chooseObject(payload?.error, detailObject?.error);
  const details = chooseObject(
    nestedError?.details,
    nestedError?.detail,
    payload?.details,
    detailObject?.details,
    detailObject
  );
  const code = String(
    nestedError?.code ||
      payload?.code ||
      detailObject?.code ||
      "PROXY_ERROR"
  ).trim() || "PROXY_ERROR";
  const message = String(
    nestedError?.message ||
      payload?.message ||
      (typeof payload?.detail === "string" ? payload.detail : "") ||
      detailObject?.message ||
      text ||
      "Request denied"
  ).trim();
  const requestId = String(
    nestedError?.request_id ||
      nestedError?.requestId ||
      payload?.request_id ||
      payload?.requestId ||
      detailObject?.request_id ||
      detailObject?.requestId ||
      getHeader(response.headers, "x-request-id") ||
      ""
  ).trim();
  const quota = normalizeQuotaDetails(details, response.headers);
  const retryAfterMs =
    quota?.retryAfterMs ??
    parseRetryAfterMs(getHeader(response.headers, "Retry-After")) ??
    normalizeInteger(nestedError?.retry_after_ms ?? payload?.retry_after_ms);

  return {
    code,
    message,
    requestId,
    quota,
    retryAfterMs,
    raw: payload || text,
  };
}

function isActionableProxyDenial(status, parsed) {
  if (status === 402 || status === 403) {
    return true;
  }
  if (ACTIONABLE_PROXY_DENIAL_CODES.has(String(parsed?.code || "").trim())) {
    return true;
  }
  return Boolean(parsed?.quota?.policy || parsed?.quota?.upgradeUrl || parsed?.quota?.resetAt);
}

function buildProxyError(status, parsed) {
  const retryAfterMs = parsed.retryAfterMs ?? parsed.quota?.retryAfterMs;
  return new SentinelayerProxyError(
    buildProxyErrorMessage({
      status,
      code: parsed.code,
      message: parsed.message,
      quota: parsed.quota,
    }),
    {
      status,
      code: parsed.code,
      requestId: parsed.requestId,
      retryAfterMs,
      quota: parsed.quota,
      raw: parsed.raw,
    }
  );
}

/**
 * Invoke LLM via SentinelLayer proxy.
 *
 * @param {object} options
 * @param {string} options.prompt - The user content / prompt text
 * @param {string} [options.systemPrompt] - System prompt
 * @param {string} [options.model] - Model ID (default: gpt-5.3-codex)
 * @param {number} [options.maxTokens] - Max output tokens (default: 4096)
 * @param {number} [options.temperature] - Temperature (default: 0.1)
 * @param {string} [options.apiUrl] - Override API URL
 * @param {string} [options.token] - Override Bearer token
 * @param {string} [options.sessionId] - Optional Senti session id for server-side usage metering
 * @param {string} [options.agentId] - Optional session agent id for server-side usage metering
 * @param {string} [options.action] - Optional metered action, defaults server-side when omitted
 * @param {string} [options.usageIdempotencyKey] - Stable per-intent key for proxy + ledger idempotency
 * @param {string} [options.billingTier] - Optional billing tier hint
 * @param {string} [options.customerPricingPolicy] - Optional customer pricing policy hint
 * @param {object} [options.metadata] - Optional allowlisted billing metadata
 * @param {Function} [options.fetchImpl] - Optional fetch implementation for tests
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number, costUsd: number, model: string, provider: string, latencyMs: number }, usageLedger: object | null }>}
 */
export async function invokeViaProxy({
  prompt,
  systemPrompt = "",
  model = DEFAULT_PROXY_MODEL,
  maxTokens = 4096,
  temperature = 0.1,
  apiUrl = "",
  token = "",
  sessionId = "",
  agentId = "",
  action = "",
  usageIdempotencyKey = "",
  billingTier = "",
  customerPricingPolicy = "",
  metadata = null,
  fetchImpl = fetch,
} = {}) {
  // Resolve credentials from session if not provided
  let resolvedApiUrl = String(apiUrl || "").trim();
  let resolvedToken = String(token || "").trim();

  if (!resolvedApiUrl || !resolvedToken) {
    const session = await resolveActiveAuthSession({
      cwd: process.cwd(),
      env: process.env,
      autoRotate: false,
    });
    if (!session || !session.token) {
      throw new Error(
        `SentinelLayer LLM proxy requires authentication. Run '${authLoginHint()}' first.`
      );
    }
    if (!resolvedApiUrl) resolvedApiUrl = String(session.apiUrl || "https://api.sentinelayer.com").trim();
    if (!resolvedToken) resolvedToken = String(session.token).trim();
  }

  const url = `${resolvedApiUrl.replace(/\/+$/, "")}/api/v1/proxy/llm`;

  const requestBody = {
    model,
    system_prompt: systemPrompt || "You are a code reviewer.",
    user_content: String(prompt || ""),
    max_tokens: maxTokens,
    temperature,
  };

  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedAgentId = String(agentId || "").trim();
  const normalizedAction = String(action || "").trim();
  const normalizedUsageIdempotencyKey = String(usageIdempotencyKey || "").trim();
  const normalizedBillingTier = String(billingTier || "").trim();
  const normalizedCustomerPricingPolicy = String(customerPricingPolicy || "").trim();
  if (normalizedSessionId) requestBody.session_id = normalizedSessionId;
  if (normalizedAgentId) requestBody.agent_id = normalizedAgentId;
  if (normalizedAction) requestBody.action = normalizedAction;
  if (normalizedUsageIdempotencyKey) requestBody.usage_idempotency_key = normalizedUsageIdempotencyKey;
  if (normalizedBillingTier) requestBody.billing_tier = normalizedBillingTier;
  if (normalizedCustomerPricingPolicy) requestBody.customer_pricing_policy = normalizedCustomerPricingPolicy;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    requestBody.metadata = metadata;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${resolvedToken}`,
    Accept: "application/json",
  };
  if (normalizedUsageIdempotencyKey) {
    headers["Idempotency-Key"] = normalizedUsageIdempotencyKey;
  }

  const body = JSON.stringify(requestBody);

  let response = null;
  let lastError = null;

  for (let attempt = 0; attempt <= PROXY_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (response.ok) {
        break;
      }

      const parsedError = await parseProxyErrorResponse(response);
      const hardDenial = isActionableProxyDenial(response.status, parsedError);
      if (!hardDenial && PROXY_RETRY_STATUSES.has(response.status) && attempt < PROXY_MAX_RETRIES) {
        const retryAfter = getHeader(response.headers, "Retry-After");
        const retryAfterSeconds = retryAfter && !Number.isNaN(Number(retryAfter)) ? Number(retryAfter) : null;
        const delay = retryAfterSeconds !== null ? Math.min(retryAfterSeconds, 5) * 1000 : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw buildProxyError(response.status, parsedError);
    } catch (err) {
      if (err instanceof SentinelayerProxyError) {
        throw err;
      }
      lastError = err;
      if (attempt >= PROXY_MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  if (!response) {
    throw new Error(`SentinelLayer LLM proxy request failed: ${lastError?.message || "no response"}`);
  }

  const result = await response.json();

  return {
    text: String(result.content || ""),
    usage: {
      inputTokens: result.usage?.tokens_in || 0,
      outputTokens: result.usage?.tokens_out || 0,
      costUsd: result.usage?.cost_usd || 0,
      model: result.usage?.model || model,
      provider: result.usage?.provider || "sentinelayer",
      latencyMs: result.usage?.latency_ms || 0,
    },
    usageLedger: result.usageLedger || result.usage_ledger || null,
  };
}

export { DEFAULT_PROXY_MODEL };
