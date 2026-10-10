import "./setup-env.mjs";

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-session-access-"));
const homeDir = path.join(scratch, "home");
await fsp.mkdir(homeDir, { recursive: true });
for (const name of ["HOME", "USERPROFILE"]) process.env[name] = homeDir;
process.env.APPDATA = path.join(homeDir, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(homeDir, "AppData", "Local");
process.env.SENTINELAYER_DISABLE_KEYRING = "1";
process.env.SENTINELAYER_SKIP_SENTI_AUTOSTART = "1";
process.env.SENTINELAYER_API_URL = "https://api.fixture.invalid";
process.env.SENTINELAYER_API_ALLOWED_HOSTS = "api.fixture.invalid";
process.env.SENTINELAYER_CIRCUIT_STATE_DIR = path.join(scratch, "circuits");
process.env.SENTINELAYER_TOKEN = "human-fixture-token";

const { Command } = await import("commander");
const { registerSessionCommand } = await import("../src/commands/session.js");
const {
  decideSessionAdmission,
  listSessionAdmissions,
  revokeSessionAdmission,
  setSessionAdmissionMode,
} = await import("../src/session/admission-access.js");
const { resolveAgentAdmissionTarget } = await import("../src/session/admission-auth.js");

const API = "https://api.fixture.invalid";
const SID = "e9e8dc5e-8d57-4603-975f-09156e3b4473";
const AID = "d663c132-b961-48d2-bce6-063ae5a18539";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function fixtureAdmission(overrides = {}) {
  return {
    admissionId: AID,
    status: "pending",
    agentId: "review-agent",
    displayName: "Review Agent",
    model: "gpt-5",
    provider: "openai",
    clientKind: "cli",
    keyThumbprint: "a".repeat(64),
    popAssurance: "agent_held_key",
    goal: {
      summary: "Review the release",
      deliverables: ["A signed finding"],
      stopConditions: ["Review is accepted"],
      digest: "b".repeat(64),
      untrusted: true,
    },
    requestedScope: {
      actions: ["session.read", "session.post"],
      ttlSeconds: 86400,
    },
    grantedScope: null,
    email: { status: "not_requested", address: null, cleanupStatus: "none" },
    purpose: { status: "not_requested" },
    jev: { verificationStatus: "not_evaluated" },
    createdAt: "2026-10-09T00:00:00Z",
    pendingExpiresAt: "2026-10-09T00:30:00Z",
    ...overrides,
  };
}

function fakeApi({
  goalSummary = "Review the release",
  approveUrl = `https://sentinelayer.com/dashboard/sessions/${SID}?admission=${AID}`,
} = {}) {
  const state = { requests: [] };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    state.requests.push({ method, url: parsed.toString(), path: parsed.pathname, search: parsed.search, headers, body });
    assert.equal(parsed.origin, API);
    assert.equal(headers.authorization, "Bearer human-fixture-token");

    if (method === "POST" && parsed.pathname.endsWith("/admissions")) {
      return json({
        admissionId: AID,
        status: "pending",
        agentId: body.agentId,
        approveUrl,
        pollAfterSeconds: 5,
        pendingExpiresAt: "2026-10-09T00:30:00Z",
      }, 202);
    }
    if (method === "GET" && parsed.pathname.endsWith("/admissions")) {
      return json({
        sessionId: SID,
        agentAdmissionMode: "required",
        admissions: [fixtureAdmission({ goal: { ...fixtureAdmission().goal, summary: goalSummary } })],
      });
    }
    if (method === "GET" && parsed.pathname.endsWith(`/admissions/${AID}`)) {
      return json({
        admissionId: AID,
        status: "pending",
        agentId: "review-agent",
        approveUrl,
        pollAfterSeconds: 5,
      });
    }
    if (method === "POST" && parsed.pathname.endsWith(`/admissions/${AID}/decision`)) {
      const approved = body.decision === "approve";
      return json(fixtureAdmission({
        status: approved ? "approved" : "denied",
        grantedScope: approved
          ? { actions: body.grantedActions || ["session.read", "session.post"], ttlSeconds: body.ttlSeconds || 86400 }
          : null,
        email: approved
          ? { status: "queued", address: null, cleanupStatus: "none" }
          : { status: "not_requested", address: null, cleanupStatus: "none" },
      }));
    }
    if (method === "POST" && parsed.pathname.endsWith(`/admissions/${AID}/revoke`)) {
      return json(fixtureAdmission({ status: "revoked" }));
    }
    if (method === "POST" && parsed.pathname.endsWith("/admission-mode")) {
      return json({ sessionId: SID, agentAdmissionMode: body.mode });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  };
  return state;
}

async function sl(args) {
  const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  registerSessionCommand(program);
  const output = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  console.log = (...parts) => output.push(parts.join(" "));
  let error = null;
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (caught) {
    error = caught;
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
  const text = output.join("\n");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { error, text, json: parsed };
}

function mutationCall(state, suffix) {
  return state.requests.find((request) => request.method === "POST" && request.path.endsWith(suffix));
}

test("access request uses the hardened admission request path and returns pending without joining", async () => {
  const state = fakeApi();
  const workspace = await fsp.mkdtemp(path.join(scratch, "request-workspace-"));
  const result = await sl([
    "session", "access", "request", SID,
    "--agent", "review-agent",
    "--goal", "Review the release",
    "--deliverable", "A signed finding",
    "--stop-when", "Review is accepted",
    "--scope", "session.read,session.post",
    "--ttl", "24h",
    "--model", "gpt-5",
    "--provider", "openai",
    "--path", workspace,
    "--json",
  ]);
  assert.equal(result.error, null, String(result.error?.stack || result.error));
  assert.equal(result.json.command, "session access request");
  assert.equal(result.json.admission.status, "pending");
  assert.equal(result.json.readyToJoin, false);
  const request = mutationCall(state, "/admissions");
  assert.equal(request.body.agentId, "review-agent");
  assert.equal(request.body.goal.summary, "Review the release");
  assert.deepEqual(request.body.requestedScope, {
    actions: ["session.read", "session.post"],
    ttlSeconds: 86400,
  });
  assert.equal(request.body.publicKey.length, 43);
  assert.equal("privateKey" in request.body, false);
  assert.match(request.headers["idempotency-key"], /^sl-cli-session-admission-request-/);
  assert.equal(request.headers["x-sentinelayer-session-mutation"], "session-mutation");
  assert.equal(request.headers.origin, "https://sentinelayer.com");
  assert.match(request.headers["x-csrf-token"], /^[a-f0-9]{64}$/);
  assert.equal(state.requests.some((item) => !item.path.endsWith("/admissions")), false);
});

test("waiting access request neutralizes controls and emits no ANSI around a remote approval URL", async () => {
  const workspace = await fsp.mkdtemp(path.join(scratch, "request-wait-workspace-"));
  fakeApi({
    approveUrl: "https://sentinelayer.com/approve\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u202Etxt.exe",
  });
  const result = await sl([
    "session", "access", "request", SID,
    "--agent", "waiting-review-agent",
    "--goal", "Review later",
    "--wait",
    "--wait-seconds", "0",
    "--path", workspace,
  ]);
  assert.equal(result.error, null, String(result.error?.stack || result.error));
  assert.equal(result.text.includes("\u001b"), false);
  assert.equal(result.text.includes("\u0007"), false);
  assert.equal(result.text.includes("\u202E"), false);
  assert.match(result.text, /Waiting for a room owner/);
  assert.match(result.text, /Access requested/);
});

test("access mode enables the room's fail-closed required-admission policy", async () => {
  const state = fakeApi();
  const result = await sl([
    "session", "access", "mode", SID, "required",
    "--idempotency-key", "mode-55555555-5555-4555-8555-555555555555",
    "--json",
  ]);
  assert.equal(result.error, null, String(result.error?.stack || result.error));
  assert.equal(result.json.agentAdmissionMode, "required");
  const request = mutationCall(state, "/admission-mode");
  assert.deepEqual(request.body, { mode: "required" });
  assert.equal(request.headers["idempotency-key"], "mode-55555555-5555-4555-8555-555555555555");
  assert.match(request.headers["x-csrf-token"], /^[a-f0-9]{64}$/);
});

test("human mode output neutralizes controls in the remote mode value", async () => {
  fakeApi();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const response = await originalFetch(url, init);
    if (!String(url).endsWith("/admission-mode")) return response;
    const payload = await response.json();
    payload.agentAdmissionMode = "required\u001b]8;;https://evil.example\u0007link\u202E";
    return json(payload, response.status);
  };
  const changed = await sl(["session", "access", "mode", SID, "required"]);
  assert.equal(changed.error, null, String(changed.error?.stack || changed.error));
  assert.equal(changed.text.includes("\u001b"), false);
  assert.equal(changed.text.includes("\u0007"), false);
  assert.equal(changed.text.includes("\u202E"), false);
  assert.equal(changed.text.includes("Agent admission mode"), true);
  assert.equal(changed.text.length < 160, true);
});

test("access list and status expose server state without mutating it", async () => {
  const state = fakeApi();
  const listed = await sl(["session", "access", "list", SID, "--status", "pending", "--json"]);
  assert.equal(listed.error, null, String(listed.error?.stack || listed.error));
  assert.equal(listed.json.agentAdmissionMode, "required");
  assert.equal(listed.json.admissions[0].goal.untrusted, true);
  const listRequest = state.requests.at(-1);
  assert.equal(listRequest.method, "GET");
  assert.equal(listRequest.search, "?status=pending");

  const status = await sl(["session", "access", "status", SID, AID, "--json"]);
  assert.equal(status.error, null, String(status.error?.stack || status.error));
  assert.equal(status.json.status, "pending");
  assert.equal(state.requests.at(-1).method, "GET");
});

test("human list output bounds and neutralizes control characters in the untrusted goal claim", async () => {
  fakeApi({ goalSummary: `first line\nsecond line\u001b[31m${"x".repeat(400)}` });
  const listed = await sl(["session", "access", "list", SID]);
  assert.equal(listed.error, null, String(listed.error?.stack || listed.error));
  const claimedLine = listed.text.split("\n").find((line) => line.includes("claimed goal"));
  assert.ok(claimedLine);
  // picocolors may wrap the trusted label on a TTY/CI runner. The attacker-
  // supplied red escape must still be absent, and the visible text bounded.
  assert.equal(claimedLine.includes("\u001b[31m"), false);
  const visibleClaimedLine = claimedLine.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  assert.equal(visibleClaimedLine.includes("second line"), true);
  assert.equal(visibleClaimedLine.includes("\u001b"), false);
  assert.ok(visibleClaimedLine.length < 300, `untrusted line was not bounded (${visibleClaimedLine.length})`);
});

test("human list output neutralizes ANSI, OSC, and bidi controls in remote identity fields", async () => {
  const state = fakeApi();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const response = await originalFetch(url, init);
    if (String(init.method || "GET").toUpperCase() !== "GET" || !String(url).includes("/admissions")) {
      return response;
    }
    const payload = await response.json();
    if (!Array.isArray(payload.admissions)) return json(payload, response.status);
    payload.admissions[0].displayName = "safe\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u202Etxt.exe";
    return json(payload, response.status);
  };
  const listed = await sl(["session", "access", "list", SID]);
  assert.equal(listed.error, null, String(listed.error?.stack || listed.error));
  const identityLine = listed.text.split("\n").find((line) => line.includes(AID));
  assert.ok(identityLine);
  assert.equal(identityLine.includes("\u001b"), false);
  assert.equal(identityLine.includes("\u0007"), false);
  assert.equal(identityLine.includes("\u202E"), false);
  assert.equal(identityLine.includes("https://evil.example"), true);
  assert.equal(state.requests.length > 0, true);
});

test("access approve sends the exact approve literal, narrowed grant, and guarded mutation headers", async () => {
  const state = fakeApi();
  const result = await sl([
    "session", "access", "approve", SID, AID,
    "--scope", "session.read",
    "--ttl", "1h",
    "--note", "Read-only review first",
    "--idempotency-key", "approval-11111111-1111-4111-8111-111111111111",
    "--json",
  ]);
  assert.equal(result.error, null, String(result.error?.stack || result.error));
  assert.equal(result.json.admission.status, "approved");
  assert.equal(result.json.admission.email.status, "queued");
  const request = mutationCall(state, `/admissions/${AID}/decision`);
  assert.deepEqual(request.body, {
    decision: "approve",
    grantedActions: ["session.read"],
    ttlSeconds: 3600,
    note: "Read-only review first",
  });
  assert.equal(request.headers["idempotency-key"], "approval-11111111-1111-4111-8111-111111111111");
  assert.equal(request.headers["x-sentinelayer-session-mutation"], "session-mutation");
  assert.match(request.headers["x-csrf-token"], /^[a-f0-9]{64}$/);
});

test("access deny sends deny with no grant fields", async () => {
  const state = fakeApi();
  const result = await sl([
    "session", "access", "deny", SID, AID,
    "--note", "Goal is broader than this room",
    "--idempotency-key", "denial-22222222-2222-4222-8222-222222222222",
    "--json",
  ]);
  assert.equal(result.error, null, String(result.error?.stack || result.error));
  assert.equal(result.json.admission.status, "denied");
  const request = mutationCall(state, `/admissions/${AID}/decision`);
  assert.deepEqual(request.body, { decision: "deny", note: "Goal is broader than this room" });
});

test("access revoke sends a bounded reason through the guarded owner route", async () => {
  const state = fakeApi();
  const result = await sl([
    "session", "access", "revoke", SID, AID,
    "--reason", "Review complete",
    "--idempotency-key", "revoke-33333333-3333-4333-8333-333333333333",
    "--json",
  ]);
  assert.equal(result.error, null, String(result.error?.stack || result.error));
  assert.equal(result.json.admission.status, "revoked");
  const request = mutationCall(state, `/admissions/${AID}/revoke`);
  assert.deepEqual(request.body, { reason: "Review complete" });
  assert.equal(request.headers["idempotency-key"], "revoke-33333333-3333-4333-8333-333333333333");
});

test("access owner controls are human control-plane commands, never dispatched on an agent admission", async () => {
  for (const args of [
    ["session", "access", "mode", SID, "required"],
    ["session", "access", "request", SID, "--agent", "review-agent"],
    ["session", "access", "list", SID],
    ["session", "access", "status", SID, AID],
    ["session", "access", "approve", SID, AID],
    ["session", "access", "deny", SID, AID],
    ["session", "access", "revoke", SID, AID],
  ]) {
    assert.equal(await resolveAgentAdmissionTarget(args), null);
  }
});

test("access validation fails before auth or network I/O", async () => {
  let authCalls = 0;
  let requestCalls = 0;
  const resolveAuthSession = async () => {
    authCalls += 1;
    return { token: "unused", apiUrl: API };
  };
  const requestRead = async () => {
    requestCalls += 1;
    return {};
  };
  await assert.rejects(
    setSessionAdmissionMode(SID, "wide-open", { resolveAuthSession, requestMutation: requestRead }),
    /mode must be legacy or required/,
  );
  await assert.rejects(
    listSessionAdmissions(SID, { status: "surprise", resolveAuthSession, requestRead }),
    /--status must be one of/,
  );
  await assert.rejects(
    decideSessionAdmission(SID, AID, {
      decision: "deny",
      grantedActions: ["session.read"],
      resolveAuthSession,
      requestMutation: requestRead,
    }),
    /denied admission cannot include --scope or --ttl/i,
  );
  await assert.rejects(
    revokeSessionAdmission(SID, AID, {
      idempotencyKey: "x".repeat(129),
      resolveAuthSession,
      requestMutation: requestRead,
    }),
    /at most 128 characters/,
  );
  assert.equal(requestCalls, 0);
  assert.equal(authCalls, 0);
});

test.after(async () => {
  await fsp.rm(scratch, { recursive: true, force: true });
});
