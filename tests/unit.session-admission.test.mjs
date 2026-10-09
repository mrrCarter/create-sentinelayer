import "./setup-env.mjs";
// The CLI side of agent admission against a FAITHFUL fake API. The fake verifies
// what the real API verifies: the per-route HMAC CSRF token on every mutation, and
// the Ed25519 claim signature over the canonical preimage with the key stored at
// REQUEST time. A route-id or preimage mismatch fails here, not first in prod.

import assert from "node:assert/strict";
import { createPublicKey, randomBytes, randomUUID, verify as verifyBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAIM_DOMAIN,
  CLAIM_FIELDS,
  admissionCredentialPath,
  agentKeyPath,
  readAdmissionCredentialState,
  loadOrCreateAgentKey,
  parseScope,
  publishKeyFile,
  parseTtlSeconds,
  runAdmissionJoin,
} from "../src/session/admission.js";
import { canonicalPreimage } from "../src/session/admission-preimage.js";
import { createSessionMutationCsrfToken } from "../src/session/invitations.js";

const SID = "e9e8dc5e-8d57-4603-975f-09156e3b4473";
const TOKEN = "unit-test-human-bearer";

function fakeApi({ onPoll } = {}) {
  const admissions = new Map();
  const calls = [];
  const expectCsrf = (headers, routeId, idempotencyKey) => {
    const expected = createSessionMutationCsrfToken({ bearerToken: TOKEN, sessionId: SID, routeId, idempotencyKey });
    assert.equal(headers["X-CSRF-Token"], expected, `bad CSRF for ${routeId}`);
  };
  const requestMutation = async (url, { method, headers, body, idempotencyKey }) => {
    calls.push({ method, url, body });
    assert.equal(method, "POST");
    const base = `https://api.test/api/v1/sessions/${SID}/admissions`;
    if (url === base) {
      expectCsrf(headers, "POST /api/v1/sessions/{session_id}/admissions", idempotencyKey);
      // The API's R1 rule: a live grant for this agent and key is reused only for the
      // SAME purpose; a different goal is a 409, never a silent inheritance.
      const live = [...admissions.values()].find(
        (a) => a.status === "active" && a.body.agentId === body.agentId && a.body.publicKey === body.publicKey
      );
      if (live) {
        if (
          JSON.stringify(live.body.goal) !== JSON.stringify(body.goal) ||
          live.body.requestedScope.ttlSeconds !== body.requestedScope.ttlSeconds
        ) {
          throw new Error("409 ADMISSION_CONFLICT: cancel or revoke it before requesting a different goal, duration, scope or key");
        }
        return { admissionId: live.id, status: "active", reused: true, agentId: body.agentId };
      }
      const id = randomUUID();
      admissions.set(id, { id, status: "pending", body, nonce: null, identityReady: true });
      return { admissionId: id, status: "pending", agentId: body.agentId, approveUrl: `https://web.test/?admission=${id}`, pollAfterSeconds: 5 };
    }
    const claimMatch = url.match(/\/admissions\/([^/]+)\/claim$/);
    if (claimMatch) {
      expectCsrf(headers, "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/claim", idempotencyKey);
      const adm = admissions.get(decodeURIComponent(claimMatch[1]));
      assert.equal(body.nonce, adm.nonce, "claim must present the current nonce");
      const fields = {
        admissionId: adm.id,
        sessionId: SID,
        agentId: adm.body.agentId,
        publicKey: adm.body.publicKey, // the key stored at REQUEST time
        keyThumbprint: "t".repeat(64),
        nonce: adm.nonce,
      };
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: adm.body.publicKey }, format: "jwk" });
      const ok = verifyBytes(null, canonicalPreimage(fields, { domain: CLAIM_DOMAIN, fields: [...CLAIM_FIELDS] }), publicKey, Buffer.from(body.signature, "base64url"));
      if (!ok) throw new Error("claim proof did not verify");
      adm.status = "active";
      return {
        admissionId: adm.id,
        status: "active",
        identity: { subject: `sl-agent:u/${adm.body.agentId}`, passportId: "pid", passportStatus: "issued", keyThumbprint: "t".repeat(64), popAssurance: "agent_held_key", email: { status: "provisioned", address: `${adm.body.agentId}@agents.test` }, passport: { passport_id: "pid" } },
        grant: { grantId: "g", sessionId: SID, actions: adm.body.requestedScope.actions, expiresAt: Math.floor(Date.now() / 1000) + 3600, goalDigest: "d", document: null },
        correlation: { actorRef: `adm:${adm.id}` },
        jev: { verificationStatus: "not_evaluated" },
        credential: { token: `sladm_${"S".repeat(43)}`, deliveredOnce: true },
      };
    }
    throw new Error(`unexpected mutation ${url}`);
  };
  const requestRead = async (url, { headers }) => {
    calls.push({ method: "GET", url });
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    const id = decodeURIComponent(url.split("/").pop());
    const adm = admissions.get(id);
    onPoll?.(adm);
    const view = { admissionId: id, status: adm.status, agentId: adm.body.agentId, pollAfterSeconds: 5 };
    if (adm.status === "approved") {
      view.identityReady = adm.identityReady === true;
      view.identity = {
        email: adm.identityReady
          ? { status: "provisioned", address: `${adm.body.agentId}@agents.test` }
          : { status: "pending", address: null },
        purpose: adm.identityReady
          ? { status: "declared", verification: "verified", receiptId: "receipt-1" }
          : { status: "pending" },
      };
    }
    if (adm.status === "approved" && adm.identityReady === true) {
      adm.nonce = randomBytes(32).toString("base64url"); // rotates on every poll
      view.claim = {
        domain: CLAIM_DOMAIN,
        fields: [...CLAIM_FIELDS],
        preimage: {
          admissionId: id,
          sessionId: SID,
          agentId: adm.body.agentId,
          publicKey: adm.body.publicKey,
          keyThumbprint: "t".repeat(64),
          nonce: adm.nonce,
        },
      };
    }
    return view;
  };
  return { admissions, calls, requestMutation, requestRead };
}

async function scratch() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-admission-"));
  return { homeDir: path.join(dir, "home"), targetPath: path.join(dir, "ws") };
}

function base(api, dirs, extra = {}) {
  return {
    agentId: "builder-1",
    goal: "Implement and test the admission flow.",
    ttlSeconds: 3600,
    ...dirs,
    resolveAuthSession: async () => ({ token: TOKEN, apiUrl: "https://api.test" }),
    requestMutation: api.requestMutation,
    requestRead: api.requestRead,
    sleep: async () => {},
    ...extra,
  };
}

test("full flow: request, wait, approve, claim; credential stored and never output", async () => {
  const dirs = await scratch();
  let polls = 0;
  const api = fakeApi({ onPoll: (adm) => { if (++polls === 2) adm.status = "approved"; } });
  const pending = [];
  const result = await runAdmissionJoin(SID, base(api, dirs, { onPending: (p) => pending.push(p) }));
  assert.equal(result.status, "active");
  assert.equal(pending.length, 1);
  assert.ok(pending[0].approveUrl.includes("admission="));
  assert.equal(JSON.stringify(result).includes("sladm_"), false, "token leaked into output");
  assert.equal(result.credential.redacted, true);
  const { state, credential: stored } = await readAdmissionCredentialState(SID, "builder-1", { homeDir: dirs.homeDir });
  assert.equal(state, "live");
  assert.ok(stored.token.startsWith("sladm_"));
  if (process.platform !== "win32") {
    const mode = fs.statSync(admissionCredentialPath(SID, "builder-1", { homeDir: dirs.homeDir })).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const requestBody = api.calls.find((c) => c.method === "POST" && c.url.endsWith("/admissions")).body;
  assert.equal(requestBody.popAssurance, "agent_held_key");
  assert.equal(requestBody.clientKind, "cli");
  assert.equal("privateKey" in requestBody || JSON.stringify(requestBody).includes("PRIVATE"), false);
});

test("approved admission waits for verified AIdenID identity evidence before claiming", async () => {
  const dirs = await scratch();
  let polls = 0;
  const api = fakeApi({
    onPoll: (adm) => {
      adm.status = "approved";
      polls += 1;
      adm.identityReady = polls >= 2;
    },
  });
  const pending = [];
  const result = await runAdmissionJoin(
    SID,
    base(api, dirs, { onPending: (value) => pending.push(value) }),
  );
  assert.equal(result.status, "active");
  assert.equal(result.identity.email.status, "provisioned");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].phase, "identity");
  assert.equal(pending[0].identityReady, false);
  assert.equal(api.calls.filter((call) => call.method === "GET").length, 2);
  assert.equal(api.calls.filter((call) => call.url.endsWith("/claim")).length, 1);
});

test("identity provisioning timeout is retryable and never attempts claim", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => {
      adm.status = "approved";
      adm.identityReady = false;
    },
  });
  let clock = 0;
  const result = await runAdmissionJoin(
    SID,
    base(api, dirs, {
      waitTimeoutMs: 10_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
  );
  assert.equal(result.status, "approved");
  assert.equal(result.phase, "identity");
  assert.equal(result.identityReady, false);
  assert.equal(result.timedOut, true);
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
  const before = api.calls.length;
  const resumed = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(resumed.status, "approved");
  assert.equal(api.calls.length, before);
});

test("identity-ready response without a claim challenge fails closed", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const requestRead = async (...args) => {
    const view = await api.requestRead(...args);
    delete view.claim;
    return view;
  };
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { requestRead })),
    /Identity-ready admission did not include a valid claim challenge/,
  );
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
});

test("claim challenge exposed before identity readiness fails closed", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const requestRead = async (...args) => {
    const view = await api.requestRead(...args);
    view.identityReady = false;
    return view;
  };
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { requestRead })),
    /claim challenge before AIdenID identity evidence was ready/,
  );
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
});

test("--no-wait returns pending with the approve URL immediately", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  const result = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(result.status, "pending");
  assert.ok(result.approveUrl);
  assert.equal(api.calls.filter((c) => c.method === "GET").length, 0);
});

test("a re-run resumes the same request instead of filing a new one", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1);
});

test("refuses to sign a challenge naming another key", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => {
      adm.status = "approved";
      adm.body = { ...adm.body, publicKey: Buffer.alloc(32, 7).toString("base64url") };
    },
  });
  await assert.rejects(runAdmissionJoin(SID, base(api, dirs)), /does not name this agent's key/);
  assert.equal(api.calls.some((c) => c.url.endsWith("/claim")), false);
});

test("denied ends the flow and clears resumable state", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "denied"; } });
  const result = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(result.status, "denied");
  const again = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.notEqual(again.admissionId, result.admissionId);
});

test("a bounded wait times out as pending and keeps state to resume", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  let clock = 0;
  const result = await runAdmissionJoin(
    SID,
    base(api, dirs, { waitTimeoutMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; } })
  );
  assert.equal(result.status, "pending");
  assert.equal(result.timedOut, true);
  const resumed = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(resumed.admissionId, result.admissionId);
});

test("only the IDENTICAL request is reused locally, with no request at all", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs));
  const before = api.calls.length;
  const reused = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(reused.reused, true);
  assert.equal(api.calls.length, before);
});

test("a narrower scope for the same goal asks the server, which reuses the held grant", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const first = await runAdmissionJoin(SID, base(api, dirs));
  const before = api.calls.filter((c) => c.method === "POST").length;
  const again = await runAdmissionJoin(SID, base(api, dirs, { actions: ["session.read"] }));
  assert.equal(api.calls.filter((c) => c.method === "POST").length, before + 1, "the server must be asked");
  assert.equal(again.reused, true);
  assert.equal(again.admissionId, first.admissionId);
});

test("a changed goal never inherits the approval: the server's conflict surfaces", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs, { goal: "Read source only" }));
  const before = api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { goal: "Delete all project resources", ttlSeconds: 300 })),
    /different goal/
  );
  assert.equal(api.calls.filter((c) => c.method === "POST").length, before + 1, "the server must be asked");
});

test("a changed duration is a question for the server, which refuses to pass the old grant off as it", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs, { ttlSeconds: 3600 }));
  const before = api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(runAdmissionJoin(SID, base(api, dirs, { ttlSeconds: 1800 })), /different goal, duration/);
  assert.equal(api.calls.filter((c) => c.method === "POST").length, before + 1);
});

test("a different request while one is pending is refused, not silently resumed", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { wait: false, goal: "Something else" })),
    /already waiting.*--cancel-admission/s
  );
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1);
});

test("two agents in one workspace keep separate pending requests", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  const one = await runAdmissionJoin(SID, base(api, dirs, { wait: false, agentId: "agent-one" }));
  const two = await runAdmissionJoin(SID, base(api, dirs, { wait: false, agentId: "agent-two" }));
  assert.notEqual(one.admissionId, two.admissionId);
  const oneAgain = await runAdmissionJoin(SID, base(api, dirs, { wait: false, agentId: "agent-one" }));
  assert.equal(oneAgain.admissionId, one.admissionId, "agent-one resumes its own request");
});

test("the agent key is created once and reused", async () => {
  const dirs = await scratch();
  const first = await loadOrCreateAgentKey("builder-1", { homeDir: dirs.homeDir });
  const second = await loadOrCreateAgentKey("builder-1", { homeDir: dirs.homeDir });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(Buffer.from(first.publicKey, "base64url").length, 32);
});

test("scope and TTL parsing refuse out-of-contract input", () => {
  assert.deepEqual(parseScope(""), ["session.read", "session.post"]);
  assert.deepEqual(parseScope("session.read,tickets.work"), ["session.read", "tickets.work"]);
  assert.throws(() => parseScope("session.read,admin"), /Unknown --scope/);
  assert.equal(parseTtlSeconds("2h"), 7200);
  assert.equal(parseTtlSeconds("90m"), 5400);
  assert.throws(() => parseTtlSeconds("1m"), /between 5m and 24h/);
  assert.throws(() => parseTtlSeconds("2w"), /--ttl must look like/);
});

// ------------------------------------------------------------ identity storage

test("concurrent first use in ONE process: every caller gets the persisted key", async () => {
  const dirs = await scratch();
  const settled = await Promise.allSettled(
    Array.from({ length: 24 }, () => loadOrCreateAgentKey("same-agent", { homeDir: dirs.homeDir }))
  );
  const rejected = settled.filter((r) => r.status === "rejected");
  assert.deepEqual(rejected.map((r) => String(r.reason)), []);
  const persisted = await loadOrCreateAgentKey("same-agent", { homeDir: dirs.homeDir });
  assert.equal(persisted.created, false);
  for (const { value } of settled) assert.equal(value.publicKey, persisted.publicKey);
  assert.equal(settled.filter((r) => r.value.created).length, 1, "exactly one caller created it");
});

test("concurrent first use across PROCESSES: every process gets the persisted key", async () => {
  const dirs = await scratch();
  const moduleUrl = new URL("../src/session/admission.js", import.meta.url).href;
  const script =
    `const m = await import(${JSON.stringify(moduleUrl)});` +
    `const k = await m.loadOrCreateAgentKey("same-agent", { homeDir: ${JSON.stringify(dirs.homeDir)} });` +
    `process.stdout.write(k.publicKey);`;
  const { spawn } = await import("node:child_process");
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err}`))));
    });
  const keys = await Promise.all(Array.from({ length: 8 }, run));
  const persisted = await loadOrCreateAgentKey("same-agent", { homeDir: dirs.homeDir });
  assert.deepEqual([...new Set(keys)], [persisted.publicKey]);
});

test("a key file that is not this agent's, or is inconsistent, is refused", async () => {
  const dirs = await scratch();
  const mine = await loadOrCreateAgentKey("agent-a", { homeDir: dirs.homeDir });
  const keyPath = mine.keyPath;
  const record = JSON.parse(await fsp.readFile(keyPath, "utf8"));
  await fsp.writeFile(keyPath, JSON.stringify({ ...record, agentId: "agent-b" }));
  await assert.rejects(loadOrCreateAgentKey("agent-a", { homeDir: dirs.homeDir }), /does not belong/);
  const other = await loadOrCreateAgentKey("agent-c", { homeDir: dirs.homeDir });
  await fsp.writeFile(keyPath, JSON.stringify({ ...record, publicKey: other.publicKey }));
  await assert.rejects(loadOrCreateAgentKey("agent-a", { homeDir: dirs.homeDir }), /inconsistent/);
});

test("storage paths are one identity each: injective, and case-folded", () => {
  const homeDir = path.join(os.tmpdir(), "sl-path-probe");
  assert.notEqual(agentKeyPath("agent:one", { homeDir }), agentKeyPath("agent_one", { homeDir }));
  assert.equal(agentKeyPath("Agent-One", { homeDir }), agentKeyPath("agent-one", { homeDir }));
  assert.notEqual(
    admissionCredentialPath(SID, "agent:one", { homeDir }),
    admissionCredentialPath(SID, "agent_one", { homeDir })
  );
  assert.throws(() => agentKeyPath("../escape", { homeDir }), /not a valid identifier/);
});

async function storeCredential(homeDir, overrides = {}) {
  const filePath = admissionCredentialPath(SID, "builder-1", { homeDir });
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const record = {
    version: 2,
    sessionId: SID,
    agentId: "builder-1",
    apiUrl: "https://api.test",
    admissionId: "a",
    token: `sladm_${"S".repeat(43)}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  await fsp.writeFile(filePath, typeof overrides === "string" ? overrides : JSON.stringify(record));
  return filePath;
}

test("a stored admission is live, absent, or a TOMBSTONE, never quietly absent", async () => {
  const cases = [
    [{}, "live", undefined],
    [{ expiresAt: Math.floor(Date.now() / 1000) - 1 }, "refused", "expired"],
    [{ sessionId: "00000000-0000-0000-0000-000000000000" }, "refused", "bound_to_another_session_or_agent"],
    [{ apiUrl: "" }, "refused", "no_issuing_authority"],
    [{ token: "not-an-admission" }, "refused", "malformed"],
    ["{ not json", "refused", "malformed"],
  ];
  for (const [overrides, state, reason] of cases) {
    const dirs = await scratch();
    await storeCredential(dirs.homeDir, overrides);
    const held = await readAdmissionCredentialState(SID, "builder-1", { homeDir: dirs.homeDir });
    assert.equal(held.state, state, JSON.stringify(overrides));
    assert.equal(held.reason, reason, JSON.stringify(overrides));
  }
  const empty = await scratch();
  assert.equal((await readAdmissionCredentialState(SID, "builder-1", { homeDir: empty.homeDir })).state, "none");
});

test("publishing a key NEVER replaces an existing identity (the property the race depends on)", async () => {
  const dirs = await scratch();
  const keyPath = path.join(dirs.homeDir, "agents", "probe", "identity-ed25519.json");
  await publishKeyFile(keyPath, { agentId: "probe", publicKey: "first" });
  await publishKeyFile(keyPath, { agentId: "probe", publicKey: "second" });
  assert.equal(JSON.parse(await fsp.readFile(keyPath, "utf8")).publicKey, "first");
  const leftovers = (await fsp.readdir(path.dirname(keyPath))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp files left behind");
});
