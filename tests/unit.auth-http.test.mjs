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
