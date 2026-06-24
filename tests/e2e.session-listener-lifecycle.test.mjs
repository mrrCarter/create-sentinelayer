import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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

async function runCli({ cwd, env, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_TEST_BYPASS_NONCE: "e2e-bypass-nonce",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_TOKEN: "api_token_e2e_test_session",
        ...(env || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}

async function withMockSessionEvents(events, callback) {
  const sessionId = "listen-lifecycle-e2e";
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === `/api/v1/sessions/${sessionId}/events`) {
        requests.push({
          after: url.searchParams.get("after"),
          limit: url.searchParams.get("limit"),
          authorization: String(req.headers.authorization || ""),
        });
        if (typeof events === "function") {
          const response = events({ requestCount: requests.length, url });
          return jsonResponse(res, response?.status || 200, response?.body || { events: response?.events || [] });
        }
        return jsonResponse(res, 200, { events });
      }
      return jsonResponse(res, 404, {});
    } catch (error) {
      return jsonResponse(res, 500, { error: String(error?.message || error) });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    return await callback({
      apiUrl: `http://127.0.0.1:${address.port}`,
      sessionId,
      requests,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
}

function baseListenArgs(sessionId, tempRoot, extra = []) {
  return [
    "session",
    "listen",
    "--session",
    sessionId,
    "--agent",
    "codex-e2e",
    "--since",
    "cursor-1",
    "--max-polls",
    "1",
    "--interval",
    "1",
    "--transport",
    "poll",
    "--no-presence",
    "--no-coaching",
    "--path",
    tempRoot,
    ...extra,
  ];
}

test("E2E session listener lifecycle: stale stop does not abort a restarted listener", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listen-stale-stop-e2e-"));
  try {
    await withMockSessionEvents(
      [
        {
          event: "listener_stop",
          cursor: "cursor-2",
          ts: "2000-01-01T00:00:00.000Z",
          agent: { id: "session-control" },
          payload: { targetAgentId: "codex-e2e", reason: "old_operator_stop" },
        },
        {
          stream: "sl_event",
          event: "session_message",
          cursor: "cursor-3",
          ts: "2999-01-01T00:00:00.000Z",
          agent: { id: "claude-e2e" },
          payload: { message: "listener survived stale stop", to: "codex-e2e" },
        },
      ],
      async ({ apiUrl, sessionId, requests }) => {
        const result = await runCli({
          cwd: tempRoot,
          env: {
            SENTINELAYER_API_URL: apiUrl,
            SENTINELAYER_TOKEN: "tok_session_listen_lifecycle_e2e",
          },
          args: baseListenArgs(sessionId, tempRoot, ["--emit", "ndjson"]),
        });

        assert.equal(result.code, 0, result.stderr || result.stdout);
        assert.equal(requests[0]?.after, "cursor-1");
        assert.equal(requests[0]?.limit, "200");
        assert.match(requests[0]?.authorization || "", /^Bearer /);

        const emitted = String(result.stdout || "")
          .trim()
          .split(/\r?\n/g)
          .filter(Boolean)
          .map((line) => JSON.parse(line));

        assert.equal(emitted.some((event) => event.event === "listener_stop"), false);
        assert.equal(
          emitted.some(
            (event) =>
              event.event === "session_message" &&
              event.cursor === "cursor-3" &&
              event.payload?.message === "listener survived stale stop",
          ),
          true,
        );
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("E2E session listener lifecycle: fresh stop still terminates rapid restart boundary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listen-fresh-stop-e2e-"));
  try {
    await withMockSessionEvents(
      [
        {
          event: "listener_stop",
          cursor: "cursor-2",
          ts: "2999-01-01T00:00:00.000Z",
          agent: { id: "session-control" },
          payload: { targetAgentId: "codex-e2e", reason: "operator_stop" },
        },
      ],
      async ({ apiUrl, sessionId, requests }) => {
        const result = await runCli({
          cwd: tempRoot,
          env: {
            SENTINELAYER_API_URL: apiUrl,
            SENTINELAYER_TOKEN: "tok_session_listen_fresh_stop_e2e",
          },
          args: baseListenArgs(sessionId, tempRoot, ["--emit", "text"]),
        });

        assert.equal(result.code, 0, result.stderr || result.stdout);
        assert.equal(requests[0]?.after, "cursor-1");
        assert.match(result.stdout, /Listener stop requested for codex-e2e; exiting\./);
        assert.doesNotMatch(result.stdout, /listener survived stale stop/);
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
