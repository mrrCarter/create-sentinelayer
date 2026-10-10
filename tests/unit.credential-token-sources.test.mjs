import "./setup-env.mjs";
// Every place the user's own SentinelLayer token comes from produces a credential object
// (src/auth/credential-destinations.js) bound to the configured origin by the one trust context.
// Each test gets the token from one source while another origin is in play (an --api-url, a
// project config, an injected resolver), and that other origin must receive nothing. Tokens
// are deliberately short: no length threshold decides what is protected.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CredentialDestinationRefused,
  admissionCredential,
  credentialFor,
  credentialedRequest,
  gatewayCredential,
  userCredential,
} from "../src/auth/credential-destinations.js";
import { loginAndPersistSession, resolveActiveAuthSession } from "../src/auth/service.js";
import { writeStoredSession } from "../src/auth/session-store.js";
import { invokeViaProxy } from "../src/ai/proxy.js";
import { queryHybridRetriever } from "../src/memory/retrieval.js";
import { runHostedMcpSmoke } from "../src/mcp/smoke.js";
import { requestHostedMcpAccessToken } from "../src/mcp/token-service.js";
import { __legacyCredentialFlowForTests as legacy } from "../src/legacy-cli.js";

// A loopback server; `routes` maps "METHOD /path" (or "METHOD /prefix*") to a handler.
async function startServer(routes = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const pathname = new URL(req.url, "http://x").pathname;
    requests.push({ method: req.method, path: pathname, authorization: req.headers.authorization || "" });
    const key = Object.keys(routes).find((route) => {
      const [method, pattern] = route.split(" ");
      return method === req.method && (pattern.endsWith("*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern);
    });
    const body = key ? await routes[key]({ req, body: raw ? JSON.parse(raw) : null }) : { ok: true };
    const text = JSON.stringify(body);
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The configured API (with `routes`), another origin, and an isolated home.
async function world(routes = {}) {
  const configured = await startServer(routes);
  const other = await startServer();
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-token-sources-"));
  return {
    configured,
    other,
    home,
    env: { SENTINELAYER_API_URL: configured.url },
    // Try to send `credential` to the other origin: refused, and nothing arrives there.
    assertHeldBack: async (credential) => {
      await assert.rejects(credentialedRequest(credential, `${other.url}/probe`), CredentialDestinationRefused);
      assert.deepEqual(other.requests, [], "the other origin received nothing");
    },
    close: async () => {
      await configured.close();
      await other.close();
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

const inFuture = (days) => new Date(Date.now() + days * 86400_000).toISOString();

test("source: SENTINELAYER_TOKEN, while --api-url names another origin", async () => {
  const w = await world();
  try {
    const auth = await resolveActiveAuthSession({
      env: { ...w.env, SENTINELAYER_TOKEN: "e1" },
      homeDir: w.home,
      cwd: w.home,
      explicitApiUrl: w.other.url,
    });
    assert.equal(auth.apiUrl, w.other.url, "resolution follows --api-url");
    assert.equal(auth.credential.token, "e1");
    assert.equal(auth.credential.origin, w.configured.url, "the credential follows the trust context");
    await w.assertHeldBack(auth.credential);
  } finally {
    await w.close();
  }
});

test("source: the sentinelayerToken config value, while a project config names another origin", async () => {
  const w = await world();
  try {
    await fsp.mkdir(path.join(w.home, ".sentinelayer"), { recursive: true });
    await fsp.writeFile(
      path.join(w.home, ".sentinelayer", "config.yml"),
      `apiUrl: ${w.configured.url}\nsentinelayerToken: c1\n`,
    );
    await fsp.writeFile(path.join(w.home, ".sentinelayer.yml"), `apiUrl: ${w.other.url}\n`);
    const auth = await resolveActiveAuthSession({ env: {}, homeDir: w.home, cwd: w.home });
    assert.equal(auth.apiUrl, w.other.url, "resolution follows the project config");
    assert.equal(auth.credential.token, "c1");
    assert.equal(auth.credential.origin, w.configured.url, "the project config is not trusted");
    await w.assertHeldBack(auth.credential);
  } finally {
    await w.close();
  }
});

test("source: the stored login session", async () => {
  const w = await world();
  try {
    await writeStoredSession({ apiUrl: w.configured.url, token: "s1", tokenExpiresAt: inFuture(30) }, { homeDir: w.home });
    const auth = await resolveActiveAuthSession({ env: w.env, homeDir: w.home, cwd: w.home, explicitApiUrl: w.other.url });
    assert.equal(auth.credential.token, "s1");
    assert.equal(auth.credential.origin, w.configured.url);
    await w.assertHeldBack(auth.credential);
  } finally {
    await w.close();
  }
});

test("source: a rotated token, and the token it replaces, are only sent to the configured API", async () => {
  const w = await world({
    "POST /api/v1/auth/api-tokens": () => ({ id: "tok-new", token: "r2", token_prefix: "r", expires_at: inFuture(30) }),
    "DELETE /api/v1/auth/api-tokens/*": () => ({ ok: true }),
  });
  try {
    await writeStoredSession(
      { apiUrl: w.configured.url, token: "r1", tokenId: "tok-old", tokenExpiresAt: inFuture(1) },
      { homeDir: w.home },
    );
    const auth = await resolveActiveAuthSession({ env: w.env, homeDir: w.home, cwd: w.home });
    assert.equal(auth.rotated, true);
    assert.equal(auth.credential.token, "r2");
    assert.equal(auth.credential.origin, w.configured.url);
    assert.deepEqual(
      w.configured.requests.map((r) => `${r.method} ${r.authorization}`),
      ["POST Bearer r1", "DELETE Bearer r2"],
      "the old token issued its successor; the successor revoked the old one",
    );
    await w.assertHeldBack(auth.credential);
  } finally {
    await w.close();
  }
});

const LOGIN_ROUTES = {
  "POST /api/v1/auth/cli/sessions/start": () => ({ session_id: "s-1", poll_interval_seconds: 1 }),
  "POST /api/v1/auth/cli/sessions/poll": () => ({ status: "approved", auth_token: "a1" }),
  "GET /api/v1/auth/me": () => ({ id: "u-1", github_username: "fixture" }),
  "POST /api/v1/auth/api-tokens": () => ({ id: "tok-1", token: "i1", token_prefix: "i", expires_at: inFuture(30) }),
};

test("source: a login's approval token is only sent to the API it was issued by, the configured one", async () => {
  const w = await world(LOGIN_ROUTES);
  try {
    await loginAndPersistSession({ env: w.env, homeDir: w.home, cwd: w.home, skipBrowserOpen: true, timeoutMs: 20_000 });
    assert.deepEqual(
      w.configured.requests.filter((r) => r.authorization).map((r) => `${r.method} ${r.path} ${r.authorization}`),
      ["GET /api/v1/auth/me Bearer a1", "POST /api/v1/auth/api-tokens Bearer a1"],
    );
    const auth = await resolveActiveAuthSession({ env: w.env, homeDir: w.home, cwd: w.home, autoRotate: false });
    assert.equal(auth.credential.token, "i1", "the issued token is stored and loaded as a credential");
    await w.assertHeldBack(auth.credential);
  } finally {
    await w.close();
  }
});

test("a login whose resolved API differs from the trust context is refused before anything is sent", async () => {
  const w = await world(LOGIN_ROUTES);
  try {
    // resolution would use the project config's API; the trust context (global config) names another
    await fsp.mkdir(path.join(w.home, ".sentinelayer"), { recursive: true });
    await fsp.writeFile(path.join(w.home, ".sentinelayer", "config.yml"), `apiUrl: ${w.configured.url}\n`);
    await fsp.writeFile(path.join(w.home, ".sentinelayer.yml"), `apiUrl: ${w.other.url}\n`);
    await assert.rejects(
      loginAndPersistSession({ env: {}, homeDir: w.home, cwd: w.home, skipBrowserOpen: true, timeoutMs: 5_000 }),
      /Refusing to send your SentinelLayer credential .*SENTINELAYER_API_URL/s,
    );
    await assert.rejects(
      loginAndPersistSession({ env: w.env, homeDir: w.home, cwd: w.home, explicitApiUrl: w.other.url, skipBrowserOpen: true }),
      CredentialDestinationRefused,
    );
    assert.deepEqual(w.other.requests, [], "not even the login request");
    assert.deepEqual(w.configured.requests, []);
  } finally {
    await w.close();
  }
});

test("login, resolution and trust use the injected env, not the process environment", async () => {
  const w = await world(LOGIN_ROUTES);
  const saved = process.env.SENTINELAYER_API_URL;
  process.env.SENTINELAYER_API_URL = w.other.url; // the process names another API; the caller's env wins
  try {
    await loginAndPersistSession({ env: w.env, homeDir: w.home, cwd: w.home, skipBrowserOpen: true, timeoutMs: 20_000 });
    assert.ok(w.configured.requests.some((r) => r.path === "/api/v1/auth/me"));
    assert.deepEqual(w.other.requests, []);
  } finally {
    if (saved === undefined) delete process.env.SENTINELAYER_API_URL;
    else process.env.SENTINELAYER_API_URL = saved;
    await w.close();
  }
});

test("source: the init flow's approval token is sent only as a credential", async () => {
  const w = await world();
  try {
    const credential = await userCredential("n1", { env: w.env, source: "init_approval" });
    await assert.rejects(
      legacy.generateArtifacts({ apiUrl: w.other.url, credential, payload: {} }),
      CredentialDestinationRefused,
    );
    await assert.rejects(legacy.issueBootstrapToken({ apiUrl: w.other.url, credential }), CredentialDestinationRefused);
    assert.deepEqual(w.other.requests, []);
    await legacy.issueBootstrapToken({ apiUrl: w.configured.url, credential });
    assert.equal(w.configured.requests[0].authorization, "Bearer n1");
  } finally {
    await w.close();
  }
});

test("source: a hosted MCP bearer minted for the user", async () => {
  const w = await world({
    "POST /api/v1/auth/mcp-token": () => ({ access_token: "m1", token_type: "Bearer", expires_in: 60 }),
  });
  try {
    const minted = await requestHostedMcpAccessToken({ env: { ...w.env, SENTINELAYER_TOKEN: "m0" }, homeDir: w.home, cwd: w.home });
    assert.equal(minted.credential.token, "m1");
    assert.equal(minted.credential.origin, w.configured.url);
    await w.assertHeldBack(minted.credential);
  } finally {
    await w.close();
  }
});

test("the MCP smoke sends nothing to another origin, through an injected mint and transport", async () => {
  const w = await world();
  try {
    const sent = [];
    const fetchImpl = async (url, init) => {
      sent.push(url);
      return fetch(url, init);
    };
    for (const requestTokenImpl of [
      async () => ({ apiUrl: w.other.url, accessToken: "x1" }), // a bare token
      async () => ({ apiUrl: w.other.url, accessToken: "x2", credential: await userCredential("x2", { env: w.env }) }),
    ]) {
      await assert.rejects(
        runHostedMcpSmoke({ env: w.env, homeDir: w.home, requestTokenImpl, fetchImpl }),
        CredentialDestinationRefused,
      );
    }
    assert.deepEqual(sent, [], "the injected transport was never called");
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: SENTINELAYER_TOKEN used for the memory API reaches only the configured origin", async () => {
  const w = await world();
  try {
    const sent = [];
    const result = await queryHybridRetriever({
      query: "q",
      provider: "api",
      apiEndpoint: `${w.other.url}/memory`,
      credential: await userCredential("y1", { env: w.env }),
      fetchImpl: async (url, init) => {
        sent.push(url);
        return fetch(url, init);
      },
    });
    assert.equal(result.providerUsed, "local");
    assert.match(result.apiError, /Refusing to send your SentinelLayer credential/);
    assert.deepEqual(sent, []);
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: a token handed to the LLM proxy is bound to the configured API", async () => {
  const w = await world();
  const saved = process.env.SENTINELAYER_API_URL;
  process.env.SENTINELAYER_API_URL = w.configured.url;
  try {
    const sent = [];
    await assert.rejects(
      invokeViaProxy({
        prompt: "p",
        apiUrl: w.other.url,
        token: "z1",
        fetchImpl: async (url, init) => {
          sent.push(url);
          return fetch(url, init);
        },
      }),
      CredentialDestinationRefused,
    );
    assert.deepEqual(sent, []);
    assert.deepEqual(w.other.requests, []);
  } finally {
    if (saved === undefined) delete process.env.SENTINELAYER_API_URL;
    else process.env.SENTINELAYER_API_URL = saved;
    await w.close();
  }
});

test("source: a bare token from an injected resolver is bound to the configured API, never to the origin it names", async () => {
  const w = await world();
  try {
    const credential = await credentialFor({ token: "j1", apiUrl: w.other.url }, { env: w.env });
    assert.equal(credential.origin, w.configured.url);
    await w.assertHeldBack(credential);
  } finally {
    await w.close();
  }
});

test("source: an agent's admission credential is bound to the API that issued it", async () => {
  const w = await world();
  try {
    const credential = admissionCredential({ token: "d1", apiUrl: w.configured.url });
    assert.equal(credential.origin, w.configured.url);
    assert.equal(credential.source, "session_admission");
    await w.assertHeldBack(credential);
  } finally {
    await w.close();
  }
});

test("the pocket gateway credential comes from SENTI_POCKET_URL only", async () => {
  const w = await world();
  try {
    const api = await userCredential("g1", { env: w.env });
    assert.equal(await gatewayCredential(api, { env: { ...w.env, POCKET_GATEWAY_URL: w.other.url } }), null);
    const gateway = await gatewayCredential(api, { env: { ...w.env, SENTI_POCKET_URL: w.configured.url } });
    assert.equal(gateway.origin, w.configured.url);
    await w.assertHeldBack(gateway);
  } finally {
    await w.close();
  }
});
