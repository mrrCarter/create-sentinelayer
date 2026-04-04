import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __resetAuthHttpCircuitBreakerForTests,
  getSharedRequestJitterSalt,
  requestJson,
} from "../src/auth/http.js";

async function startMockServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve mock server address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

test("Unit auth http: requestJson preserves string payloads for custom content type", async () => {
  const mock = await startMockServer(async (req, res) => {
    const body = await readBody(req);
    const payload = {
      method: req.method,
      contentType: String(req.headers["content-type"] || ""),
      body,
    };
    const serialized = JSON.stringify(payload);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(serialized),
    });
    res.end(serialized);
  });

  try {
    const response = await requestJson(`${mock.baseUrl}/custom`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: "plain-text-payload",
    });

    assert.equal(response.method, "POST");
    assert.equal(response.contentType, "text/plain");
    assert.equal(response.body, "plain-text-payload");
  } finally {
    await mock.close();
  }
});

test("Unit auth http: shared jitter salt is deterministic per scope and distinct across scopes", () => {
  const saltA = getSharedRequestJitterSalt("auth-poll-backoff");
  const saltB = getSharedRequestJitterSalt("auth-poll-backoff");
  const otherSalt = getSharedRequestJitterSalt("network-retry");
  assert.match(saltA, /^[a-f0-9]{64}$/);
  assert.equal(saltA, saltB);
  assert.notEqual(saltA, otherSalt);
});

test("Unit auth http: requestJson serializes object payloads as JSON by default", async () => {
  const mock = await startMockServer(async (req, res) => {
    const body = await readBody(req);
    const payload = {
      contentType: String(req.headers["content-type"] || ""),
      body,
    };
    const serialized = JSON.stringify(payload);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(serialized),
    });
    res.end(serialized);
  });

  try {
    const response = await requestJson(`${mock.baseUrl}/json`, {
      method: "POST",
      body: { value: 42 },
    });

    assert.equal(response.contentType, "application/json");
    assert.equal(response.body, JSON.stringify({ value: 42 }));
  } finally {
    await mock.close();
  }
});

test("Unit auth http: sustained 429 responses open rate-limit circuit and stop retries", async () => {
  __resetAuthHttpCircuitBreakerForTests();
  let calls = 0;
  const rateLimitBody = JSON.stringify({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests",
    },
  });
  try {
    await assert.rejects(
      () =>
        requestJson("https://api.sentinelayer.example/rate-limit", {
          method: "GET",
          maxAttempts: 5,
          retryBackoffMs: 1,
          fetchImpl: async () => {
            calls += 1;
            return new Response(rateLimitBody, {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "1",
              },
            });
          },
        }),
      (error) => {
        assert.equal(error?.status, 429);
        assert.equal(error?.code, "RATE_LIMITED");
        assert.ok(Number(error?.retryAfterMs || 0) > 0);
        return true;
      }
    );
    assert.ok(calls <= 5, `Expected retry loop to stop after rate-limit circuit opens, got ${calls} calls.`);
  } finally {
    __resetAuthHttpCircuitBreakerForTests();
  }
});

test("Unit auth http: shared circuit snapshot is loaded after in-memory reset", async () => {
  __resetAuthHttpCircuitBreakerForTests();
  const stateRoot = path.join(os.homedir(), ".sentinelayer");
  await mkdir(stateRoot, { recursive: true });
  const tempStateDir = await mkdtemp(path.join(stateRoot, "sl-auth-http-state-"));
  process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR = tempStateDir;
  let primingCalls = 0;
  let resumedCalls = 0;
  const rateLimitBody = JSON.stringify({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests",
    },
  });
  try {
    await assert.rejects(
      () =>
        requestJson("https://api.sentinelayer.example/shared-rate-limit", {
          method: "GET",
          maxAttempts: 5,
          retryBackoffMs: 1,
          fetchImpl: async () => {
            primingCalls += 1;
            return new Response(rateLimitBody, {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "1",
              },
            });
          },
        }),
      (error) => {
        assert.equal(error?.status, 429);
        assert.equal(error?.code, "RATE_LIMITED");
        return true;
      }
    );
    assert.ok(primingCalls <= 5, `Expected priming circuit to open quickly, got ${primingCalls} calls.`);

    __resetAuthHttpCircuitBreakerForTests({ clearSharedSnapshot: false });

    await assert.rejects(
      () =>
        requestJson("https://api.sentinelayer.example/shared-rate-limit", {
          method: "GET",
          maxAttempts: 1,
          fetchImpl: async () => {
            resumedCalls += 1;
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
      (error) => {
        assert.equal(error?.status, 429);
        assert.equal(error?.code, "RATE_LIMITED");
        return true;
      }
    );
    assert.equal(
      resumedCalls,
      0,
      "Expected shared persisted circuit snapshot to short-circuit before fetch in resumed process."
    );
  } finally {
    delete process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR;
    __resetAuthHttpCircuitBreakerForTests();
    await rm(tempStateDir, { recursive: true, force: true });
  }
});

test("Unit auth http: shared-state directory override must remain under ~/.sentinelayer", async () => {
  __resetAuthHttpCircuitBreakerForTests();
  const previousStateDir = process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR;
  const previousCi = process.env.CI;
  const previousCiOverride = process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE;
  process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR = path.join(os.tmpdir(), "sl-auth-http-outside-root");
  delete process.env.CI;
  delete process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE;
  try {
    await assert.rejects(
      () =>
        requestJson("https://api.sentinelayer.example/outside-root", {
          method: "GET",
          maxAttempts: 1,
          fetchImpl: async () =>
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        }),
      /must resolve within/i
    );
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR;
    } else {
      process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR = previousStateDir;
    }
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    if (previousCiOverride === undefined) {
      delete process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE;
    } else {
      process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE = previousCiOverride;
    }
    __resetAuthHttpCircuitBreakerForTests();
  }
});

test("Unit auth http: CI mode ignores shared-state override outside allowed root", async () => {
  __resetAuthHttpCircuitBreakerForTests();
  const previousStateDir = process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR;
  const previousCi = process.env.CI;
  const previousCiOverride = process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE;
  process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR = path.join(os.tmpdir(), "sl-auth-http-outside-root");
  process.env.CI = "true";
  delete process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE;
  const rateLimitBody = JSON.stringify({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests",
    },
  });
  try {
    await assert.rejects(
      () =>
        requestJson("https://api.sentinelayer.example/ci-ignore-override", {
          method: "GET",
          maxAttempts: 1,
          fetchImpl: async () =>
            new Response(rateLimitBody, {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "1",
              },
            }),
        }),
      (error) => {
        assert.equal(error?.status, 429);
        assert.equal(error?.code, "RATE_LIMITED");
        return true;
      }
    );
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR;
    } else {
      process.env.SENTINELAYER_AUTH_HTTP_STATE_DIR = previousStateDir;
    }
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    if (previousCiOverride === undefined) {
      delete process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE;
    } else {
      process.env.SENTINELAYER_AUTH_HTTP_ALLOW_CI_STATE_DIR_OVERRIDE = previousCiOverride;
    }
    __resetAuthHttpCircuitBreakerForTests();
  }
});

test("Unit auth http: requestJson honors Retry-After http-date relative to server date", async () => {
  let attempts = 0;
  const serverDate = new Date();
  const retryDate = new Date(serverDate.getTime() + 1200);

  const mock = await startMockServer(async (_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      const serialized = JSON.stringify({
        code: "TEMP_UNAVAILABLE",
        message: "retry later",
      });
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(serialized),
        Date: serverDate.toUTCString(),
        "Retry-After": retryDate.toUTCString(),
      });
      res.end(serialized);
      return;
    }
    const success = JSON.stringify({ ok: true, attempts });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(success),
    });
    res.end(success);
  });

  try {
    const startedAt = Date.now();
    const response = await requestJson(`${mock.baseUrl}/retry-after-date`, {
      method: "GET",
      maxAttempts: 2,
      retryBackoffMs: 10,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.ok, true);
    assert.ok(elapsedMs >= 900, `Expected retry delay near Retry-After window, got ${elapsedMs}ms.`);
  } finally {
    await mock.close();
  }
});

test("Unit auth http: requestJson honors Retry-After http-date without Date header", async () => {
  let attempts = 0;
  const retryDate = new Date(Date.now() + 1100);

  const mock = await startMockServer(async (_req, res) => {
    attempts += 1;
    if (attempts === 1) {
      const serialized = JSON.stringify({
        code: "TEMP_UNAVAILABLE",
        message: "retry later",
      });
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(serialized),
        "Retry-After": retryDate.toUTCString(),
      });
      res.end(serialized);
      return;
    }
    const success = JSON.stringify({ ok: true, attempts });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(success),
    });
    res.end(success);
  });

  try {
    const startedAt = Date.now();
    const response = await requestJson(`${mock.baseUrl}/retry-after-date-no-server-date`, {
      method: "GET",
      maxAttempts: 2,
      retryBackoffMs: 10,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.ok, true);
    assert.ok(elapsedMs >= 750, `Expected retry delay near Retry-After window, got ${elapsedMs}ms.`);
  } finally {
    await mock.close();
  }
});

test("Unit auth http: requestJson preserves camelCase requestId on API errors", async () => {
  const mock = await startMockServer(async (_req, res) => {
    const payload = JSON.stringify({
      error: {
        code: "AUTH_REQUIRED",
        message: "login required",
        requestId: "req_camel_123",
      },
    });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  try {
    await assert.rejects(
      () => requestJson(`${mock.baseUrl}/camel-request-id`, { method: "GET", maxAttempts: 1 }),
      (error) => {
        assert.equal(error?.code, "AUTH_REQUIRED");
        assert.equal(error?.status, 401);
        assert.equal(error?.requestId, "req_camel_123");
        return true;
      }
    );
  } finally {
    await mock.close();
  }
});

test("Unit auth http: requestJson rejects tainted requestId values from API errors", async () => {
  const mock = await startMockServer(async (_req, res) => {
    const payload = JSON.stringify({
      error: {
        code: "AUTH_REQUIRED",
        message: "login required",
        requestId: "req\nspoofed:trace",
      },
    });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  try {
    await assert.rejects(
      () => requestJson(`${mock.baseUrl}/tainted-request-id`, { method: "GET", maxAttempts: 1 }),
      (error) => {
        assert.equal(error?.code, "AUTH_REQUIRED");
        assert.equal(error?.status, 401);
        assert.equal(error?.requestId, null);
        return true;
      }
    );
  } finally {
    await mock.close();
  }
});

test("Unit auth http: requestJson carries sanitized requestId from transport failures", async () => {
  await assert.rejects(
    () =>
      requestJson("https://sentinelayer.example/network-failure", {
        method: "GET",
        maxAttempts: 1,
        fetchImpl: async () => {
          const transportError = new Error("socket hangup");
          transportError.requestId = "req_transport_123";
          throw transportError;
        },
      }),
    (error) => {
      assert.equal(error?.code, "NETWORK_ERROR");
      assert.equal(error?.status, 503);
      assert.equal(error?.requestId, "req_transport_123");
      return true;
    }
  );
});

test("Unit auth http: requestJson preserves response header request id on invalid json", async () => {
  await assert.rejects(
    () =>
      requestJson("https://sentinelayer.example/invalid-json", {
        method: "GET",
        maxAttempts: 1,
        fetchImpl: async () =>
          new Response("not-json", {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "x-request-id": "req_hdr_456",
            },
          }),
      }),
    (error) => {
      assert.equal(error?.code, "INVALID_JSON");
      assert.equal(error?.status, 500);
      assert.equal(error?.requestId, "req_hdr_456");
      return true;
    }
  );
});

test("Unit auth http: requestJson times out when response body stream stalls", async () => {
  let pullCount = 0;
  const stalledStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
    },
    pull() {
      pullCount += 1;
      return new Promise(() => {});
    },
  });

  await assert.rejects(
    () =>
      requestJson("https://sentinelayer.example/stalled-stream", {
        method: "GET",
        timeoutMs: 150,
        maxAttempts: 1,
        fetchImpl: async () =>
          new Response(stalledStream, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }),
      }),
    (error) => {
      assert.equal(error?.code, "TIMEOUT");
      assert.equal(error?.status, 408);
      return true;
    }
  );
  assert.ok(pullCount >= 1);
});
