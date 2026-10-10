import "./setup-env.mjs";
// Where the user's own SentinelLayer token may be sent. Two loopback servers stand in for
// the configured origin and for some other origin; the other one must receive nothing.
//   - The MCP CLI bridge exposes no option that names a destination (a URL, host, origin,
//     endpoint or gateway), for any tool.
//   - The transport sends the token only to origins built from the environment and the
//     user's global config, whatever a command or tool input names.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { requestJson } from "../src/auth/http.js";
import { readStoredSession, writeStoredSession } from "../src/auth/session-store.js";
import {
  CredentialDestinationRefused,
  noteUserCredential,
  trustedCredentialOrigins,
} from "../src/auth/credential-destinations.js";
import {
  buildCliCommandMcpTools,
  createCliCommandMcpToolHandlers,
  executeCliCommand,
} from "../src/mcp/cli-command-tools.js";
import { buildSentinelayerCliRegistryTemplate } from "../src/mcp/cli-registry.js";

const USER_TOKEN = `sl_user_${"u".repeat(40)}`;
const STORED_TOKEN = `sl_stored_${"s".repeat(40)}`;
const OTHER_TOKEN = `other_service_${"o".repeat(40)}`;
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

// Two origins and an isolated home; `env` is what a CLI process started here would see.
async function fixture({ envToken = USER_TOKEN, storedToken = "" } = {}) {
  const configured = await startServer();
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
    SENTI_POCKET_URL: configured.url,
  };
  delete env.SENTINELAYER_TOKEN;
  delete env.SENTINELAYER_API_TOKEN;
  delete env.POCKET_GATEWAY_URL;
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
    other,
    run,
    bridge,
    close: async () => {
      await configured.close();
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
  },
  {
    label: "mcp smoke",
    tool: "sl.mcp.smoke",
    key: "apiUrl",
    input: { json: true },
    argv: (to) => ["mcp", "smoke", "--json", ...(to ? ["--api-url", to] : [])],
    path: /\/auth\/mcp-token$/,
  },
  {
    label: "watch run-events",
    tool: "sl.watch.run-events",
    key: "apiUrl",
    input: { runId: "run-1", maxIdleSeconds: "1", json: true },
    argv: (to) => ["watch", "run-events", "--run-id", "run-1", "--max-idle-seconds", "1", "--json", ...(to ? ["--api-url", to] : [])],
    path: /\/runtime\/runs\/run-1\//,
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
    } finally {
      await fx.close();
    }
  });

  test(`through the bridge, ${c.label} still reaches the configured origin with the user's token`, async () => {
    const fx = await fixture();
    try {
      await fx.bridge(c.tool, c.input);
      const hit = fx.configured.requests.find((r) => c.path.test(r.path));
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

  test(`on the command line, ${c.label} naming the configured origin itself still works`, async () => {
    const fx = await fixture();
    try {
      await fx.run(c.argv(fx.configured.url));
      const hit = fx.configured.requests.find((r) => c.path.test(r.path));
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

// ---- every bridge tool, against the raw command tree

const DESTINATION_WORDS = new Set(["url", "urls", "uri", "uris", "host", "hosts", "hostname", "origin", "origins", "endpoint", "endpoints", "gateway", "gateways", "webhook", "webhooks", "proxy"]);
const wordsIn = (text) =>
  String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const namesDestination = (...texts) => texts.some((text) => wordsIn(text).some((word) => DESTINATION_WORDS.has(word)));

test("no bridge tool exposes an option or argument that names a destination", async () => {
  const registry = await buildSentinelayerCliRegistryTemplate({ generatedAt: "1970-01-01T00:00:00.000Z" });
  const raw = new Map(registry.tools.map((tool) => [tool.name, tool]));
  const tools = await buildCliCommandMcpTools();
  const exposed = [];
  for (const tool of tools) {
    if (tool.metadata.blocked) continue;
    const source = raw.get(tool.name);
    assert.ok(source, `${tool.name} comes from the command tree`);
    const schema = source.input_schema.properties || {};
    for (const argument of source.metadata.arguments || []) {
      const property = schema[argument.name] || {};
      if (namesDestination(argument.name, property.description) || /:\/\//.test(String(property.default ?? ""))) {
        exposed.push(`${tool.name} <${argument.name}>`);
      }
    }
    for (const option of source.metadata.options || []) {
      if (!option.takes_value) continue;
      const property = schema[option.name] || {};
      if (!namesDestination(option.name, option.flags, property.description) && !/:\/\//.test(String(property.default ?? ""))) continue;
      if (Object.hasOwn(tool.inputSchema.properties || {}, option.name) || tool.metadata.options.some((o) => o.name === option.name)) {
        exposed.push(`${tool.name} --${option.name}`);
      }
    }
  }
  assert.deepEqual(exposed, [], "a destination option or argument reached the bridge");
});

test("the bridge withholds exactly these destination options from the tools it exposes", async () => {
  const tools = await buildCliCommandMcpTools();
  const withheld = tools
    .filter((tool) => !tool.metadata.blocked && tool.metadata.withheldOptions.length > 0)
    .map((tool) => `${tool.name}: ${tool.metadata.withheldOptions.join(",")}`);
  assert.deepEqual(withheld, [
    "sl.ai.identity.lineage: apiUrl",
    "sl.audit.frontend: url",
    "sl.daemon.error.record: endpoint",
    "sl.mcp.doctor: apiUrl",
    "sl.mcp.smoke: apiUrl",
    "sl.ring-owner: gatewayUrl",
    "sl.session.wake.codex: dashboardUrl",
    "sl.session.wake.daemon: host,resumeSession",
    "sl.swarm.create: target",
    "sl.swarm.run: startUrl",
    "sl.swarm.scenario.init: startUrl",
    "sl.watch.run-events: apiUrl",
  ]);
});

// ---- the transport, in this process

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

test("the transport sends the user's token only to the configured origins, however it is carried", async () => {
  const configured = await startServer();
  const gateway = await startServer();
  const other = await startServer();
  try {
    await withEnv(
      { SENTINELAYER_TOKEN: USER_TOKEN, SENTINELAYER_API_URL: configured.url, SENTI_POCKET_URL: gateway.url },
      async () => {
        for (const init of [
          { headers: { Authorization: `Bearer ${USER_TOKEN}` } },
          { headers: { authorization: `bearer ${USER_TOKEN}` } },
          { headers: { "X-Api-Key": USER_TOKEN } },
          { headers: new Headers([["authorization", `Bearer ${USER_TOKEN}`]]) },
        ]) {
          await assert.rejects(fetch(`${other.url}/x`, init), CredentialDestinationRefused);
          await assert.rejects(fetch(new Request(`${other.url}/x`, init)), CredentialDestinationRefused);
        }
        await assert.rejects(fetch(`${other.url}/x?token=${USER_TOKEN}`), CredentialDestinationRefused);
        assert.deepEqual(other.requests, [], "nothing reached the other origin");

        await fetch(`${configured.url}/x`, { headers: { Authorization: `Bearer ${USER_TOKEN}` } });
        await fetch(`${gateway.url}/x`, { headers: { Authorization: `Bearer ${USER_TOKEN}` } });
        assert.equal(configured.requests.length, 1);
        assert.equal(gateway.requests.length, 1);

        // another service's credential, or none, is not this policy's business
        await fetch(`${other.url}/x`, { headers: { Authorization: `Bearer ${OTHER_TOKEN}` } });
        await fetch(`${other.url}/x`);
        assert.equal(other.requests.length, 2);
      },
    );
  } finally {
    await configured.close();
    await gateway.close();
    await other.close();
  }
});

test("a token read from the stored session is recognised wherever it is carried", async () => {
  const configured = await startServer();
  const other = await startServer();
  const token = `sl_noted_${"n".repeat(40)}`;
  try {
    await withEnv({ SENTINELAYER_TOKEN: undefined, SENTINELAYER_API_URL: configured.url }, async () => {
      await fetch(`${other.url}/x`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(other.requests.length, 1, "unknown before it is read");
      noteUserCredential(token);
      await assert.rejects(fetch(`${other.url}/x`, { headers: { Authorization: `Bearer ${token}` } }), CredentialDestinationRefused);
      assert.equal(other.requests.length, 1);
    });
  } finally {
    await configured.close();
    await other.close();
  }
});

test("a token read straight from the stored session, by any caller, is recognised", async () => {
  const configured = await startServer();
  const other = await startServer();
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-stored-reader-"));
  const token = `sl_reader_${"r".repeat(40)}`;
  try {
    const tokenExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await writeStoredSession({ apiUrl: configured.url, token, tokenExpiresAt }, { homeDir: home });
    await withEnv({ SENTINELAYER_TOKEN: undefined, SENTINELAYER_API_URL: configured.url }, async () => {
      const stored = await readStoredSession({ homeDir: home });
      await assert.rejects(
        fetch(`${other.url}/x`, { headers: { Authorization: `Bearer ${stored.token}` } }),
        CredentialDestinationRefused,
      );
      assert.deepEqual(other.requests, []);
    });
  } finally {
    await configured.close();
    await other.close();
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("a command that needs a destination is not exposed; an optional one is withheld", async () => {
  const tool = (name, { args = [], options = [], required = [] }) => ({
    name,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required,
      properties: Object.fromEntries([
        ...args.map((a) => [a.name, { type: "string", description: a.description || "" }]),
        ...options.map((o) => [o.name, { type: "string", description: o.description || "", ...(o.default ? { default: o.default } : {}) }]),
      ]),
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
        tool("sl.fixture.positional", { args: [{ name: "target", description: "Site URL to check" }] }),
        tool("sl.fixture.required", { options: [{ name: "base", flags: "--base <url>" }], required: ["base"] }),
        tool("sl.fixture.optional", {
          options: [
            { name: "hook", flags: "--hook <endpoint>" },
            { name: "seed", flags: "--seed <value>", default: "https://example.invalid/start" },
            { name: "label", flags: "--label <text>" },
          ],
        }),
      ],
    }),
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName["sl.fixture.positional"].metadata.blockedReason, "blocked_destination_input");
  assert.equal(byName["sl.fixture.required"].metadata.blockedReason, "blocked_destination_input");
  const optional = byName["sl.fixture.optional"];
  assert.equal(optional.metadata.blocked, false);
  assert.deepEqual(optional.metadata.withheldOptions, ["hook", "seed"]);
  assert.deepEqual(Object.keys(optional.inputSchema.properties).sort(), ["label", "timeoutMs"]);
  assert.deepEqual(optional.metadata.options.map((o) => o.name), ["label"]);
});

test("a refused destination is final in the API client: no retry, no request", async () => {
  const configured = await startServer();
  const other = await startServer();
  try {
    await withEnv({ SENTINELAYER_TOKEN: USER_TOKEN, SENTINELAYER_API_URL: configured.url }, async () => {
      await assert.rejects(
        requestJson(`${other.url}/api/v1/x`, { headers: { Authorization: `Bearer ${USER_TOKEN}` }, retryDelayMs: 1 }),
        CredentialDestinationRefused,
      );
      assert.deepEqual(other.requests, []);
    });
  } finally {
    await configured.close();
    await other.close();
  }
});

test("the trusted origins come from the environment and the global config only", async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-trusted-origins-"));
  const project = path.join(home, "project");
  try {
    assert.deepEqual(await trustedCredentialOrigins({ env: {}, homeDir: home }), ["https://api.sentinelayer.com"]);
    await fsp.mkdir(path.join(home, ".sentinelayer"), { recursive: true });
    await fsp.writeFile(path.join(home, ".sentinelayer", "config.yml"), "apiUrl: https://api.global.example\n");
    // a workspace's own config never names a trusted origin
    await fsp.mkdir(project, { recursive: true });
    await fsp.writeFile(path.join(project, ".sentinelayer.yml"), "apiUrl: https://api.project.example\n");
    assert.deepEqual(await trustedCredentialOrigins({ env: {}, homeDir: home }), ["https://api.global.example"]);
    assert.deepEqual(
      await trustedCredentialOrigins({
        env: { SENTINELAYER_API_URL: "https://api.env.example/v1", SENTI_POCKET_URL: "https://pocket.example/base" },
        homeDir: home,
      }),
      ["https://api.env.example", "https://pocket.example"],
    );
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
