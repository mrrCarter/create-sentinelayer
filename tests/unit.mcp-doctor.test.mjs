import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

import { runMcpDoctorProbes } from "../src/mcp/doctor.js";

function jsonResponse(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

const HEALTHY = {
  prm: (res) =>
    jsonResponse(res, 200, {
      resource: "https://mcp.sentinelayer.test",
      authorization_servers: ["https://api.sentinelayer.test"],
      bearer_methods_supported: ["header"],
    }),
  asMetadata: (res) =>
    jsonResponse(res, 200, {
      issuer: "https://api.sentinelayer.test",
      authorization_endpoint: "https://api.sentinelayer.test/oauth/authorize",
      token_endpoint: "https://api.sentinelayer.test/oauth/token",
      code_challenge_methods_supported: ["S256"],
    }),
  jwks: (res) => jsonResponse(res, 200, { keys: [{ kty: "RSA", kid: "k1" }] }),
  mcp: (res) =>
    jsonResponse(
      res,
      401,
      { error: { code: "AUTH_REQUIRED" } },
      {
        "WWW-Authenticate":
          'Bearer resource_metadata="https://mcp.sentinelayer.test/.well-known/oauth-protected-resource"',
      }
    ),
};

async function startMockApi(handlers) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return handlers.prm(res);
    }
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return handlers.asMetadata(res);
    }
    if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return handlers.jwks(res);
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      return handlers.mcp(res);
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function byId(probes, id) {
  return probes.find((probe) => probe.id === id);
}

async function closeServer(server) {
  server.close();
  await once(server, "close");
}

test("mcp doctor: healthy hosted MCP auth -> all probes pass", async () => {
  const { server, baseUrl } = await startMockApi({ ...HEALTHY });
  try {
    const result = await runMcpDoctorProbes({ apiBaseUrl: baseUrl, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.probes.length, 4);
    for (const probe of result.probes) {
      assert.equal(probe.verdict, "PASS", `${probe.id} should PASS: ${probe.detail}`);
    }
  } finally {
    await closeServer(server);
  }
});

test("mcp doctor: AS metadata 503 while PRM advertises an AS -> FAIL (broken chain)", async () => {
  // HEALTHY.prm advertises authorization_servers, so a 503 here means clients
  // follow the advertised pointer straight into an unconfigured AS.
  const { server, baseUrl } = await startMockApi({
    ...HEALTHY,
    asMetadata: (res) => jsonResponse(res, 503, { error: { code: "MCP_OAUTH_METADATA_UNCONFIGURED" } }),
  });
  try {
    const result = await runMcpDoctorProbes({ apiBaseUrl: baseUrl, timeoutMs: 2000 });
    const as = byId(result.probes, "authorization_server_metadata");
    assert.equal(as.verdict, "FAIL");
    assert.match(as.detail, /advertises authorization_servers/i);
    assert.equal(result.ok, false, "an advertised-but-503 AS is a broken discovery chain");
  } finally {
    await closeServer(server);
  }
});

test("mcp doctor: AS metadata 503 while PRM omits the AS -> WARN (fail-closed)", async () => {
  const { server, baseUrl } = await startMockApi({
    ...HEALTHY,
    prm: (res) =>
      jsonResponse(res, 200, {
        resource: "https://mcp.sentinelayer.test",
        bearer_methods_supported: ["header"],
      }),
    asMetadata: (res) => jsonResponse(res, 503, { error: { code: "MCP_OAUTH_METADATA_UNCONFIGURED" } }),
  });
  try {
    const result = await runMcpDoctorProbes({ apiBaseUrl: baseUrl, timeoutMs: 2000 });
    assert.equal(byId(result.probes, "authorization_server_metadata").verdict, "WARN");
    assert.equal(result.ok, true, "fail-closed AS-503 with no advertised pointer is a warning, not a failure");
  } finally {
    await closeServer(server);
  }
});

test("mcp doctor: unauthenticated /mcp returns 200 -> enforcement FAIL, overall not ok", async () => {
  const { server, baseUrl } = await startMockApi({
    ...HEALTHY,
    mcp: (res) => jsonResponse(res, 200, { jsonrpc: "2.0", id: "mcp-doctor", result: {} }),
  });
  try {
    const result = await runMcpDoctorProbes({ apiBaseUrl: baseUrl, timeoutMs: 2000 });
    const enforcement = byId(result.probes, "mcp_enforcement");
    assert.equal(enforcement.verdict, "FAIL");
    assert.match(enforcement.detail, /not enforcing/i);
    assert.equal(result.ok, false);
  } finally {
    await closeServer(server);
  }
});

test("mcp doctor: 401 without resource_metadata pointer -> enforcement WARN", async () => {
  const { server, baseUrl } = await startMockApi({
    ...HEALTHY,
    mcp: (res) => jsonResponse(res, 401, { error: { code: "AUTH_REQUIRED" } }, { "WWW-Authenticate": "Bearer" }),
  });
  try {
    const result = await runMcpDoctorProbes({ apiBaseUrl: baseUrl, timeoutMs: 2000 });
    assert.equal(byId(result.probes, "mcp_enforcement").verdict, "WARN");
    assert.equal(result.ok, true);
  } finally {
    await closeServer(server);
  }
});

test("mcp doctor: missing 'resource' field in PRM -> WARN", async () => {
  const { server, baseUrl } = await startMockApi({
    ...HEALTHY,
    prm: (res) => jsonResponse(res, 200, { authorization_servers: ["https://api.sentinelayer.test"] }),
  });
  try {
    const result = await runMcpDoctorProbes({ apiBaseUrl: baseUrl, timeoutMs: 2000 });
    assert.equal(byId(result.probes, "protected_resource_metadata").verdict, "WARN");
  } finally {
    await closeServer(server);
  }
});

test("mcp doctor: requires an apiBaseUrl", async () => {
  await assert.rejects(() => runMcpDoctorProbes({ apiBaseUrl: "" }), /apiBaseUrl is required/);
});
