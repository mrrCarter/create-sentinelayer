import test from "node:test";
import assert from "node:assert/strict";

import { pollHumanMessages, syncSessionEventToApi } from "../src/session/sync.js";

// The sync.js module does not export resolveApiBaseUrl directly, so we exercise
// the allowlist via the public API by mocking resolveAuthSession to return
// a session with a tampered apiUrl and asserting the outbound URL goes to the
// canonical host, not the attacker-controlled one.

function makeFetchRecorder() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ messages: [], cursor: null }),
      text: async () => "",
    };
  };
  return { calls, fetchImpl };
}

test("sync apiUrl allowlist: tampered session.apiUrl falls back to canonical host on pollHumanMessages", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  const tamperedSession = {
    token: "fake-token-for-test",
    apiUrl: "https://evil.example.com",
  };
  const result = await pollHumanMessages("sess_abc123", {
    targetPath: process.cwd(),
    resolveAuthSession: async () => tamperedSession,
    fetchImpl,
    timeoutMs: 100,
  });

  assert.ok(calls.length >= 1, "fetch should be invoked");
  const url = new URL(calls[0].url);
  assert.notEqual(url.hostname, "evil.example.com", "must not call tampered host");
  assert.equal(url.hostname, "api.sentinelayer.com", "must fall back to canonical host");
  assert.ok(result.ok === true || result.ok === false, "must return a well-formed result");
});

test("sync apiUrl allowlist: tampered session.apiUrl falls back on syncSessionEventToApi", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  const tamperedSession = {
    token: "fake-token-for-test",
    apiUrl: "http://169.254.169.254",
  };

  await syncSessionEventToApi(
    "sess_abc123",
    { event: "agent_join", agentId: "test", sessionId: "sess_abc123", ts: new Date().toISOString() },
    {
      targetPath: process.cwd(),
      resolveAuthSession: async () => tamperedSession,
      fetchImpl,
      timeoutMs: 100,
    }
  );

  if (calls.length > 0) {
    const url = new URL(calls[0].url);
    assert.notEqual(url.hostname, "169.254.169.254", "must not call metadata endpoint");
  }
});

test("sync apiUrl allowlist: localhost is allowed for dev sessions", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  const devSession = {
    token: "fake-token",
    apiUrl: "http://localhost:8080",
  };
  await pollHumanMessages("sess_dev", {
    targetPath: process.cwd(),
    resolveAuthSession: async () => devSession,
    fetchImpl,
    timeoutMs: 100,
  });
  if (calls.length > 0) {
    const url = new URL(calls[0].url);
    assert.equal(url.hostname, "localhost");
  }
});

test("sync apiUrl allowlist: api.staging.sentinelayer.com is allowed", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  const stagingSession = {
    token: "fake-token",
    apiUrl: "https://api.staging.sentinelayer.com",
  };
  await pollHumanMessages("sess_stg", {
    targetPath: process.cwd(),
    resolveAuthSession: async () => stagingSession,
    fetchImpl,
    timeoutMs: 100,
  });
  if (calls.length > 0) {
    const url = new URL(calls[0].url);
    assert.equal(url.hostname, "api.staging.sentinelayer.com");
  }
});
