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
  assert.equal(attempts, 2);
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
