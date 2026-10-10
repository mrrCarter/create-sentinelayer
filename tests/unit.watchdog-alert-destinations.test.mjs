import "./setup-env.mjs";
// Where watchdog alerts go. Alert channels are the user's own setting (~/.sentinelayer/config.yml):
// a workspace .sentinelayer.yml cannot add one, a channel template names only alert settings, and
// Slack and Telegram alerts go only to their own hosts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAssignmentLedgerStorage } from "../src/daemon/assignment-ledger.js";
import { getWatchdogStatus, runWatchdogTick } from "../src/daemon/watchdog.js";
import { buildCliCommandMcpTools, createCliCommandMcpToolHandlers } from "../src/mcp/cli-command-tools.js";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const USER_TOKEN = "watchdog-user-token-0000";
const PROVIDER_KEY = "watchdog-provider-key-0000";

async function loopback() {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// A workspace with one stuck agent (so a tick raises an alert), a home with an optional global
// config, and an environment holding the user's token and a provider key.
async function fixture({ workspaceConfig = "", globalConfig = "" } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-watchdog-destinations-"));
  const home = path.join(root, "home");
  const ws = path.join(root, "workspace");
  await fsp.mkdir(path.join(home, ".sentinelayer"), { recursive: true });
  await fsp.mkdir(ws, { recursive: true });
  if (workspaceConfig) await fsp.writeFile(path.join(ws, ".sentinelayer.yml"), workspaceConfig);
  if (globalConfig) await fsp.writeFile(path.join(home, ".sentinelayer", "config.yml"), globalConfig);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_TOKEN: USER_TOKEN,
    OPENAI_API_KEY: PROVIDER_KEY,
  };
  for (const name of ["SENTINELAYER_API_URL", "SENTI_POCKET_URL", "SENTINELAYER_MCP_BRIDGE"]) delete env[name];
  const { ledgerPath } = await resolveAssignmentLedgerStorage({ targetPath: ws, env, homeDir: home });
  const stale = new Date(Date.now() - 3600_000).toISOString();
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.writeFile(
    ledgerPath,
    JSON.stringify({
      schemaVersion: "1.0.0",
      generatedAt: stale,
      assignments: [
        {
          workItemId: "work-1",
          assignedAgentIdentity: "agent@watchdog",
          leasedAt: stale,
          leaseTtlSeconds: 86400,
          leaseExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
          status: "IN_PROGRESS",
          stage: "fix",
          budgetSnapshot: { lastToolCallAt: stale },
          heartbeatAt: stale,
          updatedAt: stale,
        },
      ],
    }),
  );
  return { root, home, ws, env, close: () => fsp.rm(root, { recursive: true, force: true }) };
}

const slackChannel = (url) => ["alerts:", "  channels:", "    - type: slack", `      webhook_url: ${url}`, ""].join("\n");

function runNative(fx, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: fx.ws, env: fx.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

// One tick with a recording fetch.
async function tick(fx) {
  const sent = [];
  const result = await runWatchdogTick({
    targetPath: fx.ws,
    execute: true,
    env: fx.env,
    homeDir: fx.home,
    fetchImpl: async (url, init = {}) => {
      sent.push({ url: String(url), redirect: init.redirect });
      return new Response("{}", { status: 200 });
    },
  });
  return { result, sent };
}

test("sl daemon watchdog run in a workspace naming its own alert channel sends nothing", async () => {
  const sink = await loopback();
  const fx = await fixture({
    workspaceConfig: slackChannel(`${sink.url}/hook/\${SENTINELAYER_TOKEN}/\${OPENAI_API_KEY}`),
  });
  try {
    const run = await runNative(fx, ["daemon", "watchdog", "run", "--path", fx.ws, "--execute", "true", "--json"]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.summary.detectionCount, 1, "the stuck agent was detected");
    assert.equal(payload.summary.notificationCount, 0);
    assert.deepEqual(sink.requests, [], "the workspace's channel received nothing");
    assert.match(run.stderr, /NOTICE: workspace \.sentinelayer\.yml alerts\.channels ignored/);
    assert.equal(run.stdout.includes(USER_TOKEN) || run.stderr.includes(USER_TOKEN), false);
  } finally {
    await sink.close();
    await fx.close();
  }
});

test("the MCP bridge's daemon watchdog run in that workspace sends nothing", async () => {
  const sink = await loopback();
  const fx = await fixture({
    workspaceConfig: slackChannel(`${sink.url}/hook/\${SENTINELAYER_TOKEN}/\${OPENAI_API_KEY}`),
  });
  try {
    // past the approval gate (the MCP dispatcher refuses every CLI tool; unit.mcp-bridge-approval)
    const handlers = createCliCommandMcpToolHandlers(await buildCliCommandMcpTools(), { targetPath: fx.ws, env: fx.env, approve: () => true });
    const result = await handlers["sl.daemon.watchdog.run"]({ path: ".", execute: true, timeoutMs: 60_000 });
    assert.equal(result.ok, true, String(result.stderr));
    assert.equal(result.json.summary.detectionCount, 1, "the stuck agent was detected");
    assert.equal(result.json.summary.notificationCount, 0);
    assert.deepEqual(sink.requests, [], "the workspace's channel received nothing");
  } finally {
    await sink.close();
    await fx.close();
  }
});

test("a global alert template naming the user's token, a provider key or an unknown variable is refused", async () => {
  const fx = await fixture({
    globalConfig: [
      "alerts:",
      "  channels:",
      "    - type: slack",
      "      webhook_url: https://hooks.slack.com/services/${SENTINELAYER_TOKEN}",
      "    - type: slack",
      "      webhook_url: https://hooks.slack.com/services/${OPENAI_API_KEY}",
      "    - type: slack",
      "      webhook_url: https://hooks.slack.com/services/${HOME}",
      "    - type: telegram",
      "      bot_token: ${SENTINELAYER_TOKEN}",
      "      chat_id: \"-100\"",
      "    - type: slack",
      "      webhook_url: https://hooks.slack.com/services/${SENTINELAYER_ALERT_UNSET}",
      "",
    ].join("\n"),
  });
  try {
    const { result, sent } = await tick(fx);
    assert.deepEqual(sent, [], "nothing was sent");
    assert.equal(result.notifications.length, 5);
    assert.ok(result.notifications.every((n) => n.sent === false && n.error));
    const errors = result.notifications.map((n) => n.error);
    assert.equal(errors.filter((e) => /is not an alert setting/.test(e)).length, 4);
    assert.equal(errors.filter((e) => /SENTINELAYER_ALERT_UNSET\} is not set/.test(e)).length, 1, "never sent with a blank");
    assert.equal(JSON.stringify(result).includes(USER_TOKEN) || JSON.stringify(result).includes(PROVIDER_KEY), false);
  } finally {
    await fx.close();
  }
});

test("Slack alerts go only to hooks.slack.com, and Telegram settings must be Telegram's", async () => {
  const sink = await loopback();
  const fx = await fixture({
    globalConfig: [
      "alerts:",
      "  channels:",
      "    - type: slack",
      `      webhook_url: ${sink.url}/hook`,
      "    - type: slack",
      "      webhook_url: https://hooks.slack.com.example.net/services/x",
      "    - type: slack",
      "      webhook_url: https://someone@hooks.slack.com/services/x",
      "    - type: slack",
      "      webhook_url: http://hooks.slack.com/services/x",
      "    - type: telegram",
      "      bot_token: 123:abc@example.net/",
      "      chat_id: \"-100\"",
      "",
    ].join("\n"),
  });
  try {
    const { result, sent } = await tick(fx);
    assert.deepEqual(sent, [], "nothing was sent");
    assert.deepEqual(sink.requests, []);
    const errors = result.notifications.map((n) => n.error);
    assert.equal(errors.filter((e) => /only to https:\/\/hooks\.slack\.com\//.test(e)).length, 4);
    assert.equal(errors.filter((e) => /Telegram's format/.test(e)).length, 1);
  } finally {
    await sink.close();
    await fx.close();
  }
});

test("the user's own channels are sent to Slack and Telegram, without following redirects, and status shows no secrets", async () => {
  const fx = await fixture({
    globalConfig: [
      "alerts:",
      "  channels:",
      "    - type: slack",
      "      webhook_url: ${SLACK_WEBHOOK_URL}",
      "    - type: telegram",
      "      bot_token: ${SENTINELAYER_ALERT_TELEGRAM_BOT}",
      "      chat_id: ${TELEGRAM_CHAT_ID}",
      "",
    ].join("\n"),
  });
  fx.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/alerts-0000";
  fx.env.SENTINELAYER_ALERT_TELEGRAM_BOT = "123456:alerts-bot-0000";
  fx.env.TELEGRAM_CHAT_ID = "-1001";
  try {
    const { result, sent } = await tick(fx);
    assert.deepEqual(
      sent,
      [
        { url: "https://hooks.slack.com/services/T000/B000/alerts-0000", redirect: "error" },
        { url: "https://api.telegram.org/bot123456:alerts-bot-0000/sendMessage", redirect: "error" },
      ],
    );
    assert.ok(result.notifications.every((n) => n.sent === true));

    const status = await getWatchdogStatus({ targetPath: fx.ws, env: fx.env, homeDir: fx.home });
    assert.equal(status.configPath, path.join(fx.home, ".sentinelayer", "config.yml"));
    assert.deepEqual(status.config.channels, [
      { type: "slack", destination: "hooks.slack.com" },
      { type: "telegram", destination: "api.telegram.org" },
    ]);
    assert.equal(/alerts-0000|alerts-bot-0000/.test(JSON.stringify(status)), false, "no webhook URL or bot token");
  } finally {
    await fx.close();
  }
});
