import "./setup-env.mjs";
// Where the user's own SentinelLayer token may be sent. Loopback servers stand in for the
// configured API, the configured pocket gateway and some other origin; the other one must
// receive nothing.
//   - The MCP CLI bridge exposes only the inputs listed for each command, and none of them
//     names a destination (a URL, host, origin, endpoint or gateway).
//   - A credential is sent only by credentialedRequest, only to the origin the trust context
//     (environment and global config) bound it to, whatever a command or tool input names.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { requestJson } from "../src/auth/http.js";
import { writeStoredSession } from "../src/auth/session-store.js";
import {
  CredentialDestinationRefused,
  checkedTransport,
  credentialedRequest,
  resolveTrustContext,
  userCredential,
} from "../src/auth/credential-destinations.js";
import {
  buildCliCommandMcpTools,
  createCliCommandMcpToolHandlers,
  executeCliCommand,
} from "../src/mcp/cli-command-tools.js";
import { BRIDGE_ALLOWED_INPUTS, BRIDGE_DENIED_INPUTS, bridgeAllowedInputs } from "../src/mcp/bridge-inputs.js";
import { buildSentinelayerCliRegistryTemplate } from "../src/mcp/cli-registry.js";

const USER_TOKEN = `sl_user_${"u".repeat(40)}`;
const STORED_TOKEN = `sl_stored_${"s".repeat(40)}`;
const SID = "6b0f8c1e-3c2a-4d5e-8f90-a1b2c3d4e5f6";

async function startServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    requests.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    let body = { ok: true };
    if (/\/dial\/ring-owner$/.test(req.url)) body = { dialId: "dial-1", dispatched: true };
    else if (/\/auth\/mcp-token$/.test(req.url)) {
      body = { access_token: `mcp_${"m".repeat(40)}`, token_type: "Bearer", expires_in: 60, scope: "sessions:read" };
    } else if (/\/events\/list/.test(req.url)) body = { events: [] };
    else if (/\/status$/.test(req.url)) body = { status: "completed" };
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

const bearerOf = (request) => String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");

// The configured API, the configured pocket gateway, another origin and an isolated home;
// `env` is what a CLI process started here would see.
async function fixture({ envToken = USER_TOKEN, storedToken = "" } = {}) {
  const configured = await startServer();
  const gateway = await startServer();
  const other = await startServer();
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-credential-destinations-"));
  const ws = path.join(home, "ws");
  await fsp.mkdir(ws, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
    SENTINELAYER_API_URL: configured.url,
    SENTI_POCKET_URL: gateway.url,
  };
  delete env.SENTINELAYER_TOKEN;
  delete env.SENTINELAYER_API_TOKEN;
  if (envToken) env.SENTINELAYER_TOKEN = envToken;
  if (storedToken) {
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await writeStoredSession({ apiUrl: configured.url, token: storedToken, tokenExpiresAt }, { homeDir: home });
  }
  const run = (args) => executeCliCommand(args, { targetPath: ws, timeoutMs: 60_000, env: { ...env, SENTINELAYER_MCP_BRIDGE: "" } });
  let handlers = null;
  const bridge = async (toolName, input) => {
    handlers ||= createCliCommandMcpToolHandlers(await buildCliCommandMcpTools(), { targetPath: ws, env });
    return handlers[toolName]({ ...input, timeoutMs: 60_000 });
  };
  return {
    configured,
    gateway,
    other,
    run,
    bridge,
    close: async () => {
      await configured.close();
      await gateway.close();
      await other.close();
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

// The three commands, each given another origin: through the bridge, and on the command line.
const DESTINATION_CASES = [
  {
    label: "ring-owner",
    tool: "sl.ring-owner",
    key: "gatewayUrl",
    input: { question: "Ship it?", session: SID, json: true },
    argv: (to) => ["ring-owner", "Ship it?", "--session", SID, "--json", ...(to ? ["--gateway-url", to] : [])],
    path: /\/dial\/ring-owner$/,
    served: "gateway",
  },
  {
    label: "mcp smoke",
    tool: "sl.mcp.smoke",
    key: "apiUrl",
    input: { json: true },
    argv: (to) => ["mcp", "smoke", "--json", ...(to ? ["--api-url", to] : [])],
    path: /\/auth\/mcp-token$/,
    served: "configured",
  },
  {
    label: "watch run-events",
    tool: "sl.watch.run-events",
    key: "apiUrl",
    input: { runId: "run-1", maxIdleSeconds: "1", json: true },
    argv: (to) => ["watch", "run-events", "--run-id", "run-1", "--max-idle-seconds", "1", "--json", ...(to ? ["--api-url", to] : [])],
    path: /\/runtime\/runs\/run-1\//,
    served: "configured",
  },
];

for (const c of DESTINATION_CASES) {
  test(`the bridge does not accept a destination for ${c.label}, and sends nothing`, async () => {
    const fx = await fixture();
    try {
      const result = await fx.bridge(c.tool, { ...c.input, [c.key]: fx.other.url });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "invalid_cli_tool_input");
      assert.equal(result.detail, `unsupported_input:${c.key}`);
      assert.deepEqual(fx.other.requests, []);
      assert.deepEqual(fx.configured.requests, []);
      assert.deepEqual(fx.gateway.requests, []);
    } finally {
      await fx.close();
    }
  });

  test(`through the bridge, ${c.label} still reaches its configured origin with the user's token`, async () => {
    const fx = await fixture();
    try {
      await fx.bridge(c.tool, c.input);
      const hit = fx[c.served].requests.find((r) => c.path.test(r.path));
      assert.ok(hit, `the configured origin received ${c.label}`);
      assert.equal(bearerOf(hit), USER_TOKEN);
      assert.deepEqual(fx.other.requests, []);
    } finally {
      await fx.close();
    }
  });

  test(`on the command line, ${c.label} naming another origin is refused before anything is sent`, async () => {
    const fx = await fixture();
    try {
      const result = await fx.run(c.argv(fx.other.url));
      assert.notEqual(result.exitCode, 0, String(result.stdout));
      assert.match(`${result.stderr}${result.stdout}`, /Refusing to send your SentinelLayer credential to http:\/\/127\.0\.0\.1:\d+/);
      assert.deepEqual(fx.other.requests, [], "the other origin received nothing");
    } finally {
      await fx.close();
    }
  });

  test(`on the command line, ${c.label} naming its configured origin itself still works`, async () => {
    const fx = await fixture();
    try {
      await fx.run(c.argv(fx[c.served].url));
      const hit = fx[c.served].requests.find((r) => c.path.test(r.path));
      assert.ok(hit, `the configured origin received ${c.label}`);
      assert.equal(bearerOf(hit), USER_TOKEN);
      assert.deepEqual(fx.other.requests, []);
    } finally {
      await fx.close();
    }
  });
}

test("a token from the stored login session is held to the same origins", async () => {
  const fx = await fixture({ envToken: "", storedToken: STORED_TOKEN });
  try {
    const refused = await fx.run(DESTINATION_CASES[2].argv(fx.other.url));
    assert.notEqual(refused.exitCode, 0);
    assert.match(`${refused.stderr}${refused.stdout}`, /Refusing to send your SentinelLayer credential/);
    assert.deepEqual(fx.other.requests, []);
    await fx.run(DESTINATION_CASES[2].argv(""));
    const hit = fx.configured.requests.find((r) => DESTINATION_CASES[2].path.test(r.path));
    assert.equal(bearerOf(hit), STORED_TOKEN);
  } finally {
    await fx.close();
  }
});

// ---- every bridge tool, against the raw command tree and the explicit input list

// The bridge's own blocks (sensitive and recursive commands) need no entry in the input list.
const outrightBlocked = (tool) => tool.metadata.blocked && tool.metadata.blockedReason !== "blocked_unlisted_input";
const inputsOf = (source) => [
  ...new Set([...(source.metadata.arguments || []).map((a) => a.name), ...(source.metadata.options || []).map((o) => o.name)]),
];

test("every input of every command the bridge can run is either allowed or denied, and every entry is real", async () => {
  const registry = await buildSentinelayerCliRegistryTemplate({ generatedAt: "1970-01-01T00:00:00.000Z" });
  const raw = new Map(registry.tools.map((tool) => [tool.name.slice("sl.".length), tool]));
  const tools = await buildCliCommandMcpTools();
  const unclassified = [];
  const runnable = new Set();
  for (const tool of tools) {
    if (outrightBlocked(tool)) continue;
    const command = tool.name.slice("sl.".length);
    runnable.add(command);
    const allowed = bridgeAllowedInputs(command) || new Set();
    const denied = new Set(Object.keys(BRIDGE_DENIED_INPUTS[command] || {}));
    for (const input of inputsOf(raw.get(command))) {
      if (allowed.has(input) && denied.has(input)) unclassified.push(`${command} ${input} (both allowed and denied)`);
      else if (!allowed.has(input) && !denied.has(input)) unclassified.push(`${command} ${input}`);
    }
  }
  assert.deepEqual(unclassified, [], "classify each input in src/mcp/bridge-inputs.js");

  const stale = [];
  for (const [command, listed] of Object.entries(BRIDGE_ALLOWED_INPUTS)) {
    if (!runnable.has(command)) {
      stale.push(`${command} (not a command the bridge can run)`);
      continue;
    }
    const real = new Set(inputsOf(raw.get(command)));
    for (const input of listed.split(/\s+/).filter(Boolean)) if (!real.has(input)) stale.push(`${command} ${input}`);
  }
  for (const [command, inputs] of Object.entries(BRIDGE_DENIED_INPUTS)) {
    const real = new Set(raw.has(command) ? inputsOf(raw.get(command)) : []);
    for (const input of Object.keys(inputs)) if (!real.has(input)) stale.push(`${command} ${input} (denied)`);
  }
  assert.deepEqual(stale, [], "entries in src/mcp/bridge-inputs.js must name real inputs");
});

// An independent check of the list: a value-taking input that names a destination is never
// allowed, unless reviewed here as local.
const DESTINATION_WORDS = new Set(["url", "urls", "uri", "uris", "host", "hosts", "hostname", "origin", "origins", "endpoint", "endpoints", "gateway", "gateways", "webhook", "webhooks", "proxy"]);
const REVIEWED_LOCAL = new Set([
  "session.wake.daemon host", // the local host adapter to wake (claude|codex)
  "session.wake.daemon resumeSession", // the local host session id to resume
  "daemon.error.record endpoint", // a route label written to the local error intake
]);
const wordsIn = (text) =>
  String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const namesDestination = (...texts) => texts.some((text) => wordsIn(text).some((word) => DESTINATION_WORDS.has(word)));

test("no input the bridge exposes names a destination, apart from the reviewed local ones", async () => {
  const registry = await buildSentinelayerCliRegistryTemplate({ generatedAt: "1970-01-01T00:00:00.000Z" });
  const raw = new Map(registry.tools.map((tool) => [tool.name, tool]));
  const tools = await buildCliCommandMcpTools();
  const exposed = [];
  for (const tool of tools) {
    if (tool.metadata.blocked) continue;
    const source = raw.get(tool.name);
    const schema = source.input_schema.properties || {};
    const command = tool.name.slice("sl.".length);
    for (const argument of source.metadata.arguments || []) {
      const property = schema[argument.name] || {};
      if (namesDestination(argument.name, property.description) || /:\/\//.test(String(property.default ?? ""))) {
        exposed.push(`${command} ${argument.name}`);
      }
    }
    for (const option of source.metadata.options || []) {
      if (!option.takes_value) continue;
      const property = schema[option.name] || {};
      if (!namesDestination(option.name, option.flags, property.description) && !/:\/\//.test(String(property.default ?? ""))) continue;
      if (Object.hasOwn(tool.inputSchema.properties || {}, option.name) || tool.metadata.options.some((o) => o.name === option.name)) {
        exposed.push(`${command} ${option.name}`);
      }
    }
  }
  assert.deepEqual(exposed.filter((entry) => !REVIEWED_LOCAL.has(entry)), [], "a destination input reached the bridge");
  assert.deepEqual(exposed.sort(), [...REVIEWED_LOCAL].sort(), "each reviewed local input is still exposed");
});

test("the bridge withholds exactly the denied inputs from the commands it exposes", async () => {
  const tools = await buildCliCommandMcpTools();
  const withheld = tools
    .filter((tool) => !tool.metadata.blocked && tool.metadata.withheldOptions.length > 0)
    .map((tool) => `${tool.name}: ${tool.metadata.withheldOptions.join(",")}`);
  assert.deepEqual(withheld, [
    "sl.ai.identity.lineage: apiUrl",
    "sl.audit.frontend: url",
    "sl.mcp.doctor: apiUrl",
    "sl.mcp.smoke: apiUrl",
    "sl.ring-owner: gatewayUrl",
    "sl.session.wake.codex: dashboardUrl",
    "sl.swarm.create: target",
    "sl.swarm.run: startUrl",
    "sl.swarm.scenario.init: startUrl",
    "sl.watch.run-events: apiUrl",
  ]);
});

test("the bridge exposes only listed inputs: an unlisted option is withheld, an unlisted argument or command is not run", async () => {
  const tool = (name, { args = [], options = [], required = [] }) => ({
    name,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required,
      properties: Object.fromEntries([...args, ...options].map((input) => [input.name, { type: "string" }])),
    },
    metadata: {
      generated_from: "commander",
      execution: "bridge",
      argv: name.slice(3).split("."),
      arguments: args.map((a) => ({ name: a.name, required: true, variadic: false })),
      options: options.map((o) => ({ name: o.name, flags: o.flags, takes_value: true })),
    },
  });
  const tools = await buildCliCommandMcpTools({
    buildRegistryTemplateFn: async () => ({
      tools: [
        // a listed command given one unlisted option: the option is withheld
        tool("sl.session.say", {
          args: [{ name: "sessionId" }],
          options: [{ name: "agent", flags: "--agent <id>" }, { name: "relay", flags: "--relay <value>" }],
        }),
        // a listed command given an unlisted argument: not run
        tool("sl.session.read", { args: [{ name: "sessionId" }, { name: "extra" }] }),
        // a listed command given an unlisted required option: not run
        tool("sl.watch.history", { options: [{ name: "relay", flags: "--relay <value>" }], required: ["relay"] }),
        // a command with no entry: not run
        tool("sl.fixture.unlisted", { options: [{ name: "label", flags: "--label <text>" }] }),
      ],
    }),
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const say = byName["sl.session.say"];
  assert.equal(say.metadata.blocked, false);
  assert.deepEqual(say.metadata.withheldOptions, ["relay"]);
  assert.deepEqual(Object.keys(say.inputSchema.properties).sort(), ["agent", "sessionId", "timeoutMs"]);
  assert.deepEqual(say.metadata.options.map((o) => o.name), ["agent"]);
  for (const name of ["sl.session.read", "sl.watch.history", "sl.fixture.unlisted"]) {
    assert.equal(byName[name].metadata.blockedReason, "blocked_unlisted_input", name);
  }
});

test("session wake daemon still runs through the bridge with its local host and session to resume", async () => {
  const fx = await fixture();
  try {
    const result = await fx.bridge("sl.session.wake.daemon", {
      sessionId: SID,
      agent: "wake-agent",
      host: "codex",
      resumeSession: "host-session-1",
      once: true,
      json: true,
    });
    assert.equal(result.ok, true, String(result.stderr));
    assert.equal(result.json?.command, "session wake daemon");
    assert.equal(result.json?.host, "codex");
    assert.equal(result.json?.once, true);
    const read = fx.configured.requests.find((r) => r.path.startsWith(`/api/v1/sessions/${SID}/events`));
    assert.ok(read, "the tick read the session from the configured API");
    assert.equal(bearerOf(read), USER_TOKEN);
    assert.deepEqual(fx.other.requests, []);
  } finally {
    await fx.close();
  }
});

// ---- credentialedRequest, the one way a credential is sent

const recordingTransport = () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    return fetch(url, init);
  };
  return { sent, fetchImpl };
};

test("a credential goes nowhere but its own origin, and an injected transport is never called for another", async () => {
  const configured = await startServer();
  const other = await startServer();
  try {
    const credential = await userCredential(USER_TOKEN, { env: { SENTINELAYER_API_URL: configured.url } });
    const { sent, fetchImpl } = recordingTransport();
    await assert.rejects(credentialedRequest(credential, `${other.url}/x`, {}, { fetchImpl }), CredentialDestinationRefused);
    assert.deepEqual(sent, [], "the injected transport was not called");
    assert.deepEqual(other.requests, []);
    const response = await credentialedRequest(credential, `${configured.url}/x`, {}, { fetchImpl });
    assert.equal(response.status, 200);
    assert.equal(bearerOf(configured.requests[0]), USER_TOKEN);
  } finally {
    await configured.close();
    await other.close();
  }
});

test("a short token is bound and held back like any other", async () => {
  const configured = await startServer();
  const other = await startServer();
  try {
    const credential = await userCredential("t", { env: { SENTINELAYER_API_URL: configured.url } });
    await assert.rejects(credentialedRequest(credential, `${other.url}/x`), CredentialDestinationRefused);
    assert.deepEqual(other.requests, []);
    await credentialedRequest(credential, `${configured.url}/x`);
    assert.equal(configured.requests[0].headers.authorization, "Bearer t");
  } finally {
    await configured.close();
    await other.close();
  }
});

test("only a credential minted from the trust context is sent: a look-alike object is refused", async () => {
  const other = await startServer();
  try {
    const forged = Object.freeze({ token: USER_TOKEN, origin: other.url, source: "user" });
    await assert.rejects(credentialedRequest(forged, `${other.url}/x`), TypeError);
    await assert.rejects(requestJson(`${other.url}/x`, { credential: forged }), TypeError);
    assert.deepEqual(other.requests, []);
  } finally {
    await other.close();
  }
});

test("the Authorization header is set by credentialedRequest alone", async () => {
  const configured = await startServer();
  try {
    const credential = await userCredential(USER_TOKEN, { env: { SENTINELAYER_API_URL: configured.url } });
    await credentialedRequest(credential, `${configured.url}/x`, {
      headers: { authorization: "Bearer something-else", AUTHORIZATION: "x", "X-Trace": "1" },
    });
    assert.equal(configured.requests[0].headers.authorization, `Bearer ${USER_TOKEN}`);
    assert.equal(configured.requests[0].headers["x-trace"], "1");
  } finally {
    await configured.close();
  }
});

test("a credentialed request never follows a redirect, whatever the caller asks", async () => {
  const other = await startServer();
  const redirecting = createServer((req, res) => {
    res.writeHead(302, { Location: `${other.url}/landing` });
    res.end();
  });
  redirecting.listen(0, "127.0.0.1");
  await once(redirecting, "listening");
  const configuredUrl = `http://127.0.0.1:${redirecting.address().port}`;
  try {
    const credential = await userCredential(USER_TOKEN, { env: { SENTINELAYER_API_URL: configuredUrl } });
    for (const init of [{}, { redirect: "follow" }, { redirect: "manual", headers: { "X-Session-Token": USER_TOKEN } }]) {
      await assert.rejects(credentialedRequest(credential, `${configuredUrl}/start`, init), TypeError);
    }
    assert.deepEqual(other.requests, [], "the redirect target received nothing");
  } finally {
    await new Promise((resolve) => redirecting.close(resolve));
    await other.close();
  }
});

test("an injectable request function is checked before it runs", async () => {
  const configured = await startServer();
  const other = await startServer();
  try {
    const credential = await userCredential(USER_TOKEN, { env: { SENTINELAYER_API_URL: configured.url } });
    const calls = [];
    const checked = checkedTransport(async (url, options) => {
      calls.push(url);
      return options;
    });
    await assert.rejects(checked(`${other.url}/x`, { credential }), CredentialDestinationRefused);
    assert.deepEqual(calls, []);
    await checked(`${configured.url}/x`, { credential });
    assert.deepEqual(calls, [`${configured.url}/x`]);
  } finally {
    await configured.close();
    await other.close();
  }
});

test("a refused destination is final in the API client: no retry, no request", async () => {
  const configured = await startServer();
  const other = await startServer();
  try {
    const credential = await userCredential(USER_TOKEN, { env: { SENTINELAYER_API_URL: configured.url } });
    await assert.rejects(requestJson(`${other.url}/api/v1/x`, { credential, retryDelayMs: 1 }), CredentialDestinationRefused);
    assert.deepEqual(other.requests, []);
  } finally {
    await configured.close();
    await other.close();
  }
});

test("the trust context comes from the environment and the global config only", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-trust-context-"));
  const project = path.join(home, "project");
  try {
    assert.deepEqual({ ...(await resolveTrustContext({ env: {}, homeDir: home })) }, {
      apiOrigin: "https://api.sentinelayer.com",
      gatewayOrigin: "",
    });
    await fsp.mkdir(path.join(home, ".sentinelayer"), { recursive: true });
    await fsp.writeFile(path.join(home, ".sentinelayer", "config.yml"), "apiUrl: https://api.global.example\n");
    // a workspace's own config never names a trusted origin
    await fsp.mkdir(project, { recursive: true });
    await fsp.writeFile(path.join(project, ".sentinelayer.yml"), "apiUrl: https://api.project.example\n");
    assert.equal((await resolveTrustContext({ env: {}, homeDir: home })).apiOrigin, "https://api.global.example");
    const fromEnv = await resolveTrustContext({
      env: {
        SENTINELAYER_API_URL: "https://api.env.example/v1",
        SENTI_POCKET_URL: "https://pocket.example/base",
        POCKET_GATEWAY_URL: "https://other-gateway.example",
      },
      homeDir: home,
    });
    assert.equal(fromEnv.apiOrigin, "https://api.env.example");
    assert.equal(fromEnv.gatewayOrigin, "https://pocket.example", "the pocket gateway comes from SENTI_POCKET_URL only");
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
