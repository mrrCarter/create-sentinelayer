import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetAuthHttpCircuitBreakerForTests,
  requestJson,
  SentinelayerApiError,
} from "../src/auth/http.js";

test("Unit auth http: requestJson retries retryable responses and succeeds", async () => {
  __resetAuthHttpCircuitBreakerForTests();

  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          error: { code: "UPSTREAM_BUSY", message: "try again" },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const payload = await requestJson("https://api.example.com/test", {
    method: "GET",
    maxAttempts: 3,
    retryBackoffMs: 1,
    fetchImpl,
  });

  assert.equal(callCount, 2);
  assert.equal(payload.ok, true);
});

test("Unit auth http: circuit breaker opens after repeated failures", async () => {
  __resetAuthHttpCircuitBreakerForTests();

  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    throw new Error("network unavailable");
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () =>
        requestJson("https://api.example.com/test", {
          method: "GET",
          maxAttempts: 1,
          retryBackoffMs: 1,
          fetchImpl,
        }),
      (error) => error instanceof SentinelayerApiError && error.code === "NETWORK_ERROR"
    );
  }

  await assert.rejects(
    () =>
      requestJson("https://api.example.com/test", {
        method: "GET",
        maxAttempts: 1,
        retryBackoffMs: 1,
        fetchImpl,
      }),
    (error) => error instanceof SentinelayerApiError && error.code === "CIRCUIT_OPEN"
  );

  assert.equal(callCount, 3);
});

test("Unit auth http: surfaces Retry-After delay metadata on retryable responses", async () => {
  __resetAuthHttpCircuitBreakerForTests();

  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        error: { code: "RATE_LIMITED", message: "retry later" },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "2",
        },
      }
    );

  await assert.rejects(
    () =>
      requestJson("https://api.example.com/test", {
        method: "GET",
        maxAttempts: 1,
        fetchImpl,
      }),
    (error) =>
      error instanceof SentinelayerApiError &&
      error.code === "RATE_LIMITED" &&
      error.status === 429 &&
      error.retryAfterMs === 2000
  );
});

test("Unit auth http: caller abort is non-retryable and returned as CLIENT_ABORTED", async () => {
  __resetAuthHttpCircuitBreakerForTests();

  const controller = new AbortController();
  controller.abort();
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    const error = new Error("request aborted");
    error.name = "AbortError";
    throw error;
  };

  await assert.rejects(
    () =>
      requestJson("https://api.example.com/test", {
        method: "GET",
        maxAttempts: 3,
        retryBackoffMs: 1,
        signal: controller.signal,
        fetchImpl,
      }),
    (error) =>
      error instanceof SentinelayerApiError &&
      error.code === "CLIENT_ABORTED" &&
      error.status === 499
  );
  assert.equal(callCount, 1);
});

test("Unit auth http: requestJson omits JSON content-type for body-less GET", async () => {
  __resetAuthHttpCircuitBreakerForTests();

  let seenHeaders = null;
  const fetchImpl = async (_url, init) => {
    seenHeaders = init.headers;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await requestJson("https://api.example.com/test", {
    method: "GET",
    fetchImpl,
  });
  assert.equal(typeof seenHeaders, "object");
  assert.equal(seenHeaders.Accept, "application/json");
  assert.equal(Object.prototype.hasOwnProperty.call(seenHeaders, "Content-Type"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seenHeaders, "content-type"), false);
});

test("Unit auth http: local timeout does not open circuit breaker", async () => {
  __resetAuthHttpCircuitBreakerForTests();

  const neverResolvingFetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      const error = new Error("request timed out");
      error.name = "AbortError";
      init.signal.addEventListener("abort", () => reject(error), { once: true });
    });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () =>
        requestJson("https://api.example.com/test", {
          method: "GET",
          maxAttempts: 1,
          timeoutMs: 1,
          fetchImpl: neverResolvingFetch,
        }),
      (error) => error instanceof SentinelayerApiError && error.code === "TIMEOUT"
    );
  }

  const successPayload = await requestJson("https://api.example.com/test", {
    method: "GET",
    maxAttempts: 1,
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  assert.equal(successPayload.ok, true);
});
