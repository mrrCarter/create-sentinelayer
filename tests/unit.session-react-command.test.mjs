import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");

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
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function startActionMockApi() {
  const state = {
    eventsProbeCount: 0,
    actionPayload: null,
    actionAuthHeader: "",
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/api/v1/sessions/sess-actions/events?limit=1") {
        state.eventsProbeCount += 1;
        return jsonResponse(res, 200, { sessionId: "sess-actions", events: [], count: 0 });
      }
      if (req.method === "POST" && req.url === "/api/v1/sessions/sess-actions/actions") {
        state.actionAuthHeader = String(req.headers.authorization || "");
        state.actionPayload = await readJsonBody(req);
        return jsonResponse(res, 200, {
          ok: true,
          duplicate: false,
          action: {
            id: "act-ack",
            sessionId: "sess-actions",
            targetSequenceId: 42,
            targetCursor: "",
            actionType: "ack",
            actionKey: "ack",
            actorKind: "agent",
            actorId: "codex",
            actorRole: "coder",
            note: "",
            createdAt: "2026-05-22T02:00:00.000Z",
            metadata: {},
          },
        });
      }
      return jsonResponse(res, 404, { error: "not_found", path: req.url });
    } catch (error) {
      return jsonResponse(res, 500, { error: String(error?.message || error) });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runCli(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
        SENTINELAYER_SKIP_REMOTE_SYNC: "0",
        SENTINELAYER_TOKEN: "api_token_unit_session_action",
        ...env,
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

test("Unit session react command: ack posts a message action and appends local event", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-react-ack-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "react",
        "sess-actions",
        "ack",
        "--target-sequence",
        "42",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session react");
    assert.equal(payload.actionType, "ack");
    assert.equal(payload.action.actionType, "ack");
    assert.equal(payload.localAppend.appended, true);
    assert.equal(payload.event.event, "session_action");
    assert.equal(payload.event.payload.actionType, "ack");

    assert.equal(mock.state.eventsProbeCount, 1);
    assert.equal(mock.state.actionAuthHeader, "Bearer api_token_unit_session_action");
    assert.equal(mock.state.actionPayload.actionType, "ack");
    assert.equal(mock.state.actionPayload.targetSequenceId, 42);
    assert.equal(mock.state.actionPayload.metadata.agentId, "codex");
    assert.equal(mock.state.actionPayload.metadata.source, "cli");

    const stream = JSON.parse(
      await readFile(path.join(tmp, ".sentinelayer", "sessions", "sess-actions", "stream.ndjson"), "utf8")
        .then((raw) => `[${raw.trim().split(/\r?\n/).join(",")}]`),
    );
    assert.equal(stream.length, 1);
    assert.equal(stream[0].event, "session_action");
    assert.equal(stream[0].payload.actionType, "ack");
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
