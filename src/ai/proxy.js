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
 * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number, costUsd: number, model: string, provider: string, latencyMs: number } }>}
 */
export async function invokeViaProxy({
  prompt,
  systemPrompt = "",
  model = DEFAULT_PROXY_MODEL,
  maxTokens = 4096,
  temperature = 0.1,
  apiUrl = "",
  token = "",
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

  const body = JSON.stringify({
    model,
    system_prompt: systemPrompt || "You are a code reviewer.",
    user_content: String(prompt || ""),
    max_tokens: maxTokens,
    temperature,
  });

  let response = null;
  let lastError = null;

  for (let attempt = 0; attempt <= PROXY_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resolvedToken}`,
            Accept: "application/json",
          },
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
  };
}

export { DEFAULT_PROXY_MODEL };
