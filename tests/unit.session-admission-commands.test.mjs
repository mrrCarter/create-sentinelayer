// Real Commander commands, run as an admitted agent, against a fake API that is
// FAITHFUL to the admission allowlist: an `sladm_` credential is refused (401) on
// every endpoint the real API does not open to it, and once revoked it is refused
// everywhere. The questions this answers are the reviewer's:
//   - after approval, does `sl session say` go out on the admission credential,
//     with no human credential available at all?
//   - after revoke, does the SAME command fail, with nothing retried as the human?
//   - is a stored-but-unusable admission a refusal, never an absence?
//   - does a pending or denied join stop before registering the agent?
//   - is an invitation accepted before admission is requested?

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// ---------------------------------------------------------------- isolation
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-admission-cmd-"));
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
delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC; // we WANT the transport, into the fake
const HUMAN = "human-fixture-token";
process.env.SENTINELAYER_TOKEN = HUMAN;

const { Command } = await import("commander");
const { registerSessionCommand } = await import("../src/commands/session.js");
const { admissionCredentialPath } = await import("../src/session/admission.js");
const { resetSessionSyncStateForTests } = await import("../src/session/sync.js");

const API = "https://api.fixture.invalid";

// The admission allowlist, as the API registers it (method + route template).
const ADMISSION_ALLOWED = [
  ["GET", /\/events$/],
  ["GET", /\/events\/before$/],
  ["GET", /\/presence$/],
  ["PUT", /\/presence$/],
  ["PUT", /\/read-cursor$/],
  ["GET", /\/actions$/],
  ["POST", /\/events$/],
  ["POST", /\/actions$/],
  ["GET", /\/tickets$/],
  ["POST", /\/tickets$/],
  ["PATCH", /\/tickets\/[^/]+$/],
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeApi({ decision = "approved", grantActions = null } = {}) {
  const state = {
    requests: [],
    admissions: new Map(),
    events: [],
    revoked: new Set(),
    order: [],
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const auth = new Headers(init.headers || {}).get("authorization") || "";
    const bearer = auth.replace(/^Bearer\s+/i, "");
    // Recorded BEFORE the origin check, so a request sent anywhere else is visible.
    state.requests.push({ method, origin: u.origin, path: u.pathname, bearer });
    if (u.origin !== API) throw new Error(`request left the fixture API: ${u.origin}`);
    const p = u.pathname;

    if (bearer.startsWith("sladm_")) {
      const adm = [...state.admissions.values()].find((a) => a.token === bearer);
      if (!adm || state.revoked.has(adm.id)) return json({ error: { code: "INVALID_TOKEN" } }, 401);
      const allowed = ADMISSION_ALLOWED.some(([m, re]) => m === method && re.test(p));
      if (!allowed) return json({ error: { code: "INVALID_TOKEN" } }, 401);
      if (method === "POST" && /\/events$/.test(p) && !adm.actions.includes("session.post")) {
        return json({ error: { code: "ADMISSION_SCOPE_DENIED" } }, 403);
      }
    } else if (bearer !== HUMAN) {
      return json({ error: { code: "INVALID_TOKEN" } }, 401);
    }

    // --- admission management (delegator's human token)
    if (method === "POST" && /\/invitations\/accept$/.test(p)) {
      state.order.push("invite");
      return json({ ok: true, result: { accepted: true } });
    }
    if (method === "POST" && /\/admissions$/.test(p)) {
      state.order.push("admission");
      const body = JSON.parse(init.body);
      const id = randomUUID();
      state.admissions.set(id, { id, body, status: "pending", actions: grantActions || body.requestedScope.actions });
      return json({ admissionId: id, status: "pending", approveUrl: `https://web.fixture.invalid/?admission=${id}`, pollAfterSeconds: 2 });
    }
    const one = p.match(/\/admissions\/([^/]+)$/);
    if (method === "GET" && one) {
      const adm = state.admissions.get(one[1]);
      adm.status = adm.status === "pending" ? decision : adm.status;
      const view = { admissionId: adm.id, status: adm.status, pollAfterSeconds: 2 };
      if (adm.status === "approved") {
        adm.nonce = randomBytes(16).toString("base64url");
        view.claim = {
          domain: "sentinelayer.admission.claim.v1",
          fields: ["admissionId", "sessionId", "agentId", "publicKey", "keyThumbprint", "nonce"],
          preimage: { admissionId: adm.id, sessionId: SID, agentId: adm.body.agentId, publicKey: adm.body.publicKey, keyThumbprint: "t".repeat(64), nonce: adm.nonce },
        };
      }
      return json(view);
    }
    const claim = p.match(/\/admissions\/([^/]+)\/claim$/);
    if (method === "POST" && claim) {
      const adm = state.admissions.get(claim[1]);
      adm.status = "active";
      adm.token = `sladm_${randomBytes(24).toString("base64url")}`;
      return json({
        admissionId: adm.id,
        status: "active",
        identity: { subject: `sl-agent:u/${adm.body.agentId}`, passportId: "pid", passportStatus: "issued", keyThumbprint: "t".repeat(64), popAssurance: "agent_held_key", email: { status: "unavailable", address: null }, passport: {} },
        grant: { grantId: "g", sessionId: SID, actions: adm.actions, expiresAt: Math.floor(Date.now() / 1000) + 3600, goalDigest: "d", document: {} },
        correlation: { actorRef: `adm:${adm.id}` },
        jev: { verificationStatus: "not_evaluated" },
        credential: { token: adm.token, deliveredOnce: true },
      });
    }
    // --- the room
    if (method === "GET" && p === `/api/v1/sessions/${SID}`) {
      return json({ session: { sessionId: SID, title: "Fixture room", status: "active", eventCount: state.events.length, agentCount: 0 } });
    }
    if (method === "GET" && /\/events\/before$/.test(p)) {
      return json({ events: state.events.slice(-5) });
    }
    if (method === "GET" && /\/events$/.test(p)) return json({ events: state.events });
    if (method === "POST" && /\/events$/.test(p)) {
      const event = JSON.parse(init.body).event;
      const sequenceId = state.events.length + 1;
      state.events.push({ ...event, sequenceId, cursor: `c${sequenceId}` });
      return json({ ok: true, sequenceId, cursor: `c${sequenceId}` }, 200);
    }
    if (method === "POST" && /\/actions$/.test(p)) return json({ ok: true, action: { actionType: "like" } });
    if (/\/presence$/.test(p) || /\/read-cursor$/.test(p) || /\/actions$/.test(p)) return json({ ok: true, agents: [], actions: [] });
    return json({ error: { code: "NOT_FOUND", path: p } }, 404);
  };
  return state;
}

const SID = "e9e8dc5e-8d57-4603-975f-09156e3b4473";

async function sl(args, { cwd } = {}) {
  resetSessionSyncStateForTests();
  const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} });
  registerSessionCommand(program);
  const out = [];
  const originalLog = console.log;
  const originalExit = process.exitCode;
  console.log = (...parts) => out.push(parts.join(" "));
  let error = null;
  let exitCode;
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    error = err;
  } finally {
    console.log = originalLog;
    exitCode = process.exitCode;
    process.exitCode = originalExit;
  }
  const text = out.join("\n");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { error, exitCode, text, json: parsed, cwd };
}

async function workspace() {
  const dir = await fsp.mkdtemp(path.join(scratch, "ws-"));
  return dir;
}

async function joinAdmitted(agent, { grantActions } = {}) {
  const ws = await workspace();
  const api = fakeApi({ grantActions });
  const joined = await sl(
    ["session", "join", SID, "--agent", agent, "--goal", "Post the fixture update", "--scope", "session.read,session.post,session.react", "--json", "--path", ws],
  );
  assert.equal(joined.error, null, String(joined.error?.stack || joined.error));
  assert.equal(joined.json?.joined, true, joined.text);
  assert.equal(joined.json?.admission?.status, "active");
  return { ws, api };
}

const since = (api, mark) => api.requests.slice(mark);

// ------------------------------------------------------------------- say

test("after approval, `say` goes out on the admission credential with NO human credential at all", async () => {
  const { ws, api } = await joinAdmitted("fixture-agent");
  delete process.env.SENTINELAYER_TOKEN;
  try {
    const mark = api.requests.length;
    const said = await sl(["session", "say", SID, "hello as myself", "--agent", "fixture-agent", "--json", "--path", ws]);
    assert.equal(said.error, null, String(said.error?.stack || said.error));
    assert.equal(said.json.remoteSync.synced, true);
    assert.equal(said.json.remoteConfirmation.confirmed, true);
    const calls = since(api, mark);
    assert.ok(calls.length >= 2, "expected the post and its confirmation reads");
    assert.deepEqual(calls.filter((c) => !c.bearer.startsWith("sladm_")), [], "every request is on the admission");
  } finally {
    process.env.SENTINELAYER_TOKEN = HUMAN;
  }
});

test("after revoke, the SAME `say` fails and nothing is retried as the human", async () => {
  const { ws, api } = await joinAdmitted("revoked-agent");
  for (const adm of api.admissions.values()) api.revoked.add(adm.id);
  const mark = api.requests.length;
  const said = await sl(["session", "say", SID, "still here?", "--agent", "revoked-agent", "--json", "--path", ws]);
  assert.ok(said.error, "the command must fail");
  assert.match(said.error.message, /no longer accepts agent "revoked-agent"'s admission.*did not fall back/s);
  const calls = since(api, mark);
  assert.ok(calls.length >= 1);
  assert.deepEqual(calls.filter((c) => c.bearer === HUMAN), [], "no human-token fallback");
  assert.equal(api.events.some((e) => e.payload?.message === "still here?"), false);
});

test("a read-only grant: the API's 403 on posting is final, never retried as the human", async () => {
  const { ws, api } = await joinAdmitted("reader-agent", { grantActions: ["session.read"] });
  const mark = api.requests.length;
  const said = await sl(["session", "say", SID, "can I post?", "--agent", "reader-agent", "--json", "--path", ws]);
  assert.ok(said.error);
  assert.deepEqual(since(api, mark).filter((c) => c.bearer === HUMAN), []);
});

test("an EXPIRED stored admission is refused before any request, human token present", async () => {
  const { ws, api } = await joinAdmitted("expired-agent");
  const file = admissionCredentialPath(SID, "expired-agent", { homeDir });
  const stored = JSON.parse(await fsp.readFile(file, "utf8"));
  await fsp.writeFile(file, JSON.stringify({ ...stored, expiresAt: Math.floor(Date.now() / 1000) - 5 }));
  const mark = api.requests.length;
  const said = await sl(["session", "say", SID, "late", "--agent", "expired-agent", "--json", "--path", ws]);
  assert.match(String(said.error?.message), /expired.*will not fall back/s);
  assert.deepEqual(since(api, mark), [], "no request at all");
});

test("an agent with NO stored admission keeps the legacy path (human token)", async () => {
  const { ws, api } = await joinAdmitted("admitted-agent");
  const mark = api.requests.length;
  const said = await sl(["session", "say", SID, "legacy hello", "--agent", "legacy-agent", "--json", "--path", ws]);
  assert.equal(said.error, null, String(said.error?.stack || said.error));
  const calls = since(api, mark);
  assert.ok(calls.length >= 1);
  assert.deepEqual(calls.filter((c) => c.bearer.startsWith("sladm_")), [], "another agent's admission is never borrowed");
});

// ------------------------------------------------------- read, react, listen

test("`read` and `react` run on the admission too", async () => {
  const { ws, api } = await joinAdmitted("reactor-agent");
  await sl(["session", "say", SID, "target", "--agent", "reactor-agent", "--json", "--path", ws]);
  const mark = api.requests.length;
  const read = await sl(["session", "read", SID, "--agent", "reactor-agent", "--remote", "--json", "--path", ws]);
  assert.equal(read.error, null, String(read.error?.stack || read.error));
  const reacted = await sl(["session", "react", SID, "like", "--target-sequence", "1", "--agent", "reactor-agent", "--json", "--path", ws]);
  assert.equal(reacted.error, null, String(reacted.error?.stack || reacted.error));
  const calls = since(api, mark);
  assert.ok(calls.length >= 2);
  assert.deepEqual(calls.filter((c) => !c.bearer.startsWith("sladm_")), []);
});

test("`listen --transport stream` is refused for an admitted agent before any request", async () => {
  const { ws, api } = await joinAdmitted("listener-agent");
  const mark = api.requests.length;
  const listened = await sl(["session", "listen", "--session", SID, "--agent", "listener-agent", "--transport", "stream", "--max-polls", "1", "--path", ws]);
  assert.match(String(listened.error?.message), /listens by polling/);
  assert.deepEqual(since(api, mark), []);
});

// ------------------------------------------------------------------- join

test("a DENIED join stops: joined:false, exit 4, and the agent is not registered", async () => {
  const ws = await workspace();
  const api = fakeApi({ decision: "denied" });
  const joined = await sl(["session", "join", SID, "--agent", "denied-agent", "--goal", "Nope", "--json", "--path", ws]);
  assert.equal(joined.error, null, String(joined.error?.stack || joined.error));
  assert.equal(joined.json.joined, false);
  assert.equal(joined.json.admission.status, "denied");
  assert.equal(joined.exitCode, 4);
  assert.equal(api.requests.some((c) => c.path === `/api/v1/sessions/${SID}`), false, "no room verification or materialization");
});

test("a PENDING `--no-wait` join prints the approval URL as JSON and exits 3", async () => {
  const ws = await workspace();
  fakeApi();
  const joined = await sl(["session", "join", SID, "--agent", "waiting-agent", "--goal", "Later", "--no-wait", "--json", "--path", ws]);
  assert.equal(joined.error, null, String(joined.error?.stack || joined.error));
  assert.equal(joined.json.joined, false);
  assert.equal(joined.json.admission.status, "pending");
  assert.match(joined.json.admission.approveUrl, /admission=/);
  assert.equal(joined.exitCode, 3);
});

test("an invitation is accepted BEFORE admission is requested", async () => {
  const ws = await workspace();
  const api = fakeApi();
  await sl(["session", "join", SID, "--invite-token", "synthetic-invite", "--agent", "invited-agent", "--goal", "Help", "--no-wait", "--json", "--path", ws]);
  assert.deepEqual(api.order.slice(0, 2), ["invite", "admission"]);
});

test("an admission credential is only ever sent to the API that issued it", async () => {
  const { ws, api } = await joinAdmitted("bound-agent");
  const file = admissionCredentialPath(SID, "bound-agent", { homeDir });
  const stored = JSON.parse(await fsp.readFile(file, "utf8"));
  await fsp.writeFile(file, JSON.stringify({ ...stored, apiUrl: "https://elsewhere.invalid" }));
  const mark = api.requests.length;
  const said = await sl(["session", "say", SID, "redirect me", "--agent", "bound-agent", "--json", "--path", ws]);
  assert.ok(said.error, "the command must fail");
  assert.deepEqual(since(api, mark).filter((c) => c.bearer.startsWith("sladm_")), [], "never redirected to the default API");
});

test("the auth gate lets an admitted agent command run with no human login, and nothing else", async () => {
  const { checkAuthGate } = await import("../src/auth/gate.js");
  await joinAdmitted("gate-agent");
  delete process.env.SENTINELAYER_TOKEN;
  try {
    const admitted = await checkAuthGate(["session", "say", SID, "hi", "--agent", "gate-agent"]);
    assert.equal(admitted.authenticated, true);
    assert.equal(admitted.bypassReason, "session_admission");
    const listen = await checkAuthGate(["session", "listen", "--session", SID, "--agent", "gate-agent"]);
    assert.equal(listen.authenticated, true);
    const stranger = await checkAuthGate(["session", "say", SID, "hi", "--agent", "not-admitted"]);
    assert.equal(stranger.authenticated, false);
    const notAgentCommand = await checkAuthGate(["session", "archive", SID, "--agent", "gate-agent"]);
    assert.equal(notAgentCommand.authenticated, false);
  } finally {
    process.env.SENTINELAYER_TOKEN = HUMAN;
  }
});
