import test from "node:test";
import assert from "node:assert/strict";

import { invokeViaProxy } from "../src/ai/proxy.js";

function createProxyResponse(payload = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get() {
        return null;
      },
    },
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

test("Unit AI proxy: sends session usage context with one canonical idempotency key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return createProxyResponse({
      content: "metered response",
      usage: {
        tokens_in: 12,
        tokens_out: 5,
        cost_usd: 0.00042,
        model: "gpt-5.4-mini",
        provider: "openai",
        latency_ms: 38,
      },
      usageLedger: {
        event: "session_usage",
        ledgerEntryId: "bill_abc",
      },
    });
  };

  const result = await invokeViaProxy({
    apiUrl: "https://api.example.test",
    token: "sl_fixture_token",
    prompt: "hello",
    systemPrompt: "system",
    model: "gpt-5.4-mini",
    maxTokens: 128,
    temperature: 0.2,
    sessionId: "session-123",
    agentId: "senti",
    action: "proxy_llm",
    usageIdempotencyKey: "senti:session-123:help:req-1",
    billingTier: "internal",
    metadata: {
      purpose: "senti_help_response",
      runId: "req-1",
    },
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/api/v1/proxy/llm");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "senti:session-123:help:req-1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.session_id, "session-123");
  assert.equal(body.agent_id, "senti");
  assert.equal(body.action, "proxy_llm");
  assert.equal(body.usage_idempotency_key, "senti:session-123:help:req-1");
  assert.equal(body.billing_tier, "internal");
  assert.deepEqual(body.metadata, {
    purpose: "senti_help_response",
    runId: "req-1",
  });
  assert.equal(result.text, "metered response");
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.usageLedger.ledgerEntryId, "bill_abc");
});

test("Unit AI proxy: omits session usage fields when no context is provided", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return createProxyResponse({
      content: "legacy response",
      usage: {},
    });
  };

  await invokeViaProxy({
    apiUrl: "https://api.example.test",
    token: "sl_fixture_token",
    prompt: "hello",
    fetchImpl,
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.session_id, undefined);
  assert.equal(body.agent_id, undefined);
  assert.equal(body.usage_idempotency_key, undefined);
  assert.equal(calls[0].init.headers["Idempotency-Key"], undefined);
});
