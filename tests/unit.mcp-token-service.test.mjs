import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { writeStoredSession } from "../src/auth/session-store.js";
import { requestHostedMcpAccessToken } from "../src/mcp/token-service.js";

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

async function startMcpTokenMockApi() {
  const state = {
    requests: [],
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/api/v1/auth/mcp-token") {
        const authHeader = String(req.headers.authorization || "");
        if (!authHeader.startsWith("Bearer ")) {
          return jsonResponse(res, 401, {
            error: { code: "AUTH_REQUIRED", message: "Missing bearer token" },
          });
        }
        const body = await readJsonBody(req);
        state.requests.push({ authHeader, body });
        return jsonResponse(res, 200, {
          access_token: "mcp_access_token_1",
          token_type: "Bearer",
          expires_in: body.ttl_seconds || 600,
          expires_at: "2026-04-01T00:10:00.000Z",
          issuer: "https://api.sentinelayer.test",
          audience: "https://mcp.sentinelayer.test",
          scope: body.scope || (Array.isArray(body.scopes) ? body.scopes.join(" ") : "sessions:read"),
        });
      }
      return jsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    } catch (error) {
      return jsonResponse(res, 500, {
        error: { code: "TEST_ERROR", message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    state,
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withKeyringDisabled(callback) {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";
  try {
    return await callback();
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
  }
}

test("Unit MCP token service: requests hosted token with active CLI auth session", async () => {
  await withKeyringDisabled(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-mcp-token-unit-"));
    const mock = await startMcpTokenMockApi();

    try {
      await writeStoredSession(
        {
          apiUrl: mock.apiUrl,
          token: "api_token_existing",
          tokenId: "token_existing",
          tokenPrefix: "api_token_",
          tokenExpiresAt: "2027-04-01T00:00:00.000Z",
          user: {
            id: "user_1",
            githubUsername: "demo-user",
            email: "demo@example.com",
          },
        },
        { homeDir: tempRoot }
      );

      const minted = await requestHostedMcpAccessToken({
        cwd: tempRoot,
        env: {},
        homeDir: tempRoot,
        explicitApiUrl: mock.apiUrl,
        autoRotate: false,
        scope: "sessions:read,sessions:usage:read",
        ttlSeconds: 120,
      });

      assert.equal(minted.apiUrl, mock.apiUrl);
      assert.equal(minted.accessToken, "mcp_access_token_1");
      assert.equal(minted.tokenType, "Bearer");
      assert.equal(minted.expiresIn, 120);
      assert.equal(minted.audience, "https://mcp.sentinelayer.test");
      assert.equal(minted.scope, "sessions:read,sessions:usage:read");
      assert.equal(mock.state.requests.length, 1);
      assert.equal(mock.state.requests[0].authHeader, "Bearer api_token_existing");
      assert.deepEqual(mock.state.requests[0].body, {
        scope: "sessions:read,sessions:usage:read",
        ttl_seconds: 120,
      });
    } finally {
      await mock.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test("Unit MCP token service: rejects zero TTL before API call", async () => {
  await withKeyringDisabled(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-mcp-token-unit-"));
    const mock = await startMcpTokenMockApi();

    try {
      await writeStoredSession(
        {
          apiUrl: mock.apiUrl,
          token: "api_token_existing",
        },
        { homeDir: tempRoot }
      );

      await assert.rejects(
        () =>
          requestHostedMcpAccessToken({
            cwd: tempRoot,
            env: {},
            homeDir: tempRoot,
            explicitApiUrl: mock.apiUrl,
            autoRotate: false,
            ttlSeconds: 0,
          }),
        /ttlSeconds must be a positive integer/
      );
      assert.equal(mock.state.requests.length, 0);
    } finally {
      await mock.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test("Unit MCP token service: rejects invalid timeout before API call", async () => {
  await withKeyringDisabled(async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-mcp-token-unit-"));
    const mock = await startMcpTokenMockApi();

    try {
      await writeStoredSession(
        {
          apiUrl: mock.apiUrl,
          token: "api_token_existing",
        },
        { homeDir: tempRoot }
      );

      await assert.rejects(
        () =>
          requestHostedMcpAccessToken({
            cwd: tempRoot,
            env: {},
            homeDir: tempRoot,
            explicitApiUrl: mock.apiUrl,
            autoRotate: false,
            timeoutMs: 0,
          }),
        /timeoutMs must be a positive number/
      );
      assert.equal(mock.state.requests.length, 0);
    } finally {
      await mock.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
