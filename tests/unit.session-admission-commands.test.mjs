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
  ["GET", /\/admissions\/self$/],
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

    // --- the grant's own receipt: admission credential only, any live grant
    if (method === "GET" && /\/admissions\/self$/.test(p)) {
      const adm = [...state.admissions.values()].find((a) => a.token === bearer);
      if (!adm) return json({ error: { code: "INVALID_TOKEN" } }, 401);
      return json({ admissionId: adm.id, sessionId: SID, agentId: adm.body.agentId, actions: adm.actions, expiresAt: Math.floor(Date.now() / 1000) + 3600, passportId: "pid", effectiveRole: "contributor", verifiedAt: Math.floor(Date.now() / 1000) });
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
  // After the claim, the join itself runs on the admission: readiness and history.
  const claimAt = api.requests.findIndex((c) => /\/claim$/.test(c.path));
  assert.deepEqual(api.requests.slice(claimAt + 1).filter((c) => c.bearer === HUMAN), []);
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
    // Every other subcommand runs on the admission (and the API decides what it may
    // reach); join's control plane is the human's, so it still needs a human login.
    const other = await checkAuthGate(["session", "lock", SID, "src/a.js", "--agent", "gate-agent"]);
    assert.equal(other.authenticated, true);
    // A human command that names no agent still needs the human login, env or not.
    process.env.SENTINELAYER_AGENT_ID = "gate-agent";
    try {
      const human = await checkAuthGate(["session", "archive", SID]);
      assert.equal(human.authenticated, false);
    } finally {
      delete process.env.SENTINELAYER_AGENT_ID;
    }
    const join = await checkAuthGate(["session", "join", SID, "--agent", "gate-agent", "--goal", "x"]);
    assert.equal(join.authenticated, false);
  } finally {
    process.env.SENTINELAYER_TOKEN = HUMAN;
  }
});

// ------------------------------------- through runCli: the single choke point

const { runCli } = await import("../src/cli.js");

async function viaCli(args) {
  resetSessionSyncStateForTests();
  const out = [];
  const originalLog = console.log;
  const originalExit = process.exitCode;
  console.log = (...parts) => out.push(parts.join(" "));
  let error = null;
  let exitCode;
  try {
    await runCli(args);
  } catch (err) {
    error = err;
  } finally {
    console.log = originalLog;
    exitCode = process.exitCode;
    process.exitCode = originalExit;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(out.join("\n"));
  } catch {}
  return { error, exitCode, json: parsed, text: out.join("\n") };
}

async function tombstone(agent, content) {
  await fsp.writeFile(admissionCredentialPath(SID, agent, { homeDir }), content);
}

for (const [label, args] of [
  ["post-agent", (ws, agent) => ["session", "post-agent", SID, "as the agent", "--agent", agent, "--json", "--path", ws]],
  ["observe", (ws, agent) => ["session", "observe", SID, "an observation", "--agent", agent, "--json", "--path", ws]],
]) {
  test(`\`${label}\` with an EXPIRED admission refuses before any request, human token present`, async () => {
    const agent = `${label}-expired`;
    const { ws, api } = await joinAdmitted(agent);
    const file = admissionCredentialPath(SID, agent, { homeDir });
    const stored = JSON.parse(await fsp.readFile(file, "utf8"));
    await fsp.writeFile(file, JSON.stringify({ ...stored, expiresAt: Math.floor(Date.now() / 1000) - 5 }));
    const mark = api.requests.length;
    const ran = await viaCli(args(ws, agent));
    assert.match(String(ran.error?.message), /expired.*will not fall back/s);
    assert.deepEqual(since(api, mark), []);
  });

  test(`\`${label}\` with a LIVE admission goes out on it, never the human`, async () => {
    const agent = `${label}-live`;
    const { ws, api } = await joinAdmitted(agent);
    const mark = api.requests.length;
    await viaCli(args(ws, agent));
    const calls = since(api, mark);
    assert.ok(calls.length >= 1, "the command made requests");
    assert.deepEqual(calls.filter((c) => c.bearer === HUMAN), []);
  });
}

for (const content of ["null", "[]", "42", "\"sladm_x\"", ""]) {
  test(`a credential file containing ${JSON.stringify(content)} is a tombstone, never absence`, async () => {
    const agent = "null-agent";
    const { ws, api } = await joinAdmitted(agent);
    await tombstone(agent, content);
    const mark = api.requests.length;
    const ran = await viaCli(["session", "say", SID, "hello", "--agent", agent, "--json", "--path", ws]);
    assert.match(String(ran.error?.message), /unreadable.*will not fall back/s);
    assert.deepEqual(since(api, mark), []);
  });
}

// ------------------------------------------------------ join readiness (H3)

test("a fresh tickets.read-only join: verified by its own receipt, no history, no human after claim", async () => {
  const ws = await workspace();
  const api = fakeApi({ grantActions: ["tickets.read"] });
  const joined = await sl(["session", "join", SID, "--agent", "tickets-agent", "--goal", "Read the board", "--scope", "tickets.read", "--json", "--path", ws]);
  assert.equal(joined.error, null, String(joined.error?.stack || joined.error));
  assert.equal(joined.json.joined, true);
  assert.equal(joined.json.admission.verified, true);
  assert.deepEqual(joined.json.admission.receipt.actions, ["tickets.read"]);
  assert.equal(joined.json.joinHydration?.skipped, true);
  const claimAt = api.requests.findIndex((c) => /\/claim$/.test(c.path));
  const after = api.requests.slice(claimAt + 1);
  assert.ok(after.some((c) => /\/admissions\/self$/.test(c.path)), "readiness was checked live");
  assert.deepEqual(after.filter((c) => c.bearer === HUMAN), [], "nothing after the claim on the human token");
  assert.equal(after.some((c) => /\/events/.test(c.path)), false, "no history for a tickets-only grant");
});

test("an identical rejoin after revoke is NOT joined, and asks nothing of the human", async () => {
  const ws = await workspace();
  const api = fakeApi();
  const args = ["session", "join", SID, "--agent", "rejoin-agent", "--goal", "Same goal", "--json", "--path", ws];
  const first = await sl(args);
  assert.equal(first.json?.joined, true, first.text);
  for (const adm of api.admissions.values()) api.revoked.add(adm.id);
  const mark = api.requests.length;
  const again = await sl(args);
  assert.equal(again.json.joined, false);
  assert.equal(again.json.admission.status, "not_accepted");
  assert.equal(again.exitCode, 4);
  const calls = since(api, mark);
  assert.ok(calls.some((c) => /\/admissions\/self$/.test(c.path)), "the cached grant was checked live");
  assert.deepEqual(calls.filter((c) => c.bearer === HUMAN), []);
});

// ------------------------------------------- actor vs target (principal metadata)

const { resolveAgentAdmissionTarget, SESSION_AGENT_PRINCIPAL } = await import("../src/session/admission-auth.js");

async function expire(agent) {
  const file = admissionCredentialPath(SID, agent, { homeDir });
  const stored = JSON.parse(await fsp.readFile(file, "utf8"));
  await fsp.writeFile(file, JSON.stringify({ ...stored, expiresAt: Math.floor(Date.now() / 1000) - 5 }));
}

for (const [label, argv] of [
  ["kill", (ws) => ["session", "kill", "--session", SID, "--agent", "target-agent", "--json", "--path", ws]],
  ["stop-listener", (ws) => ["session", "stop-listener", SID, "--agent", "target-agent", "--json", "--path", ws]],
]) {
  test(`\`${label} --agent X\` is a human acting ON X: never scoped to X's (expired) admission`, async () => {
    const { ws, api } = await joinAdmitted("target-agent");
    await expire("target-agent");
    assert.equal(await resolveAgentAdmissionTarget(argv(ws)), null);
    const mark = api.requests.length;
    const ran = await viaCli(argv(ws));
    assert.doesNotMatch(String(ran.error?.message || ""), /will not fall back/, "not refused on the target's credential");
    assert.deepEqual(since(api, mark).filter((c) => c.bearer.startsWith("sladm_")), [], "the human's own authority");
  });
}

test("`lock` with NO --agent resolves the implicit joined identity and refuses its expired admission", async () => {
  const { ws, api } = await joinAdmitted("implicit-agent");
  await expire("implicit-agent");
  const mark = api.requests.length;
  const ran = await viaCli(["session", "lock", SID, "src/a.js", "--json", "--path", ws]);
  assert.match(String(ran.error?.message), /implicit-agent.*expired.*will not fall back/s);
  assert.deepEqual(since(api, mark), []);
});

test("nested `checkpoint create --agent X` is an actor command and refuses X's expired admission", async () => {
  const { ws, api } = await joinAdmitted("checkpoint-agent");
  await expire("checkpoint-agent");
  const mark = api.requests.length;
  const ran = await viaCli(["session", "checkpoint", "create", SID, "--agent", "checkpoint-agent", "--json", "--path", ws]);
  assert.match(String(ran.error?.message), /expired.*will not fall back/s);
  assert.deepEqual(since(api, mark), []);
});

test("boolean flags anywhere do not change the resolved (session, agent)", async () => {
  const { ws } = await joinAdmitted("flags-agent");
  const target = await resolveAgentAdmissionTarget(["session", "say", "--json", SID, "hi", "--agent", "flags-agent", "--path", ws]);
  assert.deepEqual(target, { sessionId: SID, agentId: "flags-agent" });
});

test("an UNCLASSIFIED subcommand with a stored admission fails closed", async () => {
  const { ws } = await joinAdmitted("unclassified-agent");
  assert.equal(SESSION_AGENT_PRINCIPAL["made-up"], undefined);
  await assert.rejects(
    resolveAgentAdmissionTarget(["session", "made-up", SID, "--agent", "unclassified-agent", "--path", ws]),
    /not classified.*Refusing/s
  );
});

// ---------------- the selector can never disagree with execution (Verity 6ae95c3 P1)

const { assertDispatchMatchesScope, withAgentAdmission } = await import("../src/session/admission-auth.js");

for (const [label, argv] of [
  ["repeated --agent", (ws) => ["session", "post-agent", SID, "m", "--agent", "unheld-probe", "--agent", "dup-expired", "--json", "--path", ws]],
  ["--agent then --agent=", (ws) => ["session", "observe", SID, "o", "--agent", "unheld-probe", "--agent=dup-expired", "--json", "--path", ws]],
  ["repeated --path", (ws) => ["session", "say", SID, "m", "--agent", "dup-expired", "--path", ws, "--path", ws]],
  ["repeated --session", (ws) => ["session", "listen", "--session", SID, "--session", SID, "--agent", "dup-expired", "--path", ws]],
]) {
  test(`${label} is refused before any request (Commander would act on the LAST value)`, async () => {
    const { ws, api } = await joinAdmitted("dup-expired");
    await expire("dup-expired");
    const mark = api.requests.length;
    const ran = await viaCli(argv(ws));
    assert.match(String(ran.error?.message), /is given 2 times/);
    assert.deepEqual(since(api, mark), []);
  });
}

test("after the `--` terminator, --agent is message text, not an identity", async () => {
  const { ws, api } = await joinAdmitted("terminator-agent");
  const mark = api.requests.length;
  const ran = await viaCli(["session", "say", SID, "--agent", "terminator-agent", "--json", "--path", ws, "--", "--agent", "someone-else"]);
  assert.equal(ran.error, null, String(ran.error?.stack || ran.error));
  const calls = since(api, mark);
  assert.ok(calls.length >= 1);
  assert.deepEqual(calls.filter((c) => !c.bearer.startsWith("sladm_")), [], "ran as terminator-agent, on its admission");
});

function fakeCommand({ path: names, opts, sources = {}, args = [] }) {
  let parent = { name: () => "sl", parent: null };
  let node = null;
  for (const name of names) {
    node = { name: () => name, parent };
    parent = node;
  }
  node.opts = () => opts;
  node.getOptionValueSource = (key) => sources[key];
  node.processedArgs = args;
  return node;
}

test("the preAction guard refuses when Commander's identity differs from the scope in force", async () => {
  const { ws } = await joinAdmitted("guard-a");
  await joinAdmitted("guard-b");
  const actingAsB = fakeCommand({
    path: ["session", "post-agent"],
    opts: { agent: "guard-b", path: ws },
    sources: { agent: "cli" },
    args: [SID, "m"],
  });
  // Dispatched under guard-a's scope, executing as guard-b: refused.
  await assert.rejects(
    withAgentAdmission(SID, "guard-a", () => assertDispatchMatchesScope(actingAsB)),
    /resolved to .*guard-b but was dispatched under .*guard-a/
  );
  // Dispatched under NO scope, executing as an admitted agent: refused.
  await assert.rejects(assertDispatchMatchesScope(actingAsB), /dispatched under none/);
  // The matching scope passes.
  await withAgentAdmission(SID, "guard-b", () => assertDispatchMatchesScope(actingAsB));
});

test("the guard counts only options given on the command line, not defaults", async () => {
  const { ws } = await joinAdmitted("default-agent");
  // read's --agent defaults to cli-user; with no admission for cli-user and no scope, fine.
  const readWithDefault = fakeCommand({
    path: ["session", "read"],
    opts: { agent: "cli-user", path: ws },
    sources: { agent: "default" },
    args: [SID],
  });
  delete process.env.SENTINELAYER_AGENT_ID;
  // The implicit identity is the sole joined agent, default-agent, which IS admitted:
  // the guard therefore expects its scope and refuses the unscoped dispatch.
  await assert.rejects(assertDispatchMatchesScope(readWithDefault), /resolved to .*default-agent/);
  await withAgentAdmission(SID, "default-agent", () => assertDispatchMatchesScope(readWithDefault));
});

test("a target command (kill) is never compared against an agent scope", async () => {
  const { ws } = await joinAdmitted("kill-target");
  const kill = fakeCommand({
    path: ["session", "kill"],
    opts: { agent: "kill-target", session: SID, path: ws },
    sources: { agent: "cli", session: "cli" },
  });
  await assertDispatchMatchesScope(kill);
});

test("runCli's preAction guard catches argv/Commander divergence: message text naming another room", async () => {
  // The agent holds an admission in OTHER_ROOM only. The message text IS that room's
  // id, so an argv reading scopes to OTHER_ROOM, while Commander posts to SID.
  const OTHER_ROOM = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  const ws = await workspace();
  const api = fakeApi();
  const file = admissionCredentialPath(OTHER_ROOM, "wiring-agent", { homeDir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    JSON.stringify({
      version: 2,
      sessionId: OTHER_ROOM,
      agentId: "wiring-agent",
      apiUrl: API,
      admissionId: "other",
      token: `sladm_${"W".repeat(43)}`,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
  );
  const mark = api.requests.length;
  const ran = await viaCli(["session", "post-agent", SID, OTHER_ROOM, "--agent", "wiring-agent", "--json", "--path", ws]);
  assert.match(String(ran.error?.message), /resolved to none but was dispatched under .*wiring-agent/);
  assert.deepEqual(since(api, mark), [], "refused before the action ran");
});
