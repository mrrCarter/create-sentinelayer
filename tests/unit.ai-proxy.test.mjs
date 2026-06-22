import test from "node:test";
import assert from "node:assert/strict";

import { invokeViaProxy, SentinelayerProxyError, serializeProxyError } from "../src/ai/proxy.js";

const authFixture = ["fixture", "auth", "value"].join("-");

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

function createProxyErrorResponse({ status = 429, payload = {}, headers = {} } = {}) {
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
    token: authFixture,
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
    token: authFixture,
    prompt: "hello",
    fetchImpl,
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.session_id, undefined);
  assert.equal(body.agent_id, undefined);
  assert.equal(body.usage_idempotency_key, undefined);
  assert.equal(calls[0].init.headers["Idempotency-Key"], undefined);
});

test("Unit AI proxy: quota denial exposes reset and upgrade metadata without retrying", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return createProxyErrorResponse({
      status: 429,
      headers: {
        "Retry-After": "3600",
        "X-RateLimit-Limit": "10",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "2026-06-23T00:00:00Z",
        "X-RateLimit-Policy": "daily_scan",
        "x-request-id": "req_proxy_quota",
      },
      payload: {
        error: {
          code: "DAILY_SCAN_LIMIT_EXCEEDED",
          message: "Daily managed LLM scan quota reached.",
          request_id: "req_proxy_quota",
          details: {
            policy: "daily_scan",
            scope: "user",
            limit: 10,
            remaining: 0,
            used: 10,
            unit: "requests",
            resetAfterSeconds: 3600,
            resetAt: "2026-06-23T00:00:00Z",
            retryAfterSeconds: 3600,
            upgradeUrl: "https://sentinelayer.com/billing",
            checkoutMode: "membership",
          },
        },
      },
    });
  };

  await assert.rejects(
    () =>
      invokeViaProxy({
        apiUrl: "https://api.example.test",
        token: authFixture,
        prompt: "hello",
        fetchImpl,
      }),
    (error) => {
      assert.equal(error instanceof SentinelayerProxyError, true);
      assert.equal(error.status, 429);
      assert.equal(error.code, "DAILY_SCAN_LIMIT_EXCEEDED");
      assert.equal(error.requestId, "req_proxy_quota");
      assert.equal(error.retryAfterMs, 3600_000);
      assert.equal(error.quota.policy, "daily_scan");
      assert.equal(error.quota.scope, "user");
      assert.equal(error.quota.limit, 10);
      assert.equal(error.quota.remaining, 0);
      assert.equal(error.quota.used, 10);
      assert.equal(error.quota.resetAt, "2026-06-23T00:00:00Z");
      assert.equal(error.quota.upgradeUrl, "https://sentinelayer.com/billing");
      assert.equal(error.quota.checkoutMode, "membership");
      assert.match(error.message, /resets at 2026-06-23T00:00:00Z/);
      assert.match(error.message, /upgrade: https:\/\/sentinelayer\.com\/billing/);
      assert.deepEqual(serializeProxyError(error), {
        status: 429,
        code: "DAILY_SCAN_LIMIT_EXCEEDED",
        requestId: "req_proxy_quota",
        retryAfterMs: 3600000,
        quota: {
          policy: "daily_scan",
          scope: "user",
          limit: 10,
          remaining: 0,
          used: 10,
          unit: "requests",
          resetAfterSeconds: 3600,
          resetAt: "2026-06-23T00:00:00Z",
          retryAfterSeconds: 3600,
          retryAfterMs: 3600000,
          upgradeUrl: "https://sentinelayer.com/billing",
          checkoutMode: "membership",
        },
      });
      return true;
    }
  );

  assert.equal(attempts, 1);
});

test("Unit AI proxy: transient 429 without quota metadata still retries", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return createProxyErrorResponse({
        status: 429,
        headers: { "Retry-After": "0" },
        payload: { error: { code: "TEMPORARY_THROTTLE", message: "Retry shortly." } },
      });
    }
    return createProxyResponse({ content: "retry success", usage: {} });
  };

  const result = await invokeViaProxy({
    apiUrl: "https://api.example.test",
    token: authFixture,
    prompt: "hello",
    fetchImpl,
  });

  assert.equal(attempts, 2);
  assert.equal(result.text, "retry success");
});
