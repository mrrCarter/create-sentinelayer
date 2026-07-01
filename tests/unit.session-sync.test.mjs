import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetAutoGrantCacheForTests,
  createSessionMessageAction,
  fetchSessionUsageLedger,
  listSessionMessageActions,
  pollHumanMessages,
  pollSessionEvents,
  pollSessionEventsBefore,
  resetSessionSyncStateForTests,
  searchSessionEvents,
  streamSessionEvents,
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

test("Unit session sync: durable API events with cursor are not re-synced outbound", async () => {
  resetSessionSyncStateForTests();
  let called = false;
  const apiToken = "unit-test-token";
  const result = await syncSessionEventToApi(
    "sess-1",
    {
      event: "session_message",
      sessionId: "sess-1",
      cursor: "1778224296063:00001ab2",
      eventId: "evt-api",
      idempotencyToken: "local-idempotency-after-hydrate",
      sequenceId: 6834,
      agent: { id: "claude-verifier", model: "claude-opus-4-7" },
      payload: {
        message: "remote durable event",
      },
    },
    {
      resolveAuthSession: async () => ({
        token: apiToken,
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

test("Unit session sync: local idempotency metadata alone is still synced outbound", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const apiToken = "unit-test-token";
  const result = await syncSessionEventToApi(
    "sess-1",
    {
      event: "session_message",
      sessionId: "sess-1",
      idempotencyToken: "local-post-agent-idempotency",
      agent: { id: "codex", model: "gpt-5" },
      payload: {
        message: "local post-agent event",
      },
    },
    {
      resolveAuthSession: async () => ({
        token: apiToken,
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200 };
      },
    }
  );
  assert.equal(result.synced, true);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.event.idempotencyToken, "local-post-agent-idempotency");
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

test("Unit session sync: streamSessionEvents consumes SSE events from stream endpoint", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const seen = [];
  let heartbeats = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": keep-alive\n\n"));
      controller.enqueue(
        encoder.encode(
          'data: {"event":"session_message","cursor":"cursor-2","payload":{"message":"wake"}}\n\n',
        ),
      );
      controller.close();
    },
  });

  const result = await streamSessionEvents("sess-stream", {
    since: "cursor-1",
    resolveAuthSession: async () => ({
      token: "tok_stream",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return {
        ok: true,
        status: 200,
        body,
      };
    },
    onHeartbeat: async () => {
      heartbeats += 1;
    },
    onEvent: async (event) => {
      seen.push(event);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.cursor, "cursor-2");
  assert.equal(result.eventCount, 1);
  assert.equal(result.errorCount, 0);
  assert.equal(heartbeats, 1);
  assert.equal(seen[0].payload.message, "wake");
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-stream/stream?after=cursor-1",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Accept, "text/event-stream");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok_stream");
});

test("Unit session sync: streamSessionEvents aborts a silent stream after idle timeout", async () => {
  resetSessionSyncStateForTests();
  let observedSignal = null;
  const result = await streamSessionEvents("sess-stream-idle", {
    idleTimeoutMs: 1,
    resolveAuthSession: async () => ({
      token: "tok_stream_idle",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("stream idle timeout", "AbortError")),
            { once: true },
          );
        },
      });
      return {
        ok: true,
        status: 200,
        body,
      };
    },
  });

  assert.ok(observedSignal, "expected stream fetch to receive an abort signal");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stream_idle_timeout");
  assert.equal(result.cursor, null);
  assert.equal(result.eventCount, 0);
});

test("Unit session sync: streamSessionEvents reports SSE error frames", async () => {
  resetSessionSyncStateForTests();
  const errors = [];
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"type":"error","error":{"code":"SESSION_STREAM_TIMEOUT","message":"done"}}\n\n',
        ),
      );
      controller.close();
    },
  });

  const result = await streamSessionEvents("sess-stream-timeout", {
    resolveAuthSession: async () => ({
      token: "tok_stream",
      apiUrl: "https://api.sentinelayer.com",
    }),
    fetchImpl: async () => ({ ok: true, status: 200, body }),
    onError: async (error) => errors.push(error.reason),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "SESSION_STREAM_TIMEOUT");
  assert.equal(result.eventCount, 0);
  assert.equal(result.errorCount, 1);
  assert.deepEqual(errors, ["SESSION_STREAM_TIMEOUT"]);
});

test("Unit session sync: pollSessionEventsBefore fetches latest tail chronologically", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const apiToken = "unit-test-token";
  const result = await pollSessionEventsBefore("sess-events", {
    beforeSequence: 100,
    limit: 500,
    resolveAuthSession: async () => ({
      token: apiToken,
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
              cursor: "cursor-99",
              sequenceId: 99,
              ts: "2026-05-08T06:00:02.000Z",
              event: "session_message",
              payload: { message: "newest" },
            },
            {
              cursor: "cursor-98",
              sequenceId: 98,
              ts: "2026-05-08T06:00:01.000Z",
              event: "session_message",
              payload: { message: "older" },
            },
          ],
        }),
      };
    },
    nowMs: () => 1_700_000_450_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.cursor, "cursor-99");
  assert.equal(result.events.length, 2);
  assert.deepEqual(
    result.events.map((event) => event.payload.message),
    ["older", "newest"],
  );
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-events/events/before?beforeSequence=100&limit=200"
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${apiToken}`);
});

test("Unit session sync: pollSessionEventsBefore orders durable rows by sequence across timestamp skew", async () => {
  resetSessionSyncStateForTests();
  const result = await pollSessionEventsBefore("sess-skewed", {
    beforeSequence: 100,
    resolveAuthSession: async () => ({
      token: "tok_test_123",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          {
            cursor: "cursor-99",
            sequenceId: 99,
            ts: "2026-05-08T06:00:00.000Z",
            event: "session_message",
            payload: { message: "newer sequence with older clock" },
          },
          {
            cursor: "cursor-98",
            sequenceId: 98,
            ts: "2026-05-08T06:00:10.000Z",
            event: "session_message",
            payload: { message: "older sequence with later clock" },
          },
        ],
        next_before_sequence: 98,
      }),
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.events.map((event) => event.sequenceId),
    [98, 99],
  );
  assert.equal(result.beforeSequence, 98);
});

test("Unit session sync: pollSessionEventsBefore falls back to minimum sequence when metadata is absent", async () => {
  resetSessionSyncStateForTests();
  const result = await pollSessionEventsBefore("sess-skewed-no-meta", {
    beforeSequence: 100,
    resolveAuthSession: async () => ({
      token: "tok_test_123",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        events: [
          { cursor: "cursor-99", sequenceId: 99, ts: "2026-05-08T06:00:00.000Z" },
          { cursor: "cursor-98", sequenceId: 98, ts: "2026-05-08T06:00:10.000Z" },
        ],
      }),
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.events.map((event) => event.sequenceId),
    [98, 99],
  );
  assert.equal(result.beforeSequence, 98);
});

test("Unit session sync: listSessionMessageActions hits actions endpoint", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await listSessionMessageActions("sess-actions", {
    targetSequenceId: 42,
    targetActionId: "6f6238a9-f035-4a8f-b05b-ac33507f772a",
    limit: 999,
    resolveAuthSession: async () => ({
      token: "tok_actions",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "sess-actions",
          actions: [{ id: "act-1", actionType: "working_on", targetSequenceId: 42 }],
          count: 1,
          projection: { byTarget: [] },
        }),
      };
    },
    nowMs: () => 1_700_000_460_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-actions/actions?targetSequenceId=42&targetActionId=6f6238a9-f035-4a8f-b05b-ac33507f772a&limit=500",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok_actions");
});

test("Unit session sync: fetchSessionUsageLedger hits scoped usage endpoint with bounded limit", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await fetchSessionUsageLedger("sess-usage", {
    limit: 999,
    resolveAuthSession: async () => ({
      token: "tok_usage",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "sess-usage",
          usageLedger: {
            totals: {
              entries: 1,
              inputTokens: 12,
              outputTokens: 3,
              totalTokens: 15,
              providerCostUsd: 0.001,
              customerCostUsd: 0.002,
              hasCustomerCost: true,
            },
            entries: [{ ledgerEntryId: "bill_usage", totalTokens: 15 }],
          },
        }),
      };
    },
    nowMs: () => 1_700_000_465_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.payload.sessionId, "sess-usage");
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-usage/usage?limit=500",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok_usage");
});

test("Unit session sync: createSessionMessageAction posts idempotent action payload", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await createSessionMessageAction("sess-actions", {
    actionType: "reply",
    targetSequenceId: 42,
    targetActionId: "6f6238a9-f035-4a8f-b05b-ac33507f772a",
    note: "taking this",
    idempotencyKey: "reply-42",
    metadata: { source: "unit" },
    resolveAuthSession: async () => ({
      token: "tok_actions",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          duplicate: false,
          action: { id: "act-1", actionType: "reply", targetSequenceId: 42 },
        }),
      };
    },
    nowMs: () => 1_700_000_470_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action.id, "act-1");
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-actions/actions",
  );
  assert.equal(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    actionType: "reply",
    targetSequenceId: 42,
    targetActionId: "6f6238a9-f035-4a8f-b05b-ac33507f772a",
    note: "taking this",
    metadata: { source: "unit" },
    idempotencyKey: "reply-42",
  });
});

test("Unit session sync: createSessionMessageAction times out a stalled response body", async () => {
  resetSessionSyncStateForTests();
  const startedAt = Date.now();
  const result = await createSessionMessageAction("sess-actions-hang", {
    actionType: "view",
    targetSequenceId: 42,
    metadata: { source: "unit" },
    resolveAuthSession: async () => ({
      token: "tok_actions",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => new Promise(() => {}),
    }),
    timeoutMs: 25,
    nowMs: () => 1_700_000_470_100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "response_body_timeout");
  assert.equal(result.action, null);
  assert.ok(Date.now() - startedAt < 1_000, "stalled response body must be bounded");
});

test("Unit session sync: createSessionMessageAction does not wait on stalled error bodies", async () => {
  resetSessionSyncStateForTests();
  const startedAt = Date.now();
  const result = await createSessionMessageAction("sess-actions-error-body-hang", {
    actionType: "view",
    targetSequenceId: 42,
    metadata: { source: "unit" },
    resolveAuthSession: async () => ({
      token: "tok_actions",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => new Promise(() => {}),
    }),
    timeoutMs: 1_000,
    nowMs: () => 1_700_000_470_200,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "api_500");
  assert.equal(result.action, null);
  assert.ok(Date.now() - startedAt < 500, "non-OK response bodies must not delay status handling");
});

test("Unit session sync: searchSessionEvents calls durable search endpoint", async () => {
  resetSessionSyncStateForTests();
  const calls = [];
  const result = await searchSessionEvents("sess-search", {
    query: "checkpoint",
    beforeSequence: 100,
    limit: 99,
    resolveAuthSession: async () => ({
      token: "tok_search",
      apiUrl: "https://api.sentinelayer.com/",
    }),
    fetchImpl: async (url, options, timeoutMs) => {
      calls.push({ url, options, timeoutMs });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: "checkpoint",
          results: [{ sequenceId: 99, snippet: "checkpoint ready", event: {} }],
          count: 1,
          has_more: true,
          next_before_sequence: 99,
        }),
      };
    },
    nowMs: () => 1_700_000_480_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBeforeSequence, 99);
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-search/events/search?q=checkpoint&beforeSequence=100&limit=50",
  );
  assert.equal(calls[0].options.method, "GET");
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

// PR fix(session): auto-grant agent identity on 403 IDENTITY_FORGERY and retry.
// Carter hit IDENTITY_FORGERY in prod after PR #478 deployed server-side
// agent-identity enforcement: every CLI agent post returned 403 with code
// IDENTITY_FORGERY because the active user had not granted that agent.id.
// These tests pin the auto-grant + retry behaviour, the failure branch, the
// loop-breaker, and the fast path so a future regression is loud.

function buildIdentityForgeryEventEnvelope({ agentId = "codex", role = "coder" } = {}) {
  return {
    event: "session_message",
    sessionId: "sess-grant-1",
    agent: { id: agentId, role },
    payload: { message: "agent post" },
  };
}

function makeJsonResponse({ ok, status, body = null }) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test("Unit session sync: 403 IDENTITY_FORGERY auto-grants and retries successfully", async () => {
  resetSessionSyncStateForTests();
  __resetAutoGrantCacheForTests();
  const calls = [];
  const responses = [
    // First /events POST -> 403 IDENTITY_FORGERY
    makeJsonResponse({
      ok: false,
      status: 403,
      body: {
        error: { code: "IDENTITY_FORGERY", message: "agent identity 'codex' is not granted to this user" },
      },
    }),
    // POST /agent-grants -> 200 OK
    makeJsonResponse({ ok: true, status: 200, body: { granted: true } }),
    // Retry /events -> 200 OK
    makeJsonResponse({ ok: true, status: 202 }),
  ];
  const result = await syncSessionEventToApi(
    "sess-grant-1",
    buildIdentityForgeryEventEnvelope({ agentId: "codex", role: "coder" }),
    {
      resolveAuthSession: async () => ({
        token: "tok_test_grant",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method, body: options.body });
        return responses.shift();
      },
      nowMs: () => 1_700_000_700_000,
    }
  );

  assert.equal(result.synced, true, "expected synced=true after grant + retry");
  assert.equal(result.autoGranted, true);
  assert.equal(calls.length, 3, "expected 3 calls: events, grant, events-retry");
  assert.equal(calls[0].url, "https://api.sentinelayer.com/api/v1/sessions/sess-grant-1/events");
  assert.equal(calls[1].url, "https://api.sentinelayer.com/api/v1/sessions/agent-grants");
  assert.equal(calls[1].method, "POST");
  const grantBody = JSON.parse(calls[1].body);
  assert.equal(grantBody.agent_id, "codex");
  assert.equal(grantBody.role, "coder");
  assert.equal(calls[2].url, "https://api.sentinelayer.com/api/v1/sessions/sess-grant-1/events");
  resetSessionSyncStateForTests();
});

test("Unit session sync: 403 IDENTITY_FORGERY -> grant 422 returns grant_failed_422 with no retry", async () => {
  resetSessionSyncStateForTests();
  __resetAutoGrantCacheForTests();
  const calls = [];
  const responses = [
    makeJsonResponse({
      ok: false,
      status: 403,
      body: { error: { code: "IDENTITY_FORGERY", message: "denied" } },
    }),
    // Grant returns 422 (e.g. invalid agent_id payload)
    makeJsonResponse({
      ok: false,
      status: 422,
      body: { error: { code: "INVALID_AGENT_ID", message: "bad shape" } },
    }),
  ];
  const result = await syncSessionEventToApi(
    "sess-grant-2",
    buildIdentityForgeryEventEnvelope({ agentId: "claude", role: "coder" }),
    {
      resolveAuthSession: async () => ({
        token: "tok_test_grant",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method });
        return responses.shift();
      },
      nowMs: () => 1_700_000_700_100,
    }
  );

  assert.equal(result.synced, false);
  assert.equal(result.reason, "grant_failed_422");
  assert.equal(calls.length, 2, "expected 2 calls: events + grant; NO retry");
  assert.equal(calls[1].url, "https://api.sentinelayer.com/api/v1/sessions/agent-grants");
  resetSessionSyncStateForTests();
});

test("Unit session sync: 403 IDENTITY_FORGERY for already-granted agentId does not re-grant", async () => {
  resetSessionSyncStateForTests();
  __resetAutoGrantCacheForTests();

  // First call seeds the auto-grant cache: 403 -> grant 200 -> retry 200.
  const firstCalls = [];
  const firstResponses = [
    makeJsonResponse({
      ok: false,
      status: 403,
      body: { error: { code: "IDENTITY_FORGERY", message: "denied" } },
    }),
    makeJsonResponse({ ok: true, status: 200 }),
    makeJsonResponse({ ok: true, status: 202 }),
  ];
  const firstResult = await syncSessionEventToApi(
    "sess-grant-3",
    buildIdentityForgeryEventEnvelope({ agentId: "gemini", role: "coder" }),
    {
      resolveAuthSession: async () => ({
        token: "tok_test_grant",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        firstCalls.push({ url, method: options.method });
        return firstResponses.shift();
      },
      nowMs: () => 1_700_000_700_200,
    }
  );
  assert.equal(firstResult.synced, true);
  assert.equal(firstCalls.length, 3);

  // Second call for the same agentId: server still returns 403 (e.g.
  // grant did not actually persist). We must NOT loop on grant.
  const secondCalls = [];
  const secondResult = await syncSessionEventToApi(
    "sess-grant-3",
    buildIdentityForgeryEventEnvelope({ agentId: "gemini", role: "coder" }),
    {
      resolveAuthSession: async () => ({
        token: "tok_test_grant",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        secondCalls.push({ url, method: options.method });
        return makeJsonResponse({
          ok: false,
          status: 403,
          body: { error: { code: "IDENTITY_FORGERY", message: "still denied" } },
        });
      },
      nowMs: () => 1_700_000_700_300,
    }
  );
  assert.equal(secondResult.synced, false);
  assert.equal(secondResult.reason, "api_403");
  assert.equal(
    secondCalls.length,
    1,
    "loop-breaker: second 403 for cached agentId must NOT issue another grant"
  );
  assert.equal(secondCalls[0].url, "https://api.sentinelayer.com/api/v1/sessions/sess-grant-3/events");
  resetSessionSyncStateForTests();
});

test("Unit session sync: 200 on first attempt preserves fast path (no grant call)", async () => {
  resetSessionSyncStateForTests();
  __resetAutoGrantCacheForTests();
  const calls = [];
  const result = await syncSessionEventToApi(
    "sess-grant-4",
    buildIdentityForgeryEventEnvelope({ agentId: "codex", role: "coder" }),
    {
      resolveAuthSession: async () => ({
        token: "tok_test_grant",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method });
        return { ok: true, status: 202 };
      },
      nowMs: () => 1_700_000_700_400,
    }
  );

  assert.equal(result.synced, true);
  assert.equal(result.autoGranted, undefined, "fast path must not flag autoGranted");
  assert.equal(calls.length, 1, "fast path: exactly one /events POST, no grant");
  assert.equal(calls[0].url, "https://api.sentinelayer.com/api/v1/sessions/sess-grant-4/events");
  resetSessionSyncStateForTests();
});

test("Unit session sync: 403 IDENTITY_FORGERY with reserved agentId (cli-user) skips grant", async () => {
  resetSessionSyncStateForTests();
  __resetAutoGrantCacheForTests();
  const calls = [];
  const result = await syncSessionEventToApi(
    "sess-grant-5",
    buildIdentityForgeryEventEnvelope({ agentId: "cli-user", role: "coder" }),
    {
      resolveAuthSession: async () => ({
        token: "tok_test_grant",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method });
        return makeJsonResponse({
          ok: false,
          status: 403,
          body: { error: { code: "IDENTITY_FORGERY", message: "denied" } },
        });
      },
      nowMs: () => 1_700_000_700_500,
    }
  );
  assert.equal(result.synced, false);
  assert.equal(result.reason, "api_403");
  assert.equal(calls.length, 1, "reserved agent id must NOT trigger grant");
  resetSessionSyncStateForTests();
});

test("Unit session sync: orchestrator role is normalized to 'coder' in grant payload", async () => {
  resetSessionSyncStateForTests();
  __resetAutoGrantCacheForTests();
  const calls = [];
  const responses = [
    makeJsonResponse({
      ok: false,
      status: 403,
      body: { error: { code: "IDENTITY_FORGERY", message: "denied" } },
    }),
    makeJsonResponse({ ok: true, status: 200 }),
    makeJsonResponse({ ok: true, status: 202 }),
  ];
  const result = await syncSessionEventToApi(
    "sess-grant-6",
    buildIdentityForgeryEventEnvelope({ agentId: "kai-chen", role: "orchestrator" }),
    {
      resolveAuthSession: async () => ({
        token: "tok_test_grant",
        apiUrl: "https://api.sentinelayer.com",
      }),
      fetchImpl: async (url, options) => {
        calls.push({ url, body: options.body });
        return responses.shift();
      },
      nowMs: () => 1_700_000_700_600,
    }
  );
  assert.equal(result.synced, true);
  const grantBody = JSON.parse(calls[1].body);
  assert.equal(grantBody.role, "coder", "orchestrator must fall back to coder pending API enum extension");
  resetSessionSyncStateForTests();
});
