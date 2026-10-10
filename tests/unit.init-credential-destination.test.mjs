import "./setup-env.mjs";
// `sl init` in a workspace whose .sentinelayer.yml names another API. The user's stored login
// token must go to the configured API only: natively, through the MCP CLI bridge, and from the
// detached daemon that init starts. One loopback is the configured API; another is the origin the
// workspace config names, and it must receive nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";

import { writeStoredSession } from "../src/auth/session-store.js";
import { registerInitCommand } from "../src/commands/init.js";
import {
  buildCliCommandMcpTools,
  createCliCommandMcpToolHandlers,
  executeCliCommand,
} from "../src/mcp/cli-command-tools.js";
import { spawnDetachedSentiDaemon } from "../src/session/daemon-spawn.js";

const USER_TOKEN = "init-user-token-0000";

// A loopback API; `routes` maps "METHOD /path" to [status, body].
async function startServer(routes = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization || "" });
    const [status, body] = routes[`${req.method} ${req.url}`] || [200, { ok: true }];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const interview = {
  projectName: "demo-app",
  projectDescription: "Build an autonomous secure code review orchestrator.",
  aiProvider: "openai",
  authMode: "byok",
  generationMode: "detailed",
  audienceLevel: "developer",
  projectType: "greenfield",
  codingAgent: "generic",
  techStack: ["TypeScript", "Node.js"],
  features: ["auth", "scanning"],
  connectRepo: false,
  repoSlug: "",
  buildFromExistingRepo: false,
  injectSecret: false,
};

// The configured API in the global config, a stored login, and a workspace whose own
// .sentinelayer.yml names another API (and a token of its own).
async function fixture(routes = {}) {
  const trusted = await startServer(routes);
  const other = await startServer();
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-destination-"));
  const ws = path.join(home, "workspace");
  await fsp.mkdir(path.join(home, ".sentinelayer"), { recursive: true });
  await fsp.mkdir(ws, { recursive: true });
  await fsp.writeFile(path.join(home, ".sentinelayer", "config.yml"), `apiUrl: ${trusted.url}\n`);
  await fsp.writeFile(
    path.join(ws, ".sentinelayer.yml"),
    `apiUrl: ${other.url}\nsentinelayerToken: workspace-token-0000\nopenaiApiKey: workspace-provider-key-0000\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_SKIP_REMOTE_SYNC: "0", // remote sync on, as in production
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
    SENTINELAYER_CLI_NON_INTERACTIVE: "1",
    SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
    SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(interview),
  };
  for (const name of ["SENTINELAYER_API_URL", "SENTINELAYER_TOKEN", "SENTINELAYER_API_TOKEN", "SENTI_POCKET_URL"]) delete env[name];
  await writeStoredSession(
    { apiUrl: trusted.url, token: USER_TOKEN, tokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
    { homeDir: home },
  );
  return {
    trusted,
    other,
    home,
    ws,
    env,
    close: async () => {
      await trusted.close();
      await other.close();
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

function assertTrustedOnly(fx) {
  assert.deepEqual(fx.other.requests, [], "the workspace's API received nothing");
  const sent = fx.trusted.requests.filter((r) => r.authorization);
  assert.ok(sent.length >= 1, "the configured API still received the project session's requests");
  assert.deepEqual(new Set(sent.map((r) => r.authorization)), new Set([`Bearer ${USER_TOKEN}`]));
}

test("sl init in a workspace naming another API sends the token only to the configured API", async () => {
  const fx = await fixture();
  try {
    const result = await executeCliCommand(["init", "demo-app", "--non-interactive"], {
      targetPath: fx.ws,
      timeoutMs: 120_000,
      env: { ...fx.env, SENTINELAYER_MCP_BRIDGE: "" },
    });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assertTrustedOnly(fx);
  } finally {
    await fx.close();
  }
});

test("sl.init through the MCP bridge in that workspace sends the token only to the configured API", async () => {
  const fx = await fixture();
  try {
    // past the approval gate (the MCP dispatcher refuses every CLI tool; unit.mcp-bridge-approval)
    const handlers = createCliCommandMcpToolHandlers(await buildCliCommandMcpTools(), { targetPath: fx.ws, env: fx.env, approve: () => true });
    const result = await handlers["sl.init"]({ projectName: "demo-app", nonInteractive: true, timeoutMs: 120_000 });
    assert.equal(result.ok, true, String(result.stderr));
    assertTrustedOnly(fx);
  } finally {
    await fx.close();
  }
});

test("init leaves the process environment alone, so the daemon it starts inherits no workspace API or token", async () => {
  const fx = await fixture();
  const cwd = process.cwd();
  const before = {
    api: process.env.SENTINELAYER_API_URL,
    token: process.env.SENTINELAYER_TOKEN,
    openai: process.env.OPENAI_API_KEY,
  };
  try {
    process.chdir(fx.ws); // init reads the workspace config from the working directory
    let seenByLegacy = null;
    const program = new Command().exitOverride();
    registerInitCommand(program, async () => {
      seenByLegacy = {
        api: process.env.SENTINELAYER_API_URL,
        token: process.env.SENTINELAYER_TOKEN,
        openai: process.env.OPENAI_API_KEY,
      };
    });
    await program.parseAsync(["init", "demo-app", "--non-interactive"], { from: "user" });
    assert.deepEqual(seenByLegacy, before, "init wrote nothing into the environment");

    // the detached daemon inherits the process environment as it is now
    const stub = path.join(fx.home, "daemon-stub.mjs");
    const out = path.join(fx.home, "daemon-env.json");
    await fsp.writeFile(
      stub,
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ api: process.env.SENTINELAYER_API_URL ?? null, token: process.env.SENTINELAYER_TOKEN ?? null }));\n`,
    );
    const spawned = await spawnDetachedSentiDaemon({
      sessionId: "6b0f8c1e-3c2a-4d5e-8f90-a1b2c3d4e5f6",
      targetPath: fx.ws,
      cliPath: stub,
      env: { ...process.env, SENTINELAYER_SKIP_SENTI_AUTOSTART: "", SENTINELAYER_SKIP_SENTI_DAEMON: "" },
    });
    assert.equal(spawned.spawned, true, JSON.stringify(spawned));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const inherited = JSON.parse(await fsp.readFile(out, "utf8"));
    assert.notEqual(inherited.api, fx.other.url);
    assert.notEqual(inherited.token, "workspace-token-0000");
    assert.deepEqual(inherited, { api: before.api ?? null, token: before.token ?? null });
  } finally {
    process.chdir(cwd);
    await fx.close();
  }
});

test("sl init with SentinelLayer auth talks to the API in the global config, never the workspace's", async () => {
  const fx = await fixture({
    "POST /api/v1/auth/cli/sessions/start": [200, { session_id: "s-1", authorize_url: "http://127.0.0.1/authorize", poll_interval_seconds: 1 }],
    "POST /api/v1/auth/cli/sessions/poll": [200, { status: "approved", auth_token: "init-approval-0000" }],
    "POST /api/v1/builder/generate": [400, { error: { code: "FIXTURE_STOP", message: "stop here" } }],
  });
  try {
    const env = {
      ...fx.env,
      SENTINELAYER_MCP_BRIDGE: "",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify({ ...interview, authMode: "sentinelayer" }),
    };
    await executeCliCommand(["init", "demo-app", "--non-interactive"], { targetPath: fx.ws, timeoutMs: 120_000, env });
    assert.ok(
      fx.trusted.requests.some((r) => r.method === "POST" && r.path === "/api/v1/auth/cli/sessions/start"),
      "the login for the scaffold went to the configured API",
    );
    const generate = fx.trusted.requests.find((r) => r.path === "/api/v1/builder/generate");
    assert.equal(generate?.authorization, "Bearer init-approval-0000", "and its approval token was sent there");
    assert.deepEqual(fx.other.requests, [], "the workspace's API received nothing");
  } finally {
    await fx.close();
  }
});
