import test from "node:test";
import assert from "node:assert/strict";

import {
  pollHumanMessages,
  pollSessionEvents,
  resetSessionSyncStateForTests,
  syncSessionErrorToApi,
  syncSessionEventToApi,
  syncSessionMetadataToApi,
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

test("Unit session sync: syncSessionMetadataToApi posts metadata payload", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await syncSessionMetadataToApi(
    "sess-meta-1",
    {
      sessionId: "sess-meta-1",
      status: "active",
    },
    {
      resolveAuthSession: async () => ({
        token: "tok_test_123",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options, timeoutMs) => {
        calls.push({ url, options, timeoutMs });
        return { ok: true, status: 202 };
      },
      nowMs: () => 1_700_000_000_100,
    }
  );
  assert.equal(result.synced, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.sentinelayer.com/api/v1/sessions/sess-meta-1/metadata");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.source, "cli");
  assert.equal(payload.metadata.sessionId, "sess-meta-1");
});

test("Unit session sync: syncSessionErrorToApi posts structured error payload", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await syncSessionErrorToApi(
    "sess-error-1",
    {
      requestId: "req-123",
      errorCode: "E_TIMEOUT",
      error: "tool timeout",
    },
    {
      resolveAuthSession: async () => ({
        token: "tok_test_123",
        apiUrl: "https://api.sentinelayer.com/",
      }),
      fetchImpl: async (url, options, timeoutMs) => {
        calls.push({ url, options, timeoutMs });
        return { ok: true, status: 202 };
      },
      nowMs: () => 1_700_000_000_200,
    }
  );
  assert.equal(result.synced, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.sentinelayer.com/api/v1/sessions/sess-error-1/errors");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.source, "cli");
  assert.equal(payload.error.requestId, "req-123");
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
  resetSessionSyncStateForTests();
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
  resetSessionSyncStateForTests();
});

test("Unit session sync: pollSessionEvents uses cursor and limit against events endpoint", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await pollSessionEvents("sess-events", {
    since: "cursor-1",
    limit: 500,
    resolveAuthSession: async () => ({
      token: "tok_test_123",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: [
            {
              cursor: "cursor-2",
              event: "session_message",
              payload: { message: "hello" },
            },
          ],
        }),
      };
    },
    nowMs: () => 1_700_000_400_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.cursor, "cursor-2");
  assert.equal(result.events.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-events/events?after=cursor-1&limit=200"
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok_test_123");
});

test("Unit session sync: pollSessionEvents reuses inbound circuit breaker", async () => {
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
    const result = await pollSessionEvents("sess-events-breaker", {
      resolveAuthSession: authStub,
      fetchImpl: failureFetch,
      nowMs: () => 1_700_000_500_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "api_503");
  }

  const blocked = await pollSessionEvents("sess-events-breaker", {
    resolveAuthSession: authStub,
    fetchImpl: failureFetch,
    nowMs: () => 1_700_000_500_100,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "circuit_breaker_open");
  assert.equal(callCount, 3);
  resetSessionSyncStateForTests();
});

test("Unit session sync: pollSessionEvents can force a one-shot probe through an open circuit", async () => {
  resetSessionSyncStateForTests();
  let callCount = 0;
  const authStub = async () => ({
    token: "tok_test_123",
    apiUrl: "https://api.sentinelayer.com",
  });
  const failureFetch = async () => {
    callCount += 1;
    return { ok: false, status: 503 };
  };

  for (let index = 0; index < 3; index += 1) {
    const result = await pollSessionEvents("sess-events-probe", {
      resolveAuthSession: authStub,
      fetchImpl: failureFetch,
      nowMs: () => 1_700_000_600_000,
    });
    assert.equal(result.reason, "api_503");
  }

  const blocked = await pollSessionEvents("sess-events-probe", {
    resolveAuthSession: authStub,
    fetchImpl: failureFetch,
    nowMs: () => 1_700_000_600_100,
  });
  assert.equal(blocked.reason, "circuit_breaker_open");
  assert.equal(callCount, 3);

  const recovered = await pollSessionEvents("sess-events-probe", {
    resolveAuthSession: authStub,
    forceCircuitProbe: true,
    fetchImpl: async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          events: [{ cursor: "recovered", event: "session_message", payload: { message: "ok" } }],
        }),
      };
    },
    nowMs: () => 1_700_000_600_200,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.cursor, "recovered");
  assert.equal(callCount, 4);

  const afterRecovery = await pollSessionEvents("sess-events-probe", {
    resolveAuthSession: authStub,
    fetchImpl: async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      };
    },
    nowMs: () => 1_700_000_600_300,
  });
  assert.equal(afterRecovery.ok, true);
  assert.equal(callCount, 5);
  resetSessionSyncStateForTests();
});
