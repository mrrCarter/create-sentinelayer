import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");
const TEST_TOKEN = ["api", "token", "unit", "presence", "cutover"].join("_");

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
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function startMockApi() {
  const state = {
    presenceWrites: [],
    durableEventWrites: [],
    actionWrites: [],
    readCursorWrites: [],
    eventReads: 0,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (
      req.method === "GET" &&
      url.pathname === "/api/v1/sessions/sess-noise/events"
    ) {
      state.eventReads += 1;
      return jsonResponse(res, 200, {
        sessionId: "sess-noise",
        events: [],
        cursor: null,
      });
    }
    if (
      req.method === "PUT" &&
      url.pathname === "/api/v1/sessions/sess-noise/presence"
    ) {
      state.presenceWrites.push(await readJsonBody(req));
      return jsonResponse(res, 200, {
        status: "ok",
        recorded: true,
        ttlSeconds: 90,
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess-noise/events"
    ) {
      state.durableEventWrites.push(await readJsonBody(req));
      return jsonResponse(res, 200, { ok: true });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess-noise/actions"
    ) {
      state.actionWrites.push(await readJsonBody(req));
      return jsonResponse(res, 200, { ok: true });
    }
    if (
      req.method === "PUT" &&
      url.pathname === "/api/v1/sessions/sess-noise/read-cursor"
    ) {
      state.readCursorWrites.push(await readJsonBody(req));
      return jsonResponse(res, 200, {
        ok: true,
        updated: true,
        lastReadSequenceId: 1,
      });
    }
    return jsonResponse(res, 404, { error: "not_found", path: url.pathname });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

function runCli(args, { cwd, apiUrl }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        XDG_CONFIG_HOME: path.join(cwd, ".config"),
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
        SENTINELAYER_SKIP_REMOTE_SYNC: "0",
        SENTINELAYER_TOKEN: TEST_TOKEN,
        SENTINELAYER_API_URL: apiUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Unit session listener cutover: one poll writes presence only, never durable noise", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-listener-noise-cutover-"));
  const mock = await startMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "listen",
        "--session",
        "sess-noise",
        "--agent",
        "codex",
        "--transport",
        "poll",
        "--max-polls",
        "1",
        "--emit",
        "text",
        "--path",
        tmp,
      ],
      { cwd: tmp, apiUrl: mock.apiUrl },
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(mock.state.eventReads, 1);
    assert.ok(mock.state.presenceWrites.length >= 1);
    assert.equal(mock.state.durableEventWrites.length, 0);
    assert.equal(mock.state.actionWrites.length, 0);
    assert.equal(mock.state.readCursorWrites.length, 0);
    assert.ok(
      mock.state.presenceWrites.every((payload) => payload.agentId === "codex"),
    );
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
