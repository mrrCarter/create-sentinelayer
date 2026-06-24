import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");

function runCli({ cwd, args, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI session download renders billing-grade Usage Ledger markdown", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-download-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-download-e2e","version":"1.0.0"}\n', "utf-8");

    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--json"],
    });
    assert.equal(startResult.code, 0, startResult.stderr || startResult.stdout);
    const startPayload = JSON.parse(String(startResult.stdout || "").trim());
    const sessionId = String(startPayload.sessionId || "").trim();
    assert.ok(sessionId);

    const usageEvent = {
      stream: "sl_event",
      event: "session_usage",
      agent: { id: "agent-alpha", model: "gpt-5.3-codex" },
      payload: {
        schema: "billing/v1",
        idempotencyKey: "e2e-download-ledger-key",
        agentId: "agent-alpha",
        action: "session_download_e2e",
        model: "gpt-5.3-codex",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          cost_usd: 0.001234,
          customer_cost_usd: 0.002345,
        },
      },
      sessionId,
      ts: "2026-04-25T10:00:40.000Z",
      timestamp: "2026-04-25T10:00:40.000Z",
      cursor: "usage-cursor-1",
      eventId: "usage-event-1",
      idempotencyToken: "usage-event-1",
      sequenceId: 1002,
    };
    await appendFile(
      path.join(tempRoot, ".sentinelayer", "sessions", sessionId, "stream.ndjson"),
      `${JSON.stringify(usageEvent)}\n`,
      "utf-8",
    );

    const transcriptPath = path.join(tempRoot, "session-download-ledger.md");
    const downloadResult = await runCli({
      cwd: tempRoot,
      args: ["session", "download", sessionId, "--path", tempRoot, "--out", transcriptPath, "--json"],
    });
    assert.equal(downloadResult.code, 0, downloadResult.stderr || downloadResult.stdout);
    const downloadPayload = JSON.parse(String(downloadResult.stdout || "").trim());
    assert.equal(downloadPayload.command, "session download");

    const transcript = await readFile(transcriptPath, "utf-8");
    assert.match(transcript, /^## Usage Ledger$/m);
    assert.match(transcript, /^Accepted entries: 1$/m);
    assert.match(transcript, /^Tokens: 150 \(input 120 \/ output 30\)$/m);
    assert.match(transcript, /^Provider cost: \$0\.001234 · Customer cost: \$0\.002345$/m);
    assert.match(transcript, /\| `agent-alpha` \| 1 \| 120 \| 30 \| 150 \| \$0\.001234 \| \$0\.002345 \| 0 \|/);
    assert.match(transcript, /\| `session_download_e2e` \| 1 \| 120 \| 30 \| 150 \| \$0\.001234 \| \$0\.002345 \| 0 \|/);
    assert.match(transcript, /\| 2026-04-25 10:00:40 UTC \| `agent-alpha` \| `session_download_e2e` \| `gpt-5\.3-codex` \| 150 \| \$0\.001234 \| \$0\.002345 \| `e2e-download-ledger-key` \|/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI session download keeps local markdown usable when remote hydration is unavailable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-download-remote-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-download-remote-e2e","version":"1.0.0"}\n', "utf-8");

    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--json"],
    });
    assert.equal(startResult.code, 0, startResult.stderr || startResult.stdout);
    const sessionId = String(JSON.parse(String(startResult.stdout || "").trim()).sessionId || "").trim();
    assert.ok(sessionId);

    const messageEvent = {
      stream: "sl_event",
      event: "session_message",
      agent: { id: "human-mrrcarter", model: "human" },
      payload: { message: "local cached message survives remote outage" },
      sessionId,
      ts: "2026-04-25T10:00:10.000Z",
      timestamp: "2026-04-25T10:00:10.000Z",
      cursor: "message-cursor-1",
      eventId: "message-event-1",
      sequenceId: 1001,
    };
    await appendFile(
      path.join(tempRoot, ".sentinelayer", "sessions", sessionId, "stream.ndjson"),
      `${JSON.stringify(messageEvent)}\n`,
      "utf-8",
    );

    const transcriptPath = path.join(tempRoot, "session-download-remote-fallback.md");
    const downloadResult = await runCli({
      cwd: tempRoot,
      args: ["session", "download", sessionId, "--path", tempRoot, "--remote", "--out", transcriptPath, "--json"],
      env: {
        SENTINELAYER_API_URL: "http://127.0.0.1:9",
        SENTINELAYER_TOKEN: "tok_session_download_remote_failure_e2e",
        SENTINELAYER_SKIP_REMOTE_SYNC: "",
      },
    });
    assert.equal(downloadResult.code, 0, downloadResult.stderr || downloadResult.stdout);
    const payload = JSON.parse(String(downloadResult.stdout || "").trim());
    assert.equal(payload.command, "session download");
    assert.equal(payload.remote.hydration.ok, false);
    assert.match(payload.remote.hydration.reason, /fetch|ECONNREFUSED|failed/i);
    assert.equal(payload.eventCount >= 1, true);

    const transcript = await readFile(transcriptPath, "utf-8");
    assert.match(transcript, /^## Usage Ledger$/m);
    assert.match(transcript, /^_No usage telemetry recorded\._$/m);
    assert.match(transcript, /local cached message survives remote outage/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI session download fails closed for a missing local session without writing markdown", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-download-missing-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-download-missing-e2e","version":"1.0.0"}\n', "utf-8");
    const transcriptPath = path.join(tempRoot, "missing-session.md");
    const result = await runCli({
      cwd: tempRoot,
      args: ["session", "download", "missing-session", "--path", tempRoot, "--out", transcriptPath, "--json"],
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Session 'missing-session' was not found/);
    await assert.rejects(readFile(transcriptPath, "utf-8"), /ENOENT/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
