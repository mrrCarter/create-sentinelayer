import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { requestJson } from "../src/auth/http.js";

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
