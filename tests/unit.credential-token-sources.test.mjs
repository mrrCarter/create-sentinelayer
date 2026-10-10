import "./setup-env.mjs";
// Every way the user's own SentinelLayer token reaches this process is recognised by the
// transport before the token is first used, so it is only ever sent to the configured origins
// (src/auth/credential-destinations.js). One loopback server is the configured API; another
// stands in for any other origin, and the token sent there must be refused.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CredentialDestinationRefused } from "../src/auth/credential-destinations.js";
import { loginAndPersistSession, resolveActiveAuthSession } from "../src/auth/service.js";
import { readStoredSession, writeStoredSession } from "../src/auth/session-store.js";
import { requestHostedMcpAccessToken } from "../src/mcp/token-service.js";
import { __legacyCredentialFlowForTests as legacy } from "../src/legacy-cli.js";

// One random token per label: none is a substring of another, so each source is recognised on its own.
const tokens = new Map();
const token = (label) => {
  if (!tokens.has(label)) tokens.set(label, `${label}_${randomBytes(24).toString("hex")}`);
  return tokens.get(label);
};

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

async function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
    // Whether the transport refuses to carry `value` to the other origin.
    refusedElsewhere: async (value) => {
      try {
        await fetch(`${other.url}/probe`, { headers: { Authorization: `Bearer ${value}` } });
        return false;
      } catch (error) {
        return error instanceof CredentialDestinationRefused;
      }
    },
    close: async () => {
      await configured.close();
      await other.close();
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

const inWorld = (w, fn, extraEnv = {}) =>
  withEnv(
    {
      SENTINELAYER_TOKEN: undefined,
      SENTINELAYER_API_TOKEN: undefined,
      SENTINELAYER_API_URL: w.configured.url,
      SENTINELAYER_DISABLE_KEYRING: "1",
      ...extraEnv,
    },
    fn,
  );

test("source: SENTINELAYER_TOKEN in the environment", async () => {
  const w = await world();
  try {
    await inWorld(w, async () => assert.equal(await w.refusedElsewhere(token("env_main")), true), {
      SENTINELAYER_TOKEN: token("env_main"),
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: SENTINELAYER_API_TOKEN in the environment", async () => {
  const w = await world();
  try {
    await inWorld(w, async () => assert.equal(await w.refusedElsewhere(token("env_api")), true), {
      SENTINELAYER_API_TOKEN: token("env_api"),
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: a token in the environment a caller passes to auth resolution", async () => {
  const w = await world();
  try {
    await inWorld(w, async () => {
      const auth = await resolveActiveAuthSession({ env: { SENTINELAYER_TOKEN: token("env_param") }, homeDir: w.home });
      assert.equal(auth.token, token("env_param"));
      assert.equal(await w.refusedElsewhere(auth.token), true);
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: the sentinelayerToken config value", async () => {
  const w = await world();
  try {
    await fsp.mkdir(path.join(w.home, ".sentinelayer"), { recursive: true });
    await fsp.writeFile(path.join(w.home, ".sentinelayer", "config.yml"), `sentinelayerToken: ${token("config")}\n`);
    await inWorld(w, async () => {
      const auth = await resolveActiveAuthSession({ env: {}, homeDir: w.home, cwd: w.home });
      assert.equal(auth.token, token("config"));
      assert.equal(await w.refusedElsewhere(auth.token), true);
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: the stored login session", async () => {
  const w = await world();
  try {
    const tokenExpiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
    await inWorld(w, async () => {
      await writeStoredSession({ apiUrl: w.configured.url, token: token("stored"), tokenExpiresAt }, { homeDir: w.home });
      const stored = await readStoredSession({ homeDir: w.home });
      assert.equal(await w.refusedElsewhere(stored.token), true);
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("sources: a login's approval token (before its first use) and the API token it issues", async () => {
  const probes = [];
  let w;
  w = await world({
    "POST /api/v1/auth/cli/sessions/start": () => ({ session_id: "s-1", poll_interval_seconds: 1 }),
    "POST /api/v1/auth/cli/sessions/poll": () => ({ status: "approved", auth_token: token("approval") }),
    // the approval token's first use: is it already held to the configured origins?
    "GET /api/v1/auth/me": async () => {
      probes.push(await w.refusedElsewhere(token("approval")));
      return { id: "u-1", github_username: "fixture" };
    },
    "POST /api/v1/auth/api-tokens": () => ({ id: "tok-1", token: token("issued"), token_prefix: "issued_", expires_at: new Date(Date.now() + 30 * 86400_000).toISOString() }),
  });
  try {
    await inWorld(w, async () => {
      await loginAndPersistSession({ homeDir: w.home, cwd: w.home, skipBrowserOpen: true, timeoutMs: 20_000 });
      assert.deepEqual(probes, [true], "the approval token was recognised before it was first sent");
      assert.equal(await w.refusedElsewhere(token("issued")), true);
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("a login against an API that is not configured is refused before anything is sent", async () => {
  const w = await world();
  try {
    await inWorld(w, async () => {
      await assert.rejects(
        loginAndPersistSession({ homeDir: w.home, cwd: w.home, explicitApiUrl: w.other.url, skipBrowserOpen: true, timeoutMs: 5_000 }),
        /Refusing to send your SentinelLayer credential .*SENTINELAYER_API_URL/s,
      );
    });
    assert.deepEqual(w.other.requests, [], "not even the login request");
  } finally {
    await w.close();
  }
});

test("source: a rotated token (before its first use)", async () => {
  const probes = [];
  let w;
  w = await world({
    "POST /api/v1/auth/api-tokens": () => ({ id: "tok-new", token: token("rotated"), token_prefix: "rotated_", expires_at: new Date(Date.now() + 30 * 86400_000).toISOString() }),
    // the rotated token's first use is revoking the token it replaces
    "DELETE /api/v1/auth/api-tokens/*": async () => {
      probes.push(await w.refusedElsewhere(token("rotated")));
      return { ok: true };
    },
  });
  try {
    await inWorld(w, async () => {
      const nearExpiry = new Date(Date.now() + 86400_000).toISOString();
      await writeStoredSession(
        { apiUrl: w.configured.url, token: token("expiring"), tokenId: "tok-old", tokenExpiresAt: nearExpiry },
        { homeDir: w.home },
      );
      const auth = await resolveActiveAuthSession({ env: {}, homeDir: w.home, cwd: w.home });
      assert.equal(auth.token, token("rotated"));
      assert.equal(auth.rotated, true);
      assert.deepEqual(probes, [true], "the rotated token was recognised before it was first sent");
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: the init flow's approval token", async () => {
  const w = await world({
    "POST /api/v1/auth/cli/sessions/poll": () => ({ status: "approved", auth_token: token("init_approval") }),
  });
  try {
    await inWorld(w, async () => {
      const approval = await legacy.pollCliSession({ apiUrl: w.configured.url, sessionId: "s-1", challenge: "c", pollIntervalSeconds: 1, timeoutMs: 10_000 });
      assert.equal(approval.auth_token, token("init_approval"));
      assert.equal(await w.refusedElsewhere(approval.auth_token), true);
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("sources: the project tokens the init flow issues", async () => {
  const w = await world({
    "POST /api/v1/builder/generate": () => ({ bootstrap_token: { token: token("bootstrap_generated") } }),
    "POST /api/v1/builder/bootstrap-token": () => ({ token: token("bootstrap_issued") }),
  });
  try {
    await inWorld(w, async () => {
      await legacy.generateArtifacts({ apiUrl: w.configured.url, authToken: "unused", payload: {} });
      await legacy.issueBootstrapToken({ apiUrl: w.configured.url, authToken: "unused" });
      assert.equal(await w.refusedElsewhere(token("bootstrap_generated")), true);
      assert.equal(await w.refusedElsewhere(token("bootstrap_issued")), true);
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});

test("source: a hosted MCP bearer minted for the user", async () => {
  const w = await world({
    "POST /api/v1/auth/mcp-token": () => ({ access_token: token("mcp_access"), token_type: "Bearer", expires_in: 60 }),
  });
  try {
    await inWorld(w, async () => {
      const minted = await requestHostedMcpAccessToken({
        env: { SENTINELAYER_TOKEN: token("mint_caller"), SENTINELAYER_API_URL: w.configured.url },
        homeDir: w.home,
        cwd: w.home,
      });
      assert.equal(minted.accessToken, token("mcp_access"));
      assert.equal(await w.refusedElsewhere(minted.accessToken), true);
    });
    assert.deepEqual(w.other.requests, []);
  } finally {
    await w.close();
  }
});
