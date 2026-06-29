import test from "node:test";
import assert from "node:assert/strict";

import {
  createMultiProviderApiClient,
  detectProviderFromEnv,
  listSupportedProviders,
  resolveApiKey,
  resolveModel,
  resolveProvider,
} from "../src/ai/client.js";
import { SentinelayerProxyError } from "../src/ai/proxy.js";

const FIXTURE_OPENAI_CRED = ["fixture", "openai", "token", "value"].join("_");
const FIXTURE_ANTHROPIC_CRED = ["fixture", "anthropic", "token", "value"].join("_");
const FIXTURE_GOOGLE_CRED = ["fixture", "google", "token", "value"].join("_");

function createJsonResponse({ status = 200, payload = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
    body: null,
  };
}

function createProxyJsonResponse(payload = {}) {
  return createJsonResponse({
    payload: {
      content: "proxy-response",
      usage: {
        tokens_in: 21,
        tokens_out: 8,
        cost_usd: 0.00053,
        model: "gpt-5.4-mini",
        provider: "openai",
        latency_ms: 42,
      },
      usageLedger: {
        event: "session_usage",
        ledgerEntryId: "bill_proxy_from_client",
      },
      ...payload,
    },
  });
}

function createProxyErrorResponse({ status = 402, payload = {}, headers = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    ok: false,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name || "").toLowerCase()) || null;
      },
    },
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
    body: null,
  };
}

function createStreamResponse({ status = 200, sseLines = [] } = {}) {
  const encoder = new TextEncoder();
  const content = sseLines.join("\n");
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return {};
    },
    async text() {
      return content;
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(content));
        controller.close();
      },
    }),
  };
}

test("Unit AI client: provider/model/api-key resolution honors explicit > config > env", () => {
  const env = {
    ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_CRED,
    OPENAI_API_KEY: FIXTURE_OPENAI_CRED,
  };

  assert.equal(detectProviderFromEnv(env), "openai");
  assert.equal(resolveProvider({ provider: "google", configProvider: "openai", env }), "google");
  assert.equal(resolveProvider({ configProvider: "anthropic", env: {} }), "anthropic");
  assert.equal(resolveProvider({ env: { GOOGLE_API_KEY: "g-key" } }), "google");
  assert.equal(resolveModel({ provider: "anthropic", model: "" }), "claude-sonnet-4");
  assert.equal(resolveModel({ provider: "openai", model: "gpt-5.3-codex" }), "gpt-5.3-codex");
  assert.equal(resolveApiKey({ provider: "openai", env }), FIXTURE_OPENAI_CRED);
  assert.equal(resolveApiKey({ provider: "openai", explicitApiKey: "explicit", env }), "explicit");
  assert.equal(listSupportedProviders().includes("google"), true);
  assert.throws(
    () => resolveProvider({ provider: "unsupported", env }),
    /Unsupported provider/
  );
});

test("Unit AI client: invoke performs non-stream request and returns normalized text", async () => {
  const calls = [];
  const client = createMultiProviderApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createJsonResponse({
        payload: {
          choices: [
            {
              message: {
                content: "openai-response",
              },
            },
          ],
          usage: {
            prompt_tokens: 31,
            completion_tokens: 9,
            total_tokens: 40,
          },
        },
      });
    },
  });

  const result = await client.invoke({
    provider: "openai",
    model: "gpt-4o",
    prompt: "Hello from test",
    apiKey: FIXTURE_OPENAI_CRED,
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4o");
  assert.equal(result.text, "openai-response");
  assert.deepEqual(result.usage, {
    inputTokens: 31,
    outputTokens: 9,
    totalTokens: 40,
    model: "gpt-4o",
    provider: "openai",
  });
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].url || ""), /api\.openai\.com/);
});

test("Unit AI client: invoke retries retryable statuses and eventually succeeds", async () => {
  let attempts = 0;
  const client = createMultiProviderApiClient({
    maxRetries: 2,
    baseDelayMs: 1,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return createJsonResponse({ status: 429, payload: { error: "rate_limited" } });
      }
      return createJsonResponse({
        payload: {
          content: [{ text: "anthropic-success" }],
          usage: {
            input_tokens: 44,
            output_tokens: 12,
          },
        },
      });
    },
  });

  const result = await client.invoke({
    provider: "anthropic",
    prompt: "retry-test",
    apiKey: FIXTURE_ANTHROPIC_CRED,
  });

  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, "anthropic-success");
  assert.deepEqual(result.usage, {
    inputTokens: 44,
    outputTokens: 12,
    totalTokens: 56,
    model: "claude-sonnet-4",
    provider: "anthropic",
  });
  assert.equal(attempts, 2);
});

test("Unit AI client: invoke preserves Google usage metadata", async () => {
  const client = createMultiProviderApiClient({
    fetchImpl: async () =>
      createJsonResponse({
        payload: {
          candidates: [
            {
              content: {
                parts: [{ text: "google-response" }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 22,
            candidatesTokenCount: 11,
            totalTokenCount: 33,
          },
        },
      }),
  });

  const result = await client.invoke({
    provider: "google",
    model: "gemini-2.5-pro",
    prompt: "usage-test",
    apiKey: FIXTURE_GOOGLE_CRED,
  });

  assert.equal(result.provider, "google");
  assert.equal(result.model, "gemini-2.5-pro");
  assert.equal(result.text, "google-response");
  assert.deepEqual(result.usage, {
    inputTokens: 22,
    outputTokens: 11,
    totalTokens: 33,
    model: "gemini-2.5-pro",
    provider: "google",
  });
});

test("Unit AI client: invoke supports streaming callbacks (openai SSE)", async () => {
  const chunks = [];
  const client = createMultiProviderApiClient({
    fetchImpl: async () =>
      createStreamResponse({
        sseLines: [
          "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}",
          "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}",
          "data: [DONE]",
        ],
      }),
  });

  const result = await client.invoke({
    provider: "openai",
    prompt: "stream-test",
    apiKey: FIXTURE_OPENAI_CRED,
    stream: true,
    onChunk: (chunk) => chunks.push(chunk),
  });

  assert.deepEqual(chunks, ["hello", " world"]);
  assert.equal(result.text, "hello world");
});

test("Unit AI client: sentinelayer provider forwards proxy usage context and preserves ledger", async () => {
  const calls = [];
  const client = createMultiProviderApiClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return createProxyJsonResponse();
    },
  });

  const result = await client.invoke({
    provider: "sentinelayer",
    model: "gpt-5.4-mini",
    prompt: "meter this call",
    apiKey: "fixture-sentinelayer-token",
    apiUrl: "https://api.example.test",
    sessionId: "session-123",
    agentId: "senti",
    action: "proxy_llm",
    usageIdempotencyKey: "senti:session-123:help:req-1",
    billingTier: "internal",
    customerPricingPolicy: "default",
    metadata: {
      purpose: "senti_help_response",
      runId: "req-1",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/api/v1/proxy/llm");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "senti:session-123:help:req-1");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.user_content, "meter this call");
  assert.equal(body.session_id, "session-123");
  assert.equal(body.agent_id, "senti");
  assert.equal(body.action, "proxy_llm");
  assert.equal(body.usage_idempotency_key, "senti:session-123:help:req-1");
  assert.equal(body.billing_tier, "internal");
  assert.equal(body.customer_pricing_policy, "default");
  assert.deepEqual(body.metadata, {
    purpose: "senti_help_response",
    runId: "req-1",
  });

  assert.equal(result.provider, "sentinelayer");
  assert.equal(result.model, "gpt-5.4-mini");
  assert.equal(result.text, "proxy-response");
  assert.equal(result.usage.inputTokens, 21);
  assert.equal(result.usage.outputTokens, 8);
  assert.equal(result.usageLedger.ledgerEntryId, "bill_proxy_from_client");
});

test("Unit AI client: sentinelayer provider preserves actionable proxy denial errors", async () => {
  const client = createMultiProviderApiClient({
    fetchImpl: async () =>
      createProxyErrorResponse({
        status: 402,
        headers: { "Retry-After": "86400" },
        payload: {
          error: {
            code: "FREE_TRIAL_EXPIRED",
            message: "Your managed LLM trial has ended.",
            details: {
              policy: "trial",
              scope: "account",
              resetAfterSeconds: 86400,
              upgradeUrl: "https://sentinelayer.com/billing",
              checkoutMode: "membership",
            },
          },
        },
      }),
  });

  await assert.rejects(
    () =>
      client.invoke({
        provider: "sentinelayer",
        prompt: "denied",
        apiKey: "fixture-sentinelayer-token",
        apiUrl: "https://api.example.test",
      }),
    (error) => {
      assert.equal(error instanceof SentinelayerProxyError, true);
      assert.equal(error.status, 402);
      assert.equal(error.code, "FREE_TRIAL_EXPIRED");
      assert.equal(error.quota.policy, "trial");
      assert.equal(error.quota.scope, "account");
      assert.equal(error.quota.resetAfterSeconds, 86400);
      assert.equal(error.quota.upgradeUrl, "https://sentinelayer.com/billing");
      assert.match(error.message, /Your managed LLM trial has ended/);
      assert.match(error.message, /checkout=membership/);
      return true;
    }
  );
});

test("Unit AI client: invoke fails closed when API key is missing", async () => {
  const client = createMultiProviderApiClient({
    fetchImpl: async () => createJsonResponse({ payload: {} }),
  });

  await assert.rejects(
    () =>
      client.invoke({
        provider: "google",
        prompt: "missing-key",
        env: {},
      }),
    /Missing API key/
  );
});

test("Unit AI client: invoke redacts Google API key from provider errors", async () => {
  const calls = [];
  const leakedUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${encodeURIComponent(
    FIXTURE_GOOGLE_CRED
  )}`;
  const client = createMultiProviderApiClient({
    maxRetries: 0,
    fetchImpl: async (url) => {
      calls.push(String(url || ""));
      return createJsonResponse({
        status: 403,
        payload: {
          error: {
            message: `Denied request at ${leakedUrl}`,
          },
        },
      });
    },
  });

  await assert.rejects(
    () =>
      client.invoke({
        provider: "google",
        prompt: "redact-test",
        apiKey: FIXTURE_GOOGLE_CRED,
      }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message.includes(FIXTURE_GOOGLE_CRED), false);
      assert.equal(error.message.includes(encodeURIComponent(FIXTURE_GOOGLE_CRED)), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("?key="), false);
});
