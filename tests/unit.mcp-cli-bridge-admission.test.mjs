import "./setup-env.mjs";
// `sl session *` commands invoked through the generated sl.* MCP CLI bridge, against a
// loopback API that records which credential each request carries. When the session
// stores an admission on this machine (in any state), a bridged command runs on that
// admission or refuses with zero requests; the user's own token (configured throughout)
// is never sent. A session with no stored admission (a legacy room) runs as before.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCliCommandArgs,
  buildCliCommandMcpTools,
  createCliCommandMcpToolHandlers,
  executeCliCommand,
} from "../src/mcp/cli-command-tools.js";
import { buildCliProgram } from "../src/cli.js";
import { admissionCredentialPath } from "../src/session/admission.js";

const SID = "6b0f8c1e-3c2a-4d5e-8f90-a1b2c3d4e5f6";
const USER_TOKEN = ["user", "token", "bridge", "fixture"].join("_");
const ADMISSION_TOKEN = `sladm_${"B".repeat(43)}`;
const AGENT = "bridge-agent";

async function startApi() {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    requests.push({ method: req.method, path: req.url, bearer: String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") });
    const body = JSON.stringify(
      req.method === "POST" && /\/events$/.test(req.url)
        ? { ok: true, sequenceId: 1, cursor: "c1" }
        : { ok: true, events: [], sessions: [], session: { sessionId: SID, status: "active" } },
    );
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function bridgeFixture({ agentEnv } = {}) {
  const api = await startApi();
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-bridge-admission-"));
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
    SENTINELAYER_TOKEN: USER_TOKEN,
    SENTINELAYER_API_URL: api.url,
    SENTINELAYER_SKIP_REMOTE_SYNC: "0",
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
  };
  delete env.SENTINELAYER_AGENT_ID;
  if (agentEnv) env.SENTINELAYER_AGENT_ID = agentEnv;
  const tools = await buildCliCommandMcpTools({ buildProgramFn: async () => buildCliProgram({ invokeLegacy: async () => {} }) });
  const handlers = createCliCommandMcpToolHandlers(tools, { targetPath: ws, env });
  const store = async (agentId, overrides = {}) => {
    const file = admissionCredentialPath(SID, agentId, { homeDir: home });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      typeof overrides === "string"
        ? overrides
        : JSON.stringify({
            version: 2,
            sessionId: SID,
            agentId,
            apiUrl: api.url,
            admissionId: "adm-bridge",
            token: ADMISSION_TOKEN,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            ...overrides,
          }),
    );
  };
  const say = (agent) =>
    handlers["sl.session.say"]({ sessionId: SID, message: ["status from the bridge"], agent, path: ws, timeoutMs: 60_000 });
  const locks = () => handlers["sl.session.locks"]({ sessionId: SID, path: ws, timeoutMs: 60_000 });
  // The bridge handler for a tool, and the argv it builds for an input run directly in the
  // bridge's child environment, so the CLI's own checks are exercised without the handler's.
  const call = (toolName, input) => handlers[toolName]({ ...input, timeoutMs: 60_000 });
  const runArgv = (toolName, input) =>
    executeCliCommand(buildCliCommandArgs(tools.find((tool) => tool.name === toolName), input), {
      targetPath: ws,
      timeoutMs: 60_000,
      env,
    });
  return {
    api,
    ws,
    store,
    say,
    locks,
    call,
    runArgv,
    close: async () => {
      await api.close();
      await fsp.rm(home, { recursive: true, force: true });
    },
  };
}

test("a bridged session command runs on the LIVE admission its session stores and never sends the user's token", async () => {
  const fx = await bridgeFixture();
  try {
    await fx.store(AGENT);
    await fx.say(AGENT);
    assert.ok(fx.api.requests.length >= 1, "the command reached the API");
    assert.deepEqual(fx.api.requests.filter((r) => r.bearer !== ADMISSION_TOKEN), [], "admission credential only");
  } finally {
    await fx.close();
  }
});

for (const [state, prepare] of [
  ["expired", (fx) => fx.store(AGENT, { expiresAt: Math.floor(Date.now() / 1000) - 5 })],
  ["malformed", (fx) => fx.store(AGENT, "{not json")],
  ["bound to another session", (fx) => fx.store(AGENT, { sessionId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" })],
  ["held by a different agent", (fx) => fx.store("other-agent")],
]) {
  test(`a bridged session command refuses with zero requests when the session's stored admission is ${state}`, async () => {
    const fx = await bridgeFixture();
    try {
      await prepare(fx);
      const result = await fx.say(AGENT);
      assert.equal(result.ok, false);
      assert.match(String(result.stderr), /will not fall back/);
      assert.deepEqual(fx.api.requests, [], "no request at all, so never the user's token");
    } finally {
      await fx.close();
    }
  });
}

test("a bridged legacy data-plane command (say) in an agent context with no admission for the session runs as before", async () => {
  const fx = await bridgeFixture({ agentEnv: AGENT });
  try {
    await fx.say(AGENT);
    assert.ok(fx.api.requests.length >= 1, "the command reached the API");
    assert.deepEqual(fx.api.requests.filter((r) => r.bearer !== USER_TOKEN), [], "the user's own session, as today");
  } finally {
    await fx.close();
  }
});

test("a bridged control command (locks) in an agent context with no admission for the session is refused with zero requests", async () => {
  const fx = await bridgeFixture({ agentEnv: AGENT });
  try {
    const result = await fx.locks();
    assert.equal(result.ok, false);
    assert.match(String(result.stderr), /control operation.*will not fall back/s);
    assert.deepEqual(fx.api.requests, []);
  } finally {
    await fx.close();
  }
});

// Values the bridge copies into argv. Each case runs twice against a session that stores
// AGENT's live admission: through the bridge handler, which refuses the input outright, and
// as the argv that input would build, run directly in the bridge's child environment, where
// the CLI decides on Commander's parsed values and refuses. Neither sends a request.
const OUTSIDER = "outside-agent";
const DASH_VALUE_CASES = [
  ["say, a dash-only session id, agent from the environment", "sl.session.say", { sessionId: "--", message: [SID, "hi"] }, OUTSIDER],
  ["say, a dash-only session id, no agent in the environment", "sl.session.say", { sessionId: "--", message: [SID, "hi"] }, undefined],
  [
    "say, an option-shaped session id, agent from the environment",
    "sl.session.say",
    { sessionId: "--agent", message: [OUTSIDER, "--", SID, "hi"] },
    OUTSIDER,
  ],
  [
    "say, an option-shaped session id, no agent in the environment",
    "sl.session.say",
    { sessionId: "--agent", message: [OUTSIDER, "--", SID, "hi"] },
    undefined,
  ],
  [
    "reply, a dash-only session id, agent from the environment",
    "sl.session.reply",
    { sessionId: "--", targetSequenceId: SID, message: ["1", "hi"] },
    OUTSIDER,
  ],
  [
    "reply, a dash-only session id, no agent in the environment",
    "sl.session.reply",
    { sessionId: "--", targetSequenceId: SID, message: ["1", "hi"] },
    undefined,
  ],
];

for (const [label, toolName, input, agentEnv] of DASH_VALUE_CASES) {
  test(`a bridged value that starts with a dash is refused with zero requests: ${label}`, async () => {
    const fx = await bridgeFixture({ agentEnv });
    try {
      await fx.store(AGENT);
      const viaBridge = await fx.call(toolName, { ...input, path: fx.ws });
      assert.equal(viaBridge.ok, false);
      assert.equal(viaBridge.reason, "invalid_cli_tool_input");
      assert.equal(viaBridge.detail, "unsupported_input_value:sessionId");
      assert.deepEqual(fx.api.requests, [], "the bridge handler ran nothing");

      const direct = await fx.runArgv(toolName, { ...input, path: fx.ws });
      assert.notEqual(direct.exitCode, 0, String(direct.stdout));
      assert.match(String(direct.stderr), /stores an admission and this command's agent is not bound to it.*will not fall back/s);
      assert.deepEqual(fx.api.requests, [], "no request at all, so never the user's token");
    } finally {
      await fx.close();
    }
  });
}

for (const [label, toolName, input] of [
  ["say", "sl.session.say", { sessionId: SID, message: ["status from the holder"] }],
  ["reply", "sl.session.reply", { sessionId: SID, targetSequenceId: "1", message: ["reply from the holder"] }],
]) {
  test(`the session's own holder still runs on its admission through the bridge: ${label}, agent from the environment`, async () => {
    const fx = await bridgeFixture({ agentEnv: AGENT });
    try {
      await fx.store(AGENT);
      await fx.call(toolName, { ...input, path: fx.ws });
      assert.ok(fx.api.requests.length >= 1, "the command reached the API");
      assert.deepEqual(fx.api.requests.filter((r) => r.bearer !== ADMISSION_TOKEN), [], "admission credential only");
    } finally {
      await fx.close();
    }
  });
}

test("the bridge refuses a dash-leading value in any positional or option value", async () => {
  const fx = await bridgeFixture();
  try {
    for (const [toolName, input, key] of [
      ["sl.session.say", { sessionId: SID, message: ["fine", "-x"] }, "message"],
      ["sl.session.say", { sessionId: SID, message: ["fine"], agent: "--json" }, "agent"],
      ["sl.session.say", { sessionId: SID, message: ["fine"], path: " -p" }, "path"],
      ["sl.session.reply", { sessionId: SID, targetSequenceId: -1, message: ["fine"] }, "targetSequenceId"],
    ]) {
      const result = await fx.call(toolName, input);
      assert.equal(result.detail, `unsupported_input_value:${key}`);
    }
    assert.deepEqual(fx.api.requests, []);
  } finally {
    await fx.close();
  }
});
