import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");
const LOCAL_FIXTURE_TOKEN = "e2e_session_download_fixture_token";

function buildCliEnv({ cwd, env = {}, authenticated = true }) {
  const childEnv = {
    ...process.env,
    SENTINELAYER_SKIP_REMOTE_SYNC: "1",
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
    ...(authenticated ? { SENTINELAYER_TOKEN: LOCAL_FIXTURE_TOKEN } : {}),
    ...env,
    HOME: cwd,
    USERPROFILE: cwd,
    XDG_CONFIG_HOME: path.join(cwd, ".config"),
  };

  delete childEnv.SENTINELAYER_CLI_SKIP_AUTH;
  delete childEnv.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
  delete childEnv.SENTINELAYER_CLI_TEST_BYPASS_SECRET;
  delete childEnv.SENTINELAYER_CLI_TEST_BYPASS_TOKEN;
  if (!authenticated) {
    delete childEnv.SENTINELAYER_TOKEN;
  }
  return childEnv;
}

function runCli({ cwd, args, env = {}, authenticated = true }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: buildCliEnv({ cwd, env, authenticated }),
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

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

test("CLI session download still requires auth when the fixture token is omitted", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-download-auth-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-download-auth-e2e","version":"1.0.0"}\n', "utf-8");
    const transcriptPath = path.join(tempRoot, "must-not-exist.md");
    const result = await runCli({
      cwd: tempRoot,
      args: ["session", "download", "missing-session", "--path", tempRoot, "--out", transcriptPath, "--json"],
      env: { SENTINELAYER_TOKEN: "inherited_token_must_not_authenticate" },
      authenticated: false,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Authentication required/);
    assert.doesNotMatch(result.stderr, /Session 'missing-session' was not found/);
    await assert.rejects(readFile(transcriptPath, "utf-8"), /ENOENT/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI session download renders billing-grade Usage Ledger markdown", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-download-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-download-e2e","version":"1.0.0"}\n', "utf-8");

    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--no-daemon", "--json"],
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

test("CLI session download/export/usage include estimated non-human message usage", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-estimated-usage-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-estimated-usage-e2e","version":"1.0.0"}\n', "utf-8");

    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--no-daemon", "--json"],
    });
    assert.equal(startResult.code, 0, startResult.stderr || startResult.stdout);
    const startPayload = JSON.parse(String(startResult.stdout || "").trim());
    const sessionId = String(startPayload.sessionId || "").trim();
    assert.ok(sessionId);

    const messageEvent = {
      stream: "sl_event",
      event: "session_message",
      agent: { id: "codex-senti-product", model: "gpt-5.4-mini", role: "participant" },
      payload: {
        message: "The hosted Omar gate failed because of managed LLM quota, not a diff finding.",
        clientMessageId: "estimated-usage-e2e-message-1",
      },
      sessionId,
      ts: "2026-04-25T10:00:40.000Z",
      timestamp: "2026-04-25T10:00:40.000Z",
      cursor: "estimated-usage-cursor-1",
      eventId: "estimated-usage-event-1",
      idempotencyToken: "estimated-usage-event-1",
      sequenceId: 1002,
    };
    await appendFile(
      path.join(tempRoot, ".sentinelayer", "sessions", sessionId, "stream.ndjson"),
      `${JSON.stringify(messageEvent)}\n`,
      "utf-8",
    );

    const transcriptPath = path.join(tempRoot, "session-estimated-usage.md");
    const downloadResult = await runCli({
      cwd: tempRoot,
      args: ["session", "download", sessionId, "--path", tempRoot, "--out", transcriptPath, "--json"],
    });
    assert.equal(downloadResult.code, 0, downloadResult.stderr || downloadResult.stdout);
    const downloadPayload = JSON.parse(String(downloadResult.stdout || "").trim());
    assert.equal(downloadPayload.totals.estimatedEntries, 1);
    assert.equal(downloadPayload.totals.tokenTotal > 0, true);

    const transcript = await readFile(transcriptPath, "utf-8");
    assert.match(transcript, /Estimated entries: 1/);
    assert.match(transcript, /not billing-grade provider usage/);
    assert.match(transcript, /`estimated_agent_message \(1 estimated\)`/);

    const usageResult = await runCli({
      cwd: tempRoot,
      args: ["session", "usage", sessionId, "--path", tempRoot, "--json"],
    });
    assert.equal(usageResult.code, 0, usageResult.stderr || usageResult.stdout);
    const usagePayload = JSON.parse(String(usageResult.stdout || "").trim());
    assert.equal(usagePayload.totals.estimatedEntries, 1);
    assert.equal(usagePayload.recentEntries[0].estimated, true);

    const exportPath = path.join(tempRoot, "session-estimated-usage-export.json");
    const exportResult = await runCli({
      cwd: tempRoot,
      args: ["session", "export", sessionId, "--path", tempRoot, "--out", exportPath],
    });
    assert.equal(exportResult.code, 0, exportResult.stderr || exportResult.stdout);
    const exportPayload = JSON.parse(await readFile(exportPath, "utf-8"));
    assert.equal(exportPayload.totals.estimatedEntries, 1);
    assert.equal(exportPayload.totals.tokenTotal, downloadPayload.totals.tokenTotal);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI session usage emits sanitized usage report without raw prompt or secret idempotency material", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-usage-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-usage-e2e","version":"1.0.0"}\n', "utf-8");

    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--no-daemon", "--json"],
    });
    assert.equal(startResult.code, 0, startResult.stderr || startResult.stdout);
    const sessionId = String(JSON.parse(String(startResult.stdout || "").trim()).sessionId || "").trim();
    assert.ok(sessionId);

    const secretIdempotencyKey = "sk-test-usage-command-idempotency-secret";
    const rawPrompt = "SESSION_USAGE_COMMAND_PROMPT_SECRET";
    const rawResponse = "SESSION_USAGE_COMMAND_RESPONSE_SECRET";
    const usageEvent = {
      stream: "sl_event",
      event: "session_usage",
      agent: { id: "codex", model: "gpt-5" },
      payload: {
        schema: "session_usage/local-v1",
        idempotencyKey: secretIdempotencyKey,
        ledgerEntryId: "bill_usage_command_safe",
        agentId: "codex",
        action: "session_recap",
        model: "gpt-5",
        prompt: { text: rawPrompt, tokens: 200 },
        response: { text: rawResponse, tokens: 50 },
        usage: {
          inputTokens: 200,
          outputTokens: 50,
          totalTokens: 250,
          costUsd: 0.012345,
          customerCostUsd: 0.023456,
        },
      },
      sessionId,
      ts: "2026-04-25T10:00:50.000Z",
      timestamp: "2026-04-25T10:00:50.000Z",
      cursor: "usage-command-cursor-1",
      eventId: "usage-command-event-1",
      idempotencyToken: "usage-command-event-1",
      sequenceId: 1100,
    };
    await appendFile(
      path.join(tempRoot, ".sentinelayer", "sessions", sessionId, "stream.ndjson"),
      `${JSON.stringify(usageEvent)}\n`,
      "utf-8",
    );

    const jsonResult = await runCli({
      cwd: tempRoot,
      args: ["session", "usage", sessionId, "--path", tempRoot, "--json"],
    });
    assert.equal(jsonResult.code, 0, jsonResult.stderr || jsonResult.stdout);
    assert.doesNotMatch(jsonResult.stdout, new RegExp(secretIdempotencyKey));
    assert.doesNotMatch(jsonResult.stdout, new RegExp(rawPrompt));
    assert.doesNotMatch(jsonResult.stdout, new RegExp(rawResponse));
    const payload = JSON.parse(String(jsonResult.stdout || "").trim());
    assert.equal(payload.command, "session usage");
    assert.equal(payload.totals.acceptedEntries, 1);
    assert.equal(payload.totals.totalTokens, 250);
    assert.equal(payload.recentEntries[0].ledgerEntryId, "bill_usage_command_safe");
    assert.match(payload.recentEntries[0].idempotencyKeyHash, /^sha256:[0-9a-f]{16}$/);

    const markdownPath = path.join(tempRoot, "usage-report.md");
    const markdownResult = await runCli({
      cwd: tempRoot,
      args: ["session", "usage", sessionId, "--path", tempRoot, "--format", "markdown", "--out", markdownPath],
    });
    assert.equal(markdownResult.code, 0, markdownResult.stderr || markdownResult.stdout);
    const markdown = await readFile(markdownPath, "utf-8");
    assert.match(markdown, /^# Session Usage /m);
    assert.match(markdown, /^Accepted entries: 1$/m);
    assert.match(markdown, /^Tokens: 250 \(input 200 \/ output 50\)$/m);
    assert.doesNotMatch(markdown, new RegExp(secretIdempotencyKey));
    assert.doesNotMatch(markdown, new RegExp(rawPrompt));
    assert.doesNotMatch(markdown, new RegExp(rawResponse));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI session usage --remote renders hosted byAgent/byAction rollups", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-usage-remote-e2e-"));
  const sessionId = "remote-usage-e2e-session";
  const apiToken = "remote-usage-e2e-token";
  const secretIdempotencyKey = "sk-remote-usage-idempotency-secret";
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === `/api/v1/sessions/${sessionId}/usage`) {
        requests.push({
          authorization: req.headers.authorization,
          limit: url.searchParams.get("limit"),
        });
        return jsonResponse(res, 200, {
          sessionId,
          totals: {
            entries: 2,
            inputTokens: 300,
            outputTokens: 125,
            totalTokens: 425,
            providerCostUsd: 0.00425,
            customerCostUsd: 0,
          },
          byAgent: [
            {
              agentId: "omargate-testing",
              count: 1,
              inputTokens: 100,
              outputTokens: 25,
              totalTokens: 125,
              providerCostUsd: 0.00125,
              customerCostUsd: 0,
            },
            {
              agentId: "omargate-backend",
              count: 1,
              inputTokens: 200,
              outputTokens: 100,
              totalTokens: 300,
              providerCostUsd: 0.003,
              customerCostUsd: 0,
            },
          ],
          byAction: [
            {
              action: "omargate_deep",
              count: 2,
              inputTokens: 300,
              outputTokens: 125,
              totalTokens: 425,
              providerCostUsd: 0.00425,
              customerCostUsd: 0,
            },
          ],
          entries: [
            {
              timestamp: "2026-06-30T08:00:00.000Z",
              ledgerEntryId: "bill_remote_e2e",
              idempotencyKey: secretIdempotencyKey,
              schema: "billing/v1",
              agentId: "omargate-backend",
              action: "omargate_deep",
              model: "gpt-5.3-codex",
              priceBookVersion: "2026-05-19",
              inputTokens: 200,
              outputTokens: 100,
              totalTokens: 300,
              providerCostUsd: 0.003,
            },
          ],
        });
      }
      return jsonResponse(res, 404, { error: "not_found" });
    } catch (error) {
      return jsonResponse(res, 500, { error: String(error?.message || error) });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-usage-remote-e2e","version":"1.0.0"}\n', "utf-8");
    const result = await runCli({
      cwd: tempRoot,
      env: {
        SENTINELAYER_API_URL: `http://127.0.0.1:${address.port}`,
        SENTINELAYER_TOKEN: apiToken,
      },
      args: ["session", "usage", sessionId, "--remote", "--json", "--path", tempRoot],
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, `Bearer ${apiToken}`);
    assert.equal(requests[0].limit, "500");
    assert.doesNotMatch(result.stdout, new RegExp(secretIdempotencyKey));
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.source, "remote_usage");
    assert.equal(payload.totals.totalTokens, 425);
    assert.deepEqual(payload.totals.priceBookVersions, ["2026-05-19"]);
    assert.deepEqual(
      payload.perAgent.map((entry) => entry.label),
      ["omargate-backend", "omargate-testing"],
    );
    assert.equal(payload.perAction[0].label, "omargate_deep");
    assert.match(payload.recentEntries[0].idempotencyKeyHash, /^sha256:[0-9a-f]{16}$/);
  } finally {
    server.close();
    await once(server, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI session usage --remote falls back to local sanitized report when hosted usage fails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-usage-fallback-e2e-"));
  const apiToken = "remote-usage-fallback-token";
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      requests.push(url.pathname);
      if (req.method === "GET" && url.pathname.endsWith("/usage")) {
        return jsonResponse(res, 503, { error: "usage_unavailable" });
      }
      return jsonResponse(res, 503, { error: "events_unavailable" });
    } catch (error) {
      return jsonResponse(res, 500, { error: String(error?.message || error) });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-usage-fallback-e2e","version":"1.0.0"}\n', "utf-8");
    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--no-daemon", "--json"],
    });
    assert.equal(startResult.code, 0, startResult.stderr || startResult.stdout);
    const sessionId = String(JSON.parse(String(startResult.stdout || "").trim()).sessionId || "").trim();
    assert.ok(sessionId);

    const secretIdempotencyKey = "sk-fallback-usage-idempotency-secret";
    const usageEvent = {
      stream: "sl_event",
      event: "session_usage",
      agent: { id: "local-agent", model: "gpt-5" },
      payload: {
        schema: "billing/v1",
        idempotencyKey: secretIdempotencyKey,
        ledgerEntryId: "bill_fallback_safe",
        agentId: "local-agent",
        action: "session_usage_fallback",
        model: "gpt-5",
        usage: {
          inputTokens: 40,
          outputTokens: 10,
          totalTokens: 50,
          costUsd: 0.0005,
        },
      },
      sessionId,
      ts: "2026-06-30T08:01:00.000Z",
      timestamp: "2026-06-30T08:01:00.000Z",
      cursor: "fallback-usage-cursor-1",
      eventId: "fallback-usage-event-1",
      idempotencyToken: "fallback-usage-event-1",
      sequenceId: 1200,
    };
    await appendFile(
      path.join(tempRoot, ".sentinelayer", "sessions", sessionId, "stream.ndjson"),
      `${JSON.stringify(usageEvent)}\n`,
      "utf-8",
    );

    const result = await runCli({
      cwd: tempRoot,
      env: {
        SENTINELAYER_API_URL: `http://127.0.0.1:${address.port}`,
        SENTINELAYER_TOKEN: apiToken,
      },
      args: ["session", "usage", sessionId, "--remote", "--json", "--path", tempRoot],
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.ok(requests.some((pathname) => pathname.endsWith("/usage")));
    assert.doesNotMatch(result.stdout, new RegExp(secretIdempotencyKey));
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.source, "local_events");
    assert.equal(payload.remote.usage.ok, false);
    assert.equal(payload.remote.usage.status, 503);
    assert.equal(payload.totals.acceptedEntries, 1);
    assert.equal(payload.totals.totalTokens, 50);
    assert.equal(payload.perAgent[0].label, "local-agent");
    assert.match(payload.recentEntries[0].idempotencyKeyHash, /^sha256:[0-9a-f]{16}$/);
  } finally {
    server.close();
    await once(server, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI session download keeps local markdown usable when remote hydration is unavailable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-download-remote-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-download-remote-e2e","version":"1.0.0"}\n', "utf-8");

    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--no-daemon", "--json"],
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
