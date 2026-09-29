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
  loadAdmissionCredential,
  loadOrCreateAgentKey,
  parseScope,
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
      const id = randomUUID();
      admissions.set(id, { id, status: "pending", body, nonce: null });
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
        identity: { subject: `sl-agent:u/${adm.body.agentId}`, passportId: "pid", passportStatus: "issued", keyThumbprint: "t".repeat(64), popAssurance: "agent_held_key", email: { status: "unavailable", address: null }, passport: { passport_id: "pid" } },
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
  const stored = await loadAdmissionCredential(SID, "builder-1", { homeDir: dirs.homeDir });
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

test("a live stored credential covering the scope is reused without any request", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs));
  const before = api.calls.length;
  const reused = await runAdmissionJoin(SID, base(api, dirs, { actions: ["session.read"] }));
  assert.equal(reused.reused, true);
  assert.equal(api.calls.length, before);
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
