// `sl session ticket ...` through the real runCli, as an admitted agent, against a
// fake API that implements the T2 ticket routes the way the API does (idempotent
// replay by key; a live lease conflicts; submit needs the current lease + version).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-tickets-"));
const homeDir = path.join(scratch, "home");
await fsp.mkdir(homeDir, { recursive: true });
for (const name of ["HOME", "USERPROFILE"]) process.env[name] = homeDir;
process.env.SENTINELAYER_DISABLE_KEYRING = "1";
process.env.SENTINELAYER_SKIP_SENTI_AUTOSTART = "1";
process.env.SENTINELAYER_API_URL = "https://api.fixture.invalid";
process.env.SENTINELAYER_API_ALLOWED_HOSTS = "api.fixture.invalid";
process.env.SENTINELAYER_CIRCUIT_STATE_DIR = path.join(scratch, "circuits");
delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
process.env.SENTINELAYER_TOKEN = "human-fixture-token";

const { runCli } = await import("../src/cli.js");
const { admissionCredentialPath } = await import("../src/session/admission.js");
const { ticketLeasePath } = await import("../src/session/tickets.js");

const API = "https://api.fixture.invalid";
const SID = "e9e8dc5e-8d57-4603-975f-09156e3b4473";
const AGENT = "ticket-agent";
const ADMISSION_TOKEN = `sladm_${"T".repeat(43)}`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function storeAdmission({ expired = false } = {}) {
  const file = admissionCredentialPath(SID, AGENT, { homeDir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    JSON.stringify({
      version: 2, sessionId: SID, agentId: AGENT, apiUrl: API, admissionId: "adm-1", token: ADMISSION_TOKEN,
      expiresAt: Math.floor(Date.now() / 1000) + (expired ? -5 : 3600),
    })
  );
}

function fakeApi({ loseClaimResponses = 0, decoyCursor = false, brokenContinuation = false } = {}) {
  const state = { requests: [], tickets: new Map(), idem: new Map(), leases: 0, lose: loseClaimResponses, decoyCursor, brokenContinuation };
  const put = (t) => state.tickets.set(t.id, t);
  put({ id: "t-open", title: "open work", status: "open", version: 1, lease: null });
  put({ id: "t-blocked", title: "blocked work", status: "blocked", version: 1, lease: null });
  put({ id: "t-leased", title: "someone else's", status: "working", version: 2, lease: { holder: "other", live: true, leaseId: "L0", fence: 1 } });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    const bearer = (headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const key = headers.get("idempotency-key");
    state.requests.push({ method, path: u.pathname, bearer, key });
    if (u.origin !== API) throw new Error(`left the fixture API: ${u.origin}`);
    if (bearer !== ADMISSION_TOKEN) return json({ error: { code: "INVALID_TOKEN" } }, 401);
    const p = u.pathname;
    if (method === "GET" && p.endsWith("/tickets")) {
      // The bounded board page: NOT a baseline, and it would miss work. The list must not use it.
      return json({ items: [{ id: "board-decoy", title: "board page only", status: "open", version: 1, lease: null }] });
    }
    if (method === "GET" && p.endsWith("/tickets/snapshot")) {
      // Id order, capped at 2 per page whatever the client asks, so the client MUST page.
      const all = [...state.tickets.values()].sort((a, b) => a.id.localeCompare(b.id));
      const after = u.searchParams.get("afterId");
      const rest = after ? all.filter((t) => t.id > after) : all;
      const page = rest.slice(0, 2);
      const hasMore = rest.length > 2;
      const out = { items: page.map((t) => ({ ...t })), hasMore, nextAfterId: hasMore ? page[page.length - 1].id : null };
      // The first page carries the baseline cursor; a later page's is a DECOY the client must ignore.
      if (!after) out.cursor = 7;
      else if (state.decoyCursor) out.cursor = 999;
      if (state.brokenContinuation && after) { out.hasMore = true; out.nextAfterId = null; }
      return json(out);
    }
    if (method === "GET" && p.endsWith("/tickets/events")) return json({ events: [], cursor: 7 });
    const m = p.match(/\/tickets\/([^/]+)\/(claim|lease\/renew|lease\/release|submit)$/);
    if (method === "POST" && m) {
      const [, id, op] = m;
      const replayKey = `${op}:${id}:${key}`;
      if (state.idem.has(replayKey)) {
        if (op === "claim" && state.lose > 0) {
          state.lose -= 1;
          throw new TypeError("fetch failed: connection reset (response lost)");
        }
        const stored = { ...state.idem.get(replayKey), replayed: true };
        return json(stored);
      }
      const t = state.tickets.get(id);
      const body = JSON.parse(init.body || "{}");
      let out;
      if (op === "claim") {
        if (t.lease?.live) return json({ error: { code: "TICKET_CONFLICT" } }, 409);
        state.leases += 1;
        // What the API returns: the holder is taken from the CREDENTIAL. `misattribute` models a
        // server that recorded someone else (e.g. the human behind a label).
        t.lease = state.misattribute
          ? { holderKind: "human", holder: "human-user-id", live: true, leaseId: `L${state.leases}`, fence: (t.lease?.fence || 0) + 1 }
          : { holderKind: "agent", holder: AGENT, live: true, leaseId: `L${state.leases}`, fence: (t.lease?.fence || 0) + 1 };
        t.status = "working";
        t.version += 1;
        out = { ticket: { ...t }, version: t.version, cursor: 8, lease: { leaseId: t.lease.leaseId, fence: t.lease.fence, expiresAt: "2026-09-29T08:00:00Z" } };
        state.idem.set(replayKey, out);
        if (state.lose > 0) {
          state.lose -= 1;
          throw new TypeError("fetch failed: connection reset (response lost)");
        }
        return json(out);
      }
      if (!t.lease || body.leaseId !== t.lease.leaseId || body.fence !== t.lease.fence) {
        return json({ error: { code: "STALE_LEASE" } }, 409);
      }
      if (op === "lease/renew") {
        t.version += 1;
        out = { ticket: { ...t }, version: t.version, cursor: 9, lease: { leaseId: t.lease.leaseId, fence: t.lease.fence, expiresAt: "2026-09-29T08:15:00Z" } };
      } else {
        if (body.expectedVersion !== t.version) return json({ error: { code: "TICKET_CONFLICT" } }, 409);
        t.version += 1;
        t.status = op === "submit" ? "in_review" : "open";
        t.lease = null;
        out = { ticket: { ...t }, version: t.version, cursor: 10 };
      }
      state.idem.set(replayKey, out);
      return json(out);
    }
    return json({ error: { code: "NOT_FOUND", path: p } }, 404);
  };
  return state;
}

async function sl(args) {
  const out = [];
  const originalLog = console.log;
  console.log = (...parts) => out.push(parts.join(" "));
  let error = null;
  try {
    await runCli(args);
  } catch (err) {
    error = err;
  } finally {
    console.log = originalLog;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(out.join("\n"));
  } catch {}
  return { error, json: parsed, text: out.join("\n") };
}

async function reset() {
  await fsp.rm(path.join(homeDir, ".sentinelayer"), { recursive: true, force: true });
}

test("an admitted agent claims, renews and submits: every request on its admission", async () => {
  await reset();
  await storeAdmission();
  const api = fakeApi();
  const claim = await sl(["session", "ticket", "claim", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.equal(claim.error, null, String(claim.error?.stack || claim.error));
  assert.equal(claim.json.lease.fence, 1);
  const renew = await sl(["session", "ticket", "renew", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.equal(renew.error, null, String(renew.error?.stack || renew.error));
  const submit = await sl(["session", "ticket", "submit", SID, "t-open", "--agent", AGENT, "--sha", "abc123", "--json"]);
  assert.equal(submit.error, null, String(submit.error?.stack || submit.error));
  assert.equal(submit.json.ticket.status, "in_review");
  assert.ok(api.requests.every((r) => r.bearer === ADMISSION_TOKEN), "never the human token");
  await assert.rejects(fsp.access(ticketLeasePath(SID, "t-open", AGENT, { homeDir })), "lease state cleared after submit");
});

test("a LOST claim response is replayed with the SAME key on the next run: one lease, not two", async () => {
  await reset();
  await storeAdmission();
  const api = fakeApi({ loseClaimResponses: 99 });
  const first = await sl(["session", "ticket", "claim", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.ok(first.error, "the response never arrived");
  const keys = new Set(api.requests.filter((r) => r.path.endsWith("/claim")).map((r) => r.key));
  assert.equal(keys.size, 1, "retries within one run reuse one key");
  api.lose = 0;
  const second = await sl(["session", "ticket", "claim", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.equal(second.error, null, String(second.error?.stack || second.error));
  assert.equal(second.json.replayed, true);
  assert.equal(api.leases, 1, "the server performed the claim exactly once");
  const claimKeys = new Set(api.requests.filter((r) => r.path.endsWith("/claim")).map((r) => r.key));
  assert.equal(claimKeys.size, 1, "the second run reused the persisted key");
});

test("an unreadable local lease state refuses instead of reading as 'no lease'", async () => {
  await reset();
  await storeAdmission();
  fakeApi();
  const file = ticketLeasePath(SID, "t-open", AGENT, { homeDir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, "{ not json");
  const renew = await sl(["session", "ticket", "renew", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.match(String(renew.error?.message), /unreadable; refusing to guess/);
});

test("renewing with no lease held here says so, with no request", async () => {
  await reset();
  await storeAdmission();
  const api = fakeApi();
  const renew = await sl(["session", "ticket", "renew", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.match(String(renew.error?.message), /holds no lease/);
  assert.equal(api.requests.length, 0);
});

test("--available lists only claimable work: never blocked, never a live lease", async () => {
  await reset();
  await storeAdmission();
  fakeApi();
  const listed = await sl(["session", "ticket", "list", SID, "--available", "--agent", AGENT, "--json"]);
  assert.equal(listed.error, null, String(listed.error?.stack || listed.error));
  assert.deepEqual(listed.json.items.map((t) => t.id), ["t-open"]);
});

test("an EXPIRED admission refuses a ticket command before any request", async () => {
  await reset();
  await storeAdmission({ expired: true });
  const api = fakeApi();
  const claim = await sl(["session", "ticket", "claim", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.match(String(claim.error?.message), /expired.*will not fall back/s);
  assert.equal(api.requests.length, 0);
});

test("a lease state path that cannot be READ (not just parsed) also refuses", async () => {
  await reset();
  await storeAdmission();
  fakeApi();
  const file = ticketLeasePath(SID, "t-open", AGENT, { homeDir });
  await fsp.mkdir(file, { recursive: true }); // a directory where the file should be: EISDIR
  const renew = await sl(["session", "ticket", "renew", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.match(String(renew.error?.message), /unreadable; refusing to guess/);
});

// ------------- the list is the COMPLETE snapshot, not the bounded board page (T2-R3)

test("`ticket list` pages the snapshot to the end and keeps the FIRST page's cursor", async () => {
  await reset();
  await storeAdmission();
  const api = fakeApi({ decoyCursor: true });
  for (const id of ["t-a", "t-b", "t-z"]) api.tickets.set(id, { id, title: id, status: "open", version: 1, lease: null });
  const ran = await sl(["session", "ticket", "list", SID, "--agent", AGENT, "--json"]);
  assert.equal(ran.error, null, String(ran.error?.stack || ran.error));
  const ids = ran.json.items.map((t) => t.id).sort();
  assert.deepEqual(ids, ["t-a", "t-b", "t-blocked", "t-leased", "t-open", "t-z"]);
  assert.equal(ran.json.cursor, 7, "the baseline is the first page's cursor, never a later page's");
  assert.equal(ran.json.complete, true);
  const snapshotCalls = api.requests.filter((r) => r.path.endsWith("/tickets/snapshot"));
  assert.equal(snapshotCalls.length, 3);
  assert.equal(api.requests.some((r) => r.path.endsWith("/tickets")), false, "the bounded board page is never the list");
});

test("a snapshot that cannot be continued is refused, never shown partial", async () => {
  await reset();
  await storeAdmission();
  fakeApi({ brokenContinuation: true });
  const ran = await sl(["session", "ticket", "list", SID, "--agent", AGENT, "--json"]);
  assert.match(String(ran.error?.message), /refusing a partial list/);
});

// ------------- reviewer holds on ac7298ea: malformed snapshots, and ticket authority

const { listTickets } = await import("../src/session/tickets.js");

const A = { id: "00000000-0000-4000-8000-000000000001", title: "a", status: "open" };
const B = { ...A, id: "00000000-0000-4000-8000-000000000002", title: "b" };
const FIRST = { items: [A], cursor: 7, hasMore: true, nextAfterId: A.id };

async function listFrom(pages) {
  let call = 0;
  return listTickets(SID, {
    resolveAuthSession: async () => ({ token: "synthetic", apiUrl: API }),
    requestRead: async () => {
      if (call >= pages.length) throw new Error("unexpected fixture request");
      return structuredClone(pages[call++]);
    },
    maxPages: 8,
  });
}

test("CONTROL: a well-formed two-page snapshot is complete, with the first cursor", async () => {
  const listed = await listFrom([FIRST, { items: [B], hasMore: false, nextAfterId: null }]);
  assert.equal(listed.cursor, 7);
  assert.equal(listed.complete, true);
  assert.deepEqual(listed.items.map((t) => t.id).sort(), [A.id, B.id]);
});

// Each case isolates ONE guard and asserts ITS reason, so no guard is covered by another.
for (const [name, pages, reason] of [
  ["a page that is not an object", [FIRST, null], /a page is not an object/],
  ["an empty second response", [FIRST, {}], /a page has no items list/],
  ["items that are not a list", [FIRST, { items: { id: B.id }, hasMore: false, nextAfterId: null }], /a page has no items list/],
  ["hasMore that is not a boolean", [{ items: [A], cursor: 7, hasMore: "true", nextAfterId: A.id }], /does not say whether there is more/],
  ["no cursor on the first page", [{ items: [A], hasMore: false, nextAfterId: null }], /no room cursor/],
  ["a page that goes backwards (token cycle)", [FIRST, { items: [B], hasMore: true, nextAfterId: B.id }, { items: [A], hasMore: false, nextAfterId: null }], /not in ascending order/],
  ["a ticket twice on one page", [{ items: [A, B, B], cursor: 7, hasMore: false, nextAfterId: null }], /not in ascending order/],
  ["ids out of order within a page", [{ items: [B, A], cursor: 7, hasMore: false, nextAfterId: null }], /not in ascending order/],
  ["more, with no way to continue", [{ items: [A], cursor: 7, hasMore: true, nextAfterId: null }], /no way to continue/],
  ["a continuation behind the last ticket", [FIRST, { items: [B], hasMore: true, nextAfterId: A.id }], /not the last ticket returned/],
  ["a continuation AHEAD of the last ticket (skips B)", [{ items: [A], cursor: 7, hasMore: true, nextAfterId: B.id }, { items: [], hasMore: false, nextAfterId: null }], /not the last ticket returned/],
  ["an empty page that claims more", [{ items: [], cursor: 7, hasMore: true, nextAfterId: A.id }], /an empty page claims there is more/],
]) {
  test(`a malformed snapshot is refused, never listed: ${name}`, async () => {
    await assert.rejects(listFrom(pages), (error) => {
      assert.match(String(error.message), reason);
      assert.match(String(error.message), /refusing a partial list/);
      return true;
    });
  });
}

test("ticket work as an agent with NO admission is refused before any request", async () => {
  await reset();
  const api = fakeApi();
  const ran = await sl(["session", "ticket", "claim", SID, "t-open", "--agent", "not-admitted", "--json"]);
  assert.match(String(ran.error?.message), /"not-admitted" has no live admission.*would act as you/s);
  assert.deepEqual(api.requests, []);
});

test("a claim the server records for someone else is not recorded as ours", async () => {
  await reset();
  await storeAdmission();
  const api = fakeApi();
  api.misattribute = true;
  const ran = await sl(["session", "ticket", "claim", SID, "t-open", "--agent", AGENT, "--json"]);
  assert.match(String(ran.error?.message), /recorded this lease for human.*not for "ticket-agent"/s);
  // Only the pending idempotency key may be on disk (it is written before the request, so a
  // lost response replays); no lease is recorded as ours.
  const local = JSON.parse(await fsp.readFile(ticketLeasePath(SID, "t-open", AGENT, { homeDir }), "utf-8"));
  assert.equal(local.leaseId, undefined);
  assert.equal(api.requests.filter((r) => r.path.endsWith("/claim")).length, 1);
});
