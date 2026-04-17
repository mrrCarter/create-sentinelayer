import test from "node:test";
import assert from "node:assert/strict";

import {
  pollHumanMessages,
  resetSessionSyncStateForTests,
  syncSessionEventToApi,
} from "../src/session/sync.js";

test("Unit session sync: syncSessionEventToApi posts canonical event payload", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await syncSessionEventToApi(
    "sess-123",
    {
      event: "session_message",
      sessionId: "sess-123",
      payload: { message: "hello" },
    },
    {
      resolveAuthSession: async () => ({
        token: "tok_test_123",
        apiUrl: "https://api.sentinelayer.com/",
      }),
      fetchImpl: async (url, options, timeoutMs) => {
        calls.push({ url, options, timeoutMs });
        return {
          ok: true,
          status: 202,
        };
      },
      nowMs: () => 1_700_000_000_000,
    }
  );

  assert.equal(result.synced, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-123/events"
  );
  assert.equal(calls[0].options.method, "POST");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.source, "cli");
  assert.equal(payload.event.event, "session_message");
  assert.equal(payload.event.sessionId, "sess-123");
});

test("Unit session sync: relay events from API are not re-synced outbound", async () => {
  resetSessionSyncStateForTests();
  let called = false;
  const result = await syncSessionEventToApi(
    "sess-1",
    {
      event: "session_message",
      sessionId: "sess-1",
      payload: {
        message: "human relay",
        relayedFromApi: true,
      },
    },
    {
      resolveAuthSession: async () => ({
        token: "tok_test_123",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200 };
      },
    }
  );
  assert.equal(result.synced, false);
  assert.equal(result.reason, "relay_event_skip");
  assert.equal(called, false);
});

test("Unit session sync: outbound circuit breaker opens after consecutive failures", async () => {
  resetSessionSyncStateForTests();
  let callCount = 0;
  const failureFetch = async () => {
    callCount += 1;
    return {
      ok: false,
      status: 500,
    };
  };
  const authStub = async () => ({
    token: "tok_test_123",
    apiUrl: "https://api.sentinelayer.com",
  });

  for (let index = 0; index < 3; index += 1) {
    const result = await syncSessionEventToApi(
      "sess-breaker",
      {
        event: "session_message",
        sessionId: "sess-breaker",
        payload: { message: `event-${index}` },
      },
      {
        resolveAuthSession: authStub,
        fetchImpl: failureFetch,
        nowMs: () => 1_700_000_100_000,
      }
    );
    assert.equal(result.synced, false);
    assert.equal(result.reason, "api_500");
  }

  const blocked = await syncSessionEventToApi(
    "sess-breaker",
    {
      event: "session_message",
      sessionId: "sess-breaker",
      payload: { message: "blocked" },
    },
    {
      resolveAuthSession: authStub,
      fetchImpl: failureFetch,
      nowMs: () => 1_700_000_100_100,
    }
  );
  assert.equal(blocked.synced, false);
  assert.equal(blocked.reason, "circuit_breaker_open");
  assert.equal(callCount, 3);
});

test("Unit session sync: pollHumanMessages sanitizes, truncates, and rate limits relayed events", async () => {
  resetSessionSyncStateForTests();
  const longMessage = `${"x".repeat(2_100)}\u0001`;
  const messages = [
    {
      id: "m-1",
      ts: "2026-04-17T12:00:01.000Z",
      senderId: "human-owner",
      message: longMessage,
    },
    {
      id: "m-secret",
      ts: "2026-04-17T12:00:02.000Z",
      senderId: "human-owner",
      message: "do not post SENTINELAYER_TOKEN value",
    },
  ];
  for (let index = 0; index < 11; index += 1) {
    messages.push({
      id: `m-${index + 2}`,
      ts: `2026-04-17T12:00:${String(index + 3).padStart(2, "0")}.000Z`,
      senderId: "human-owner",
      message: `directive-${index + 1}`,
    });
  }

  const polled = await pollHumanMessages("sess-human", {
    since: "2026-04-17T11:59:59.000Z",
    resolveAuthSession: async () => ({
      token: "tok_test_123",
      apiUrl: "https://api.sentinelayer.com",
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        cursor: "cursor-2",
        messages,
      }),
    }),
    nowMs: () => 1_700_000_200_000,
  });

  assert.equal(polled.ok, true);
  assert.equal(polled.cursor, "cursor-2");
  assert.equal(polled.events.length, 10);
  assert.equal(polled.dropped.length, 3);

  const first = polled.events[0];
  assert.equal(first.event, "session_message");
  assert.equal(first.payload.source, "human");
  assert.equal(first.payload.priority, "high");
  assert.equal(first.payload.relayedFromApi, true);
  assert.equal(first.payload.message.includes("\u0001"), false);
  assert.equal(first.payload.message.length, 2_000);
});

test("Unit session sync: inbound circuit breaker opens after consecutive poll failures", async () => {
  resetSessionSyncStateForTests();
  let callCount = 0;
  const failureFetch = async () => {
    callCount += 1;
    return {
      ok: false,
      status: 503,
    };
  };
  const authStub = async () => ({
    token: "tok_test_123",
    apiUrl: "https://api.sentinelayer.com",
  });

  for (let index = 0; index < 3; index += 1) {
    const result = await pollHumanMessages("sess-human-breaker", {
      resolveAuthSession: authStub,
      fetchImpl: failureFetch,
      nowMs: () => 1_700_000_300_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "api_503");
  }

  const blocked = await pollHumanMessages("sess-human-breaker", {
    resolveAuthSession: authStub,
    fetchImpl: failureFetch,
    nowMs: () => 1_700_000_300_100,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "circuit_breaker_open");
  assert.equal(callCount, 3);
});
