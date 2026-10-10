import "./setup-env.mjs";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const SID = "e9e8dc5e-8d57-4603-975f-09156e3b4473";
const AID = "d663c132-b961-48d2-bce6-063ae5a18539";

function runCli({ cwd, env, args, timeoutMs = 8_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function admission(status = "pending") {
  return {
    admissionId: AID,
    status,
    agentId: "e2e-reviewer",
    displayName: "E2E Reviewer",
    model: "gpt-5",
    provider: "openai",
    clientKind: "cli",
    keyThumbprint: "a".repeat(64),
    popAssurance: "agent_held_key",
    goal: {
      summary: "Review the E2E release",
      deliverables: ["Finding"],
      stopConditions: [],
      digest: "b".repeat(64),
      untrusted: true,
    },
    requestedScope: { actions: ["session.read"], ttlSeconds: 86400 },
    grantedScope: status === "approved" ? { actions: ["session.read"], ttlSeconds: 86400 } : null,
    email: { status: status === "approved" ? "queued" : "not_requested", address: null, cleanupStatus: "none" },
    purpose: { status: status === "approved" ? "queued" : "not_requested" },
    jev: { verificationStatus: "not_evaluated" },
    createdAt: "2026-10-09T00:00:00Z",
    pendingExpiresAt: "2026-10-09T00:30:00Z",
  };
}

test("E2E session access: agent requests asynchronously and owner lists then approves", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-access-e2e-"));
  const workspace = path.join(root, "workspace");
  const isolatedHome = path.join(root, "home");
  await fsp.mkdir(workspace);
  await fsp.mkdir(isolatedHome);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === `/api/v1/sessions/${SID}/admissions`) {
      res.writeHead(202);
      res.end(JSON.stringify({
        admissionId: AID,
        status: "pending",
        agentId: body.agentId,
        approveUrl: `https://sentinelayer.com/dashboard/sessions/${SID}?admission=${AID}`,
        pollAfterSeconds: 5,
        pendingExpiresAt: "2026-10-09T00:30:00Z",
      }));
      return;
    }
    if (req.method === "POST" && req.url === `/api/v1/sessions/${SID}/admission-mode`) {
      res.end(JSON.stringify({ sessionId: SID, agentAdmissionMode: body.mode }));
      return;
    }
    if (req.method === "GET" && req.url === `/api/v1/sessions/${SID}/admissions?status=pending`) {
      res.end(JSON.stringify({ sessionId: SID, agentAdmissionMode: "required", admissions: [admission()] }));
      return;
    }
    if (req.method === "POST" && req.url === `/api/v1/sessions/${SID}/admissions/${AID}/decision`) {
      res.end(JSON.stringify(admission(body.decision === "approve" ? "approved" : "denied")));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: isolatedHome,
    LOCALAPPDATA: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    SENTINELAYER_DISABLE_KEYRING: "1",
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
    SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}`,
    SENTINELAYER_TOKEN: "e2e-session-access-fixture-token",
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(isolatedHome, ".sentinelayer", "circuits"),
  };
  delete env.NODE_OPTIONS;
  try {
    const mode = await runCli({
      cwd: workspace,
      env,
      args: [
        "session", "access", "mode", SID, "required",
        "--idempotency-key", "mode-66666666-6666-4666-8666-666666666666",
        "--json",
      ],
    });
    assert.equal(mode.code, 0, mode.stderr);
    assert.equal(JSON.parse(mode.stdout).agentAdmissionMode, "required");

    const requested = await runCli({
      cwd: workspace,
      env,
      args: [
        "session", "access", "request", SID,
        "--agent", "e2e-reviewer",
        "--display-name", "E2E Reviewer",
        "--goal", "Review the E2E release",
        "--deliverable", "Finding",
        "--scope", "session.read",
        "--ttl", "24h",
        "--model", "gpt-5",
        "--provider", "openai",
        "--json",
      ],
    });
    assert.equal(requested.timedOut, false);
    assert.equal(requested.code, 0, requested.stderr);
    const requestPayload = JSON.parse(requested.stdout);
    assert.equal(requestPayload.admission.status, "pending");
    assert.equal(requestPayload.readyToJoin, false);

    const listed = await runCli({
      cwd: workspace,
      env,
      args: ["session", "access", "list", SID, "--status", "pending", "--json"],
    });
    assert.equal(listed.code, 0, listed.stderr);
    const listPayload = JSON.parse(listed.stdout);
    assert.equal(listPayload.admissions[0].goal.untrusted, true);
    assert.equal(listPayload.admissions[0].requestedScope.ttlSeconds, 86400);

    const approved = await runCli({
      cwd: workspace,
      env,
      args: [
        "session", "access", "approve", SID, AID,
        "--scope", "session.read",
        "--ttl", "24h",
        "--idempotency-key", "approval-44444444-4444-4444-8444-444444444444",
        "--json",
      ],
    });
    assert.equal(approved.code, 0, approved.stderr);
    const approvalPayload = JSON.parse(approved.stdout);
    assert.equal(approvalPayload.admission.status, "approved");
    assert.equal(approvalPayload.admission.email.status, "queued");

    const requestCall = requests.find((item) => item.method === "POST" && item.url.endsWith("/admissions"));
    assert.equal(requestCall.body.agentId, "e2e-reviewer");
    assert.equal(requestCall.body.publicKey.length, 43);
    assert.equal("privateKey" in requestCall.body, false);
    const modeCall = requests.find((item) => item.url.endsWith("/admission-mode"));
    assert.deepEqual(modeCall.body, { mode: "required" });
    const decisionCall = requests.find((item) => item.url.endsWith(`/${AID}/decision`));
    assert.deepEqual(decisionCall.body, {
      decision: "approve",
      grantedActions: ["session.read"],
      ttlSeconds: 86400,
    });
    assert.equal(decisionCall.headers["idempotency-key"], "approval-44444444-4444-4444-8444-444444444444");
    assert.match(decisionCall.headers["x-csrf-token"], /^[a-f0-9]{64}$/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
});
