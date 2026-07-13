import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { writeStoredSession } from "../src/auth/session-store.js";
import { redactMcpSmokeText, runHostedMcpSmoke } from "../src/mcp/smoke.js";

const HOSTED_TOOL_NAMES = [
  "sessions_events_list",
  "sessions_usage_list",
  "sessions_listener_status",
];

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

async function startSmokeMockApi({ toolsListError = null, toolNames = HOSTED_TOOL_NAMES } = {}) {
  const state = {
    tokenRequests: [],
    mcpRequests: [],
    apiToken: ["api", "token", "existing", "1234567890"].join("_"),
    mcpAccessToken: ["mcp", "secret", "token", "1234567890"].join("_"),
    toolsListError,
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/api/v1/auth/mcp-token") {
        const body = await readJsonBody(req);
        state.tokenRequests.push({
          authHeader: String(req.headers.authorization || ""),
          body,
        });
        return jsonResponse(res, 200, {
          access_token: state.mcpAccessToken,
          token_type: "Bearer",
          expires_in: body.ttl_seconds || 300,
          expires_at: "2026-07-02T17:45:00.000Z",
          issuer: "https://api.sentinelayer.test",
          audience: "https://mcp.sentinelayer.test",
          scope: body.scope || "sessions:read",
        });
      }

      if (req.method === "POST" && url.pathname === "/mcp") {
        const authHeader = String(req.headers.authorization || "");
        const body = await readJsonBody(req);
        state.mcpRequests.push({ authHeader, body });
        if (authHeader !== `Bearer ${state.mcpAccessToken}`) {
          return jsonResponse(res, 401, {
            error: { code: "INVALID_MCP_TOKEN", message: "Invalid MCP access token" },
          });
        }
        if (body.method === "tools/list") {
          if (state.toolsListError) {
            return jsonResponse(res, 200, {
              jsonrpc: "2.0",
              id: body.id,
              error: state.toolsListError,
            });
          }
          return jsonResponse(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: toolNames.map((name) => ({ name })),
            },
          });
        }
        if (body.method === "tools/call" && body.params?.name === "sessions_events_list") {
          return jsonResponse(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              structuredContent: {
                events: [
                  { sequenceId: 101, event: "session_message" },
                  { sequenceId: 102, event: "session_message" },
                ],
              },
            },
          });
        }
        return jsonResponse(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "method not found" },
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

async function withStoredSession(callback, mockOptions = {}) {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-mcp-smoke-unit-"));
  const mock = await startSmokeMockApi(mockOptions);
  try {
    await writeStoredSession(
      {
        apiUrl: mock.apiUrl,
        token: mock.state.apiToken,
        tokenId: "token_existing",
        tokenExpiresAt: "2027-07-02T17:30:00.000Z",
      },
      { homeDir: tempRoot },
    );
    return await callback({ tempRoot, mock });
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
  }
}

test("Unit MCP smoke: proves tools/list and session read without returning bearer tokens", async () => {
  await withStoredSession(async ({ tempRoot, mock }) => {
    const result = await runHostedMcpSmoke({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      autoRotate: false,
      ttlSeconds: 120,
      sessionId: "session-1",
      limit: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(result.token.redacted, true);
    assert.equal(result.token.audience, "https://mcp.sentinelayer.test");
    assert.equal(result.token.scope, "sessions:read");
    assert.equal(result.token.accessToken, undefined);
    assert.deepEqual(
      result.probes.map((probe) => probe.id),
      ["tools_list", "session_events_list"],
    );
    assert.deepEqual(result.probes[0].toolNames, HOSTED_TOOL_NAMES);
    assert.equal(result.probes[1].eventCount, 2);
    assert.equal(result.probes[1].firstSequenceId, 101);
    assert.equal(result.probes[1].lastSequenceId, 102);

    assert.equal(mock.state.tokenRequests.length, 1);
    assert.equal(mock.state.tokenRequests[0].authHeader, `Bearer ${mock.state.apiToken}`);
    assert.deepEqual(mock.state.tokenRequests[0].body, {
      scope: "sessions:read",
      ttl_seconds: 120,
    });
    assert.equal(mock.state.mcpRequests.length, 2);
    assert.equal(mock.state.mcpRequests[0].authHeader, `Bearer ${mock.state.mcpAccessToken}`);
    assert.equal(mock.state.mcpRequests[0].body.method, "tools/list");
    assert.equal(mock.state.mcpRequests[1].body.params.name, "sessions_events_list");
    assert.equal(mock.state.mcpRequests[1].body.params.arguments.sessionId, "session-1");

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(mock.state.mcpAccessToken), false);
    assert.equal(serialized.includes(mock.state.apiToken), false);
  });
});

test("Unit MCP smoke: rejects the legacy dotted session tool alias", async () => {
  await withStoredSession(
    async ({ tempRoot, mock }) => {
      const result = await runHostedMcpSmoke({
        cwd: tempRoot,
        env: {},
        homeDir: tempRoot,
        explicitApiUrl: mock.apiUrl,
        autoRotate: false,
        sessionId: "session-1",
      });

      assert.equal(result.ok, false);
      assert.equal(result.probes[1].verdict, "FAIL");
      assert.match(result.probes[1].detail, /sessions_events_list/);
      assert.equal(mock.state.mcpRequests.length, 1);
    },
    { toolNames: ["sessions.events.list"] },
  );
});

test("Unit MCP smoke: redacts token-like JSON-RPC errors", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-mcp-smoke-unit-"));
  const mock = await startSmokeMockApi({
    toolsListError: {
      code: -32001,
      message: "",
    },
  });
  mock.state.toolsListError = {
    code: -32001,
    message: `upstream failed Bearer ${mock.state.mcpAccessToken} token=${mock.state.mcpAccessToken} raw=${mock.state.mcpAccessToken}`,
  };

  try {
    await writeStoredSession(
      {
        apiUrl: mock.apiUrl,
        token: mock.state.apiToken,
        tokenExpiresAt: "2027-07-02T17:30:00.000Z",
      },
      { homeDir: tempRoot },
    );

    const result = await runHostedMcpSmoke({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      autoRotate: false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.probes.length, 1);
    assert.equal(result.probes[0].verdict, "FAIL");
    assert.match(result.probes[0].detail, /Bearer \[REDACTED\]/);
    assert.match(result.probes[0].detail, /token=\[REDACTED\]/);
    assert.equal(result.probes[0].detail.includes(mock.state.mcpAccessToken), false);
    assert.equal(JSON.stringify(result).includes(mock.state.mcpAccessToken), false);
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
  }
});

test("Unit MCP smoke: redaction helper handles common token formats", () => {
  const text = redactMcpSmokeText("Bearer abc.def.ghi token=abc123 api_key='sk_test_secret'");
  assert.equal(text.includes("abc.def.ghi"), false);
  assert.equal(text.includes("abc123"), false);
  assert.equal(text.includes("sk_test_secret"), false);
  assert.match(text, /Bearer \[REDACTED\]/);
});
