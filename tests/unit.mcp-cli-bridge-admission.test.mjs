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

import { buildCliCommandMcpTools, createCliCommandMcpToolHandlers } from "../src/mcp/cli-command-tools.js";
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
  return {
    api,
    store,
    say,
    locks,
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
