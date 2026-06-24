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

test("E2E session listener resilience: transient events API failure recovers on next poll", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-listen-recovery-e2e-"));
  const sessionId = "listen-resilience-e2e";
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === `/api/v1/sessions/${sessionId}/events`) {
        requests.push({
          after: url.searchParams.get("after"),
          limit: url.searchParams.get("limit"),
        });
        if (requests.length === 1) {
          return jsonResponse(res, 503, { error: "temporary outage" });
        }
        return jsonResponse(res, 200, {
          events: [
            {
              stream: "sl_event",
              event: "session_message",
              cursor: "cursor-4",
              ts: "2999-01-01T00:00:00.000Z",
              agent: { id: "claude-e2e" },
              payload: { message: "listener recovered after transient failure", to: "codex-e2e" },
            },
          ],
        });
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
    const result = await runCli({
      cwd: tempRoot,
      env: {
        SENTINELAYER_API_URL: `http://127.0.0.1:${address.port}`,
        SENTINELAYER_TOKEN: "tok_session_listen_recovery_e2e",
      },
      args: [
        "session",
        "listen",
        "--session",
        sessionId,
        "--agent",
        "codex-e2e",
        "--since",
        "cursor-1",
        "--max-polls",
        "2",
        "--interval",
        "1",
        "--transport",
        "poll",
        "--emit",
        "ndjson",
        "--no-presence",
        "--no-coaching",
        "--path",
        tempRoot,
      ],
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.after, "cursor-1");
    assert.equal(requests[1]?.after, "cursor-1");

    const emitted = String(result.stdout || "")
      .trim()
      .split(/\r?\n/g)
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(
      emitted.some(
        (event) => event.event === "session_listen_error" && event.payload?.reason === "api_503",
      ),
      true,
    );
    assert.equal(
      emitted.some(
        (event) =>
          event.event === "session_message" &&
          event.cursor === "cursor-4" &&
          event.payload?.message === "listener recovered after transient failure",
      ),
      true,
    );
  } finally {
    server.close();
    await once(server, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
});
