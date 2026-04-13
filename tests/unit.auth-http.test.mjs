import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetRequestCircuitForTests,
  CIRCUIT_BREAKER_THRESHOLD,
  SentinelayerApiError,
  requestJson,
} from "../src/auth/http.js";

function createResponse(status, payload, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  if (!Object.prototype.hasOwnProperty.call(normalizedHeaders, "content-type")) {
    normalizedHeaders["content-type"] = "application/json";
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? "" : JSON.stringify(payload);
    },
    headers: {
      get(key) {
        return normalizedHeaders[String(key || "").toLowerCase()] ?? null;
      },
    },
  };
}

test("Unit auth http: retries retryable API statuses with bounded backoff", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return createResponse(503, {
        error: { code: "TEMP_UNAVAILABLE", message: "Retry" },
      });
    }
    return createResponse(200, { ok: true, attempt: callCount });
  };

  try {
    const response = await requestJson("https://api.example.com/test", {
      maxRetries: 2,
      retryDelayMs: 1,
      timeoutMs: 1000,
    });
    assert.equal(callCount, 2);
    assert.equal(response.ok, true);
    assert.equal(response.attempt, 2);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: retries idempotent mutation when Idempotency-Key is present", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return createResponse(503, {
        error: { code: "TEMP_UNAVAILABLE", message: "Retry" },
      });
    }
    return createResponse(200, { ok: true, attempt: callCount });
  };

  try {
    const response = await requestJson("https://api.example.com/test", {
      method: "POST",
      headers: {
        "Idempotency-Key": "sl-cli-auth-start-6dbbe1ee-38a5-4b42-8f8c-63f7d9a79b72",
      },
      maxRetries: 1,
      retryDelayMs: 1,
      timeoutMs: 1000,
    });
    assert.equal(callCount, 2);
    assert.equal(response.ok, true);
    assert.equal(response.attempt, 2);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: retries idempotent mutation when Headers contains Idempotency-Key", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return createResponse(503, {
        error: { code: "TEMP_UNAVAILABLE", message: "Retry" },
      });
    }
    return createResponse(200, { ok: true, attempt: callCount });
  };

  try {
    const headers = new Headers();
    headers.set("Idempotency-Key", "sl-cli-auth-start-88435282-0140-4b34-9e36-4b5993c6869d");
    const response = await requestJson("https://api.example.com/test", {
      method: "POST",
      headers,
      maxRetries: 1,
      retryDelayMs: 1,
      timeoutMs: 1000,
    });
    assert.equal(callCount, 2);
    assert.equal(response.ok, true);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: rejects ok responses with empty JSON body", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return "";
    },
    headers: {
      get(key) {
        if (String(key).toLowerCase() === "content-type") {
          return "application/json";
        }
        return null;
      },
    },
  });

  try {
    await assert.rejects(
      () => requestJson("https://api.example.com/test"),
      (error) => {
        assert.equal(error instanceof SentinelayerApiError, true);
        assert.equal(error.code, "EMPTY_BODY");
        return true;
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: allows empty body for 204 responses", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 204,
    async text() {
      return "";
    },
    headers: {
      get() {
        return null;
      },
    },
  });

  try {
    const response = await requestJson("https://api.example.com/test");
    assert.deepEqual(response, {});
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: rejects ok responses with non-JSON content-type", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return "<html>ok</html>";
    },
    headers: {
      get(key) {
        if (String(key).toLowerCase() === "content-type") {
          return "text/html";
        }
        return null;
      },
    },
  });

  try {
    await assert.rejects(
      () => requestJson("https://api.example.com/test"),
      (error) => {
        assert.equal(error instanceof SentinelayerApiError, true);
        assert.equal(error.code, "INVALID_CONTENT_TYPE");
        return true;
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: does not retry non-retryable API status codes", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return createResponse(400, {
      error: { code: "BAD_REQUEST", message: "Invalid input" },
    });
  };

  try {
    await assert.rejects(
      () =>
        requestJson("https://api.example.com/test", {
          maxRetries: 3,
          retryDelayMs: 1,
        }),
      (error) => {
        assert.equal(error instanceof SentinelayerApiError, true);
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.status, 400);
        return true;
      }
    );
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: opens circuit breaker after consecutive 401 auth failures", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return createResponse(401, {
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
  };

  try {
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      await assert.rejects(
        () =>
          requestJson("https://api.example.com/test", {
            maxRetries: 0,
            retryDelayMs: 1,
          }),
        (error) => {
          assert.equal(error instanceof SentinelayerApiError, true);
          assert.equal(error.code, "UNAUTHORIZED");
          assert.equal(error.status, 401);
          return true;
        }
      );
    }

    const beforeCircuitCalls = callCount;
    await assert.rejects(
      () =>
        requestJson("https://api.example.com/test", {
          maxRetries: 0,
          retryDelayMs: 1,
        }),
      (error) => {
        assert.equal(error instanceof SentinelayerApiError, true);
        assert.equal(error.code, "CIRCUIT_OPEN");
        assert.equal(error.status, 503);
        return true;
      }
    );
    assert.equal(callCount, beforeCircuitCalls);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: repeated 400 client errors do not open circuit breaker", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return createResponse(400, {
      error: { code: "BAD_REQUEST", message: "Invalid input" },
    });
  };

  try {
    const attempts = CIRCUIT_BREAKER_THRESHOLD + 1;
    for (let i = 0; i < attempts; i += 1) {
      await assert.rejects(
        () =>
          requestJson("https://api.example.com/test", {
            maxRetries: 0,
            retryDelayMs: 1,
          }),
        (error) => {
          assert.equal(error instanceof SentinelayerApiError, true);
          assert.equal(error.code, "BAD_REQUEST");
          assert.equal(error.status, 400);
          return true;
        }
      );
    }
    assert.equal(callCount, attempts);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: retries timeout/network failures and returns normalized timeout error", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    const abortError = new Error("timed out");
    abortError.name = "AbortError";
    throw abortError;
  };

  try {
    await assert.rejects(
      () =>
        requestJson("https://api.example.com/test", {
          maxRetries: 1,
          retryDelayMs: 1,
          timeoutMs: 50,
        }),
      (error) => {
        assert.equal(error instanceof SentinelayerApiError, true);
        assert.equal(error.code, "TIMEOUT");
        assert.equal(error.status, 408);
        return true;
      }
    );
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});

test("Unit auth http: opens circuit breaker after consecutive retryable failures", async () => {
  __resetRequestCircuitForTests();
  const previousFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    throw new Error("network down");
  };

  try {
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      await assert.rejects(
        () =>
          requestJson("https://api.example.com/test", {
            maxRetries: 0,
            retryDelayMs: 1,
          }),
        (error) => {
          assert.equal(error instanceof SentinelayerApiError, true);
          assert.equal(error.code, "NETWORK_ERROR");
          return true;
        }
      );
    }

    const beforeCircuitCalls = callCount;
    await assert.rejects(
      () =>
        requestJson("https://api.example.com/test", {
          maxRetries: 0,
          retryDelayMs: 1,
        }),
      (error) => {
        assert.equal(error instanceof SentinelayerApiError, true);
        assert.equal(error.code, "CIRCUIT_OPEN");
        assert.equal(error.status, 503);
        return true;
      }
    );
    assert.equal(callCount, beforeCircuitCalls);
  } finally {
    globalThis.fetch = previousFetch;
    __resetRequestCircuitForTests();
  }
});
