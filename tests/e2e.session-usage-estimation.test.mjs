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

test("CLI session usage estimation skips human/Senti text and lets real usage win", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-estimation-negative-e2e-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"session-estimation-negative-e2e","version":"1.0.0"}\n', "utf-8");

    const startResult = await runCli({
      cwd: tempRoot,
      args: ["session", "start", "--path", tempRoot, "--no-daemon", "--json"],
    });
    assert.equal(startResult.code, 0, startResult.stderr || startResult.stdout);
    const startPayload = JSON.parse(String(startResult.stdout || "").trim());
    const sessionId = String(startPayload.sessionId || "").trim();
    assert.ok(sessionId);

    const streamPath = path.join(tempRoot, ".sentinelayer", "sessions", sessionId, "stream.ndjson");
    const events = [
      {
        stream: "sl_event",
        event: "session_message",
        agent: { id: "human-mrrcarter", model: "human", role: "human" },
        payload: { message: "This human text must never become billable agent output." },
        sessionId,
        ts: "2026-04-25T10:00:10.000Z",
        timestamp: "2026-04-25T10:00:10.000Z",
        cursor: "negative-estimate-human-cursor",
        sequenceId: 1001,
      },
      {
        stream: "sl_event",
        event: "session_message",
        agent: { id: "senti", model: "senti", role: "orchestrator" },
        payload: { message: "Welcome to this Senti coding room." },
        sessionId,
        ts: "2026-04-25T10:00:20.000Z",
        timestamp: "2026-04-25T10:00:20.000Z",
        cursor: "negative-estimate-senti-cursor",
        sequenceId: 1002,
      },
      {
        stream: "sl_event",
        event: "session_message",
        agent: { id: "claude-warden", model: "claude-sonnet-4.5", role: "participant" },
        payload: {
          message: "This agent response has a nearby provider usage row, so no estimate should be added.",
          clientMessageId: "negative-estimate-agent-message",
        },
        sessionId,
        ts: "2026-04-25T10:00:30.000Z",
        timestamp: "2026-04-25T10:00:30.000Z",
        cursor: "negative-estimate-agent-cursor",
        sequenceId: 1003,
      },
      {
        stream: "sl_event",
        event: "session_usage",
        agent: { id: "claude-warden", model: "claude-sonnet-4.5" },
        payload: {
          schema: "session_usage/local-v1",
          idempotencyKey: "negative-estimate-real-usage",
          agentId: "claude-warden",
          action: "agent_message",
          model: "claude-sonnet-4.5",
          inputTokens: 11,
          outputTokens: 7,
        },
        sessionId,
        ts: "2026-04-25T10:00:30.010Z",
        timestamp: "2026-04-25T10:00:30.010Z",
        cursor: "negative-estimate-usage-cursor",
        sequenceId: 1004,
      },
    ];
    await appendFile(streamPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf-8");

    const transcriptPath = path.join(tempRoot, "session-estimation-negative.md");
    const downloadResult = await runCli({
      cwd: tempRoot,
      args: ["session", "download", sessionId, "--path", tempRoot, "--out", transcriptPath, "--json"],
    });
    assert.equal(downloadResult.code, 0, downloadResult.stderr || downloadResult.stdout);
    const downloadPayload = JSON.parse(String(downloadResult.stdout || "").trim());
    assert.equal(downloadPayload.totals.estimatedEntries, 0);
    assert.equal(downloadPayload.totals.tokenTotal, 18);

    const usageResult = await runCli({
      cwd: tempRoot,
      args: ["session", "usage", sessionId, "--path", tempRoot, "--json"],
    });
    assert.equal(usageResult.code, 0, usageResult.stderr || usageResult.stdout);
    const usagePayload = JSON.parse(String(usageResult.stdout || "").trim());
    assert.equal(usagePayload.totals.estimatedEntries, 0);
    assert.equal(usagePayload.totals.totalTokens, 18);
    assert.equal(usagePayload.recentEntries.length, 1);
    assert.equal(usagePayload.recentEntries[0].estimated, false);
    assert.equal(usagePayload.perAgent.some((agent) => agent.label === "human-mrrcarter" || agent.label === "senti"), false);

    const exportPath = path.join(tempRoot, "session-estimation-negative-export.json");
    const exportResult = await runCli({
      cwd: tempRoot,
      args: ["session", "export", sessionId, "--path", tempRoot, "--out", exportPath],
    });
    assert.equal(exportResult.code, 0, exportResult.stderr || exportResult.stdout);
    const exportPayload = JSON.parse(await readFile(exportPath, "utf-8"));
    assert.equal(exportPayload.totals.estimatedEntries, 0);
    assert.equal(exportPayload.totals.tokenTotal, 18);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
