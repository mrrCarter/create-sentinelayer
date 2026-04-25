// Unit tests for listSessionsFromApi + probeSessionAccess.
//
// These cover the two paths Carter hit:
//   1. `slc session list --remote` — must surface every session on
//      the API account, not just local-workspace dirs.
//   2. `slc session sync <id>` — when relayed=0/cursor=null, must be
//      able to discriminate "owned-but-empty" from "not a member /
//      wrong id" via probeSessionAccess.

import test from "node:test";
import assert from "node:assert/strict";

import {
  listSessionsFromApi,
  probeSessionAccess,
} from "../src/session/sync.js";

function fakeSession({ token = "tok", apiUrl = "https://api.example.com" } = {}) {
  return async () => ({ token, apiUrl });
}

function fakeFetch(handler) {
  return async (url, init, _timeoutMs) => handler(url, init);
}

test("listSessionsFromApi: forwards include_archived + limit", async () => {
  let observedUrl = "";
  const result = await listSessionsFromApi({
    targetPath: "/tmp",
    includeArchived: true,
    limit: 25,
    resolveAuthSession: fakeSession(),
    fetchImpl: fakeFetch((url) => {
      observedUrl = url;
      return {
        ok: true,
        json: async () => ({ sessions: [{ sessionId: "a" }], count: 1 }),
      };
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.sessions[0].sessionId, "a");
  assert.match(observedUrl, /\/api\/v1\/sessions\?/);
  assert.match(observedUrl, /include_archived=true/);
  assert.match(observedUrl, /limit=25/);
});

test("listSessionsFromApi: returns api_403 when forbidden", async () => {
  const result = await listSessionsFromApi({
    targetPath: "/tmp",
    resolveAuthSession: fakeSession(),
    fetchImpl: fakeFetch(() => ({ ok: false, status: 403, json: async () => ({}) })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "api_403");
  assert.deepEqual(result.sessions, []);
});

test("listSessionsFromApi: not_authenticated when no token", async () => {
  const result = await listSessionsFromApi({
    targetPath: "/tmp",
    resolveAuthSession: async () => null,
    fetchImpl: fakeFetch(() => ({ ok: true, json: async () => ({}) })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_authenticated");
});

test("probeSessionAccess: 200 → accessible", async () => {
  const result = await probeSessionAccess("sess-1", {
    targetPath: "/tmp",
    resolveAuthSession: fakeSession(),
    fetchImpl: fakeFetch(() => ({ ok: true, status: 200, json: async () => ({}) })),
  });
  assert.equal(result.accessible, true);
  assert.equal(result.status, 200);
});

test("probeSessionAccess: 403 → not_a_member", async () => {
  const result = await probeSessionAccess("sess-1", {
    targetPath: "/tmp",
    resolveAuthSession: fakeSession(),
    fetchImpl: fakeFetch(() => ({ ok: false, status: 403, json: async () => ({}) })),
  });
  assert.equal(result.accessible, false);
  assert.equal(result.reason, "not_a_member");
  assert.equal(result.status, 403);
});

test("probeSessionAccess: 404 → session_not_found", async () => {
  const result = await probeSessionAccess("sess-1", {
    targetPath: "/tmp",
    resolveAuthSession: fakeSession(),
    fetchImpl: fakeFetch(() => ({ ok: false, status: 404, json: async () => ({}) })),
  });
  assert.equal(result.accessible, false);
  assert.equal(result.reason, "session_not_found");
});

test("probeSessionAccess: invalid id → invalid_session_id", async () => {
  const result = await probeSessionAccess("");
  assert.equal(result.accessible, false);
  assert.equal(result.reason, "invalid_session_id");
});

test("probeSessionAccess: missing token → not_authenticated", async () => {
  const result = await probeSessionAccess("sess-1", {
    resolveAuthSession: async () => null,
  });
  assert.equal(result.accessible, false);
  assert.equal(result.reason, "not_authenticated");
});

test("probeSessionAccess: network error surfaces reason", async () => {
  const result = await probeSessionAccess("sess-1", {
    targetPath: "/tmp",
    resolveAuthSession: fakeSession(),
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  assert.equal(result.accessible, false);
  assert.match(result.reason, /ENOTFOUND/);
});
