import test from "node:test";
import assert from "node:assert/strict";

import { ringOwner, resolvePocketGatewayUrl, RING_OWNER_KINDS } from "../src/pocket/ring-owner.js";

test("ring-owner: posts question+kind+context to the POCKET gateway with the caller's bearer (target from auth, not body)", async () => {
  const calls = [];
  const result = await ringOwner("Ship the consolidation to master?", {
    kind: "decisionYours",
    sessionId: "6cf7e861",
    whatWeNeed: "master merge go",
    gatewayUrl: "https://pocket.example.com/",
    env: {},
    resolveAuthSession: async () => ({ token: "tok-abc", apiUrl: "https://api.sentinelayer.com" }),
    requestMutation: async (url, init) => { calls.push({ url, init }); return { dialId: "need_x", dispatched: true, kind: "decisionYours" }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pocket.example.com/dial/ring-owner", "hits the gateway /dial/ring-owner (NOT the senti apiUrl); trailing slash normalized");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.operationName, "pocket.ring_owner");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok-abc", "caller's own bearer — the gateway derives the ring TARGET from it, never a body field");
  assert.deepEqual(calls[0].init.body, {
    question: "Ship the consolidation to master?",
    kind: "decisionYours",
    context: { sessionId: "6cf7e861", whatWeNeed: "master merge go" },
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.dialId, "need_x");
});

test("ring-owner: pickOption carries options; checkpoint + idempotency-key + requestedBy thread through", async () => {
  const calls = [];
  const base = {
    sessionId: "s", gatewayUrl: "https://gw", env: {},
    resolveAuthSession: async () => ({ token: "t" }),
    requestMutation: async (url, init) => { calls.push({ url, init }); return { dialId: "need_y", dispatched: true }; },
  };
  await ringOwner("Which adapter?", { ...base, kind: "pickOption", options: ["Merge now", "Wait"], checkpointId: "cp_9", idempotencyKey: "op-7", requestedBy: "atlas" });
  assert.deepEqual(calls[0].init.body.options, ["Merge now", "Wait"]);
  assert.equal(calls[0].init.body.context.checkpointId, "cp_9");
  assert.equal(calls[0].init.body.idempotencyKey, "op-7");
  assert.equal(calls[0].init.body.requestedBy, "atlas");
});

test("ring-owner: empty pickOption options rejected BEFORE any network call (fail-closed)", async () => {
  const calls = [];
  const base = {
    sessionId: "s", gatewayUrl: "https://gw", env: {},
    resolveAuthSession: async () => ({ token: "t" }),
    requestMutation: async (url, init) => { calls.push({ url, init }); return { dispatched: true }; },
  };
  await assert.rejects(ringOwner("Which?", { ...base, kind: "pickOption", options: [] }), /pickOption requires/);
  assert.equal(calls.length, 0, "a malformed pickOption never hits the network");
});

test("ring-owner: fail-closed on missing question / session / gateway URL / auth / bad kind", async () => {
  const ok = {
    sessionId: "s", gatewayUrl: "https://gw", env: {},
    resolveAuthSession: async () => ({ token: "t" }),
    requestMutation: async () => ({ dispatched: true }),
  };
  await assert.rejects(ringOwner("", ok), /question is required/);
  await assert.rejects(ringOwner("q", { ...ok, sessionId: "" }), /session id is required/);
  await assert.rejects(ringOwner("q", { ...ok, kind: "bogus" }), /kind must be one of/);
  await assert.rejects(ringOwner("q", { ...ok, gatewayUrl: "", env: {} }), /gateway URL not configured/);
  await assert.rejects(ringOwner("q", { ...ok, resolveAuthSession: async () => ({}) }), /Not authenticated/);
});

test("resolvePocketGatewayUrl: env SENTI_POCKET_URL / POCKET_GATEWAY_URL / configUrl; scheme-validated; trailing slash trimmed", () => {
  assert.equal(resolvePocketGatewayUrl({ env: { SENTI_POCKET_URL: "https://a/" } }), "https://a");
  assert.equal(resolvePocketGatewayUrl({ env: { POCKET_GATEWAY_URL: "https://b" } }), "https://b");
  assert.equal(resolvePocketGatewayUrl({ env: {}, configUrl: "https://c" }), "https://c");
  assert.equal(resolvePocketGatewayUrl({ env: {} }), "", "absent -> empty (caller errors)");
  assert.throws(() => resolvePocketGatewayUrl({ env: { SENTI_POCKET_URL: "ftp://x" } }), /http\(s\)/);
  assert.ok(RING_OWNER_KINDS.includes("decisionYours") && RING_OWNER_KINDS.includes("checkpointReady"));
});
