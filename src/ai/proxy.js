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

      if (PROXY_RETRY_STATUSES.has(response.status) && attempt < PROXY_MAX_RETRIES) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter && !isNaN(retryAfter) ? Math.min(Number(retryAfter), 5) * 1000 : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      break;
    } catch (err) {
      lastError = err;
      if (attempt >= PROXY_MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  if (!response) {
    throw new Error(`SentinelLayer LLM proxy request failed: ${lastError?.message || "no response"}`);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message || errBody?.detail || JSON.stringify(errBody).slice(0, 200);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(`SentinelLayer LLM proxy error (${response.status}): ${detail}`);
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
