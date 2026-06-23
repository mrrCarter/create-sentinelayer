import test from "node:test";
import assert from "node:assert/strict";

import {
  eventMatchesAgent,
  listenCursorSuffix,
  listenSessionEvents,
} from "../src/session/listener.js";

function evt(cursor, payload = {}, extra = {}) {
  return {
    stream: "sl_event",
    event: "session_message",
    cursor,
    agent: { id: "peer" },
    payload: {
      message: `message-${cursor}`,
      ...payload,
    },
    ...extra,
  };
}

test("Unit session listener: eventMatchesAgent accepts direct payload recipients", () => {
  assert.equal(eventMatchesAgent(evt("c1", { to: "codex-1" }), "codex-1"), true);
  assert.equal(eventMatchesAgent(evt("c2", { to: ["claude-1", "codex-1"] }), "codex-1"), true);
  assert.equal(eventMatchesAgent(evt("c3", {}, { to: "codex-1" }), "codex-1"), true);
  assert.equal(eventMatchesAgent(evt("c4", { to: "claude-1" }), "codex-1"), false);
});

test("Unit session listener: eventMatchesAgent accepts broadcast forms", () => {
  assert.equal(eventMatchesAgent(evt("c1"), "codex-1"), true);
  assert.equal(eventMatchesAgent(evt("c2", { to: "*" }), "codex-1"), true);
  assert.equal(eventMatchesAgent(evt("c3", { broadcast: true }), "codex-1"), true);
  assert.equal(eventMatchesAgent(evt("c4", { to: "broadcast" }), "codex-1"), true);
});

test("Unit session listener: cursor suffix is stable and file-safe", () => {
  assert.equal(listenCursorSuffix("Codex 1"), "listen-codex-1");
  assert.equal(listenCursorSuffix(""), "listen-agent");
});

test("Unit session listener: emits bounded lifecycle snapshots", async () => {
  let nowMs = Date.parse("2026-05-24T20:00:00.000Z");
  const lifecycle = [];
  const sleeps = [];
  const batches = [
    { ok: true, events: [], cursor: null },
    { ok: true, events: [evt("c1", { to: "codex-1" })], cursor: "c1" },
  ];

  const result = await listenSessionEvents({
    sessionId: "sess-life",
    agentId: "codex-1",
    intervalSeconds: 60,
    maxPolls: 2,
    _nowMs: () => nowMs,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => batches.shift(),
    _sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    onEvent: async () => {},
    onLifecycle: async (event) => lifecycle.push(event),
  });

  assert.deepEqual(
    lifecycle.map((event) => event.type),
    ["started", "heartbeat", "heartbeat", "stopped"],
  );
  assert.equal(lifecycle[0].sessionId, "sess-life");
  assert.equal(lifecycle[0].agentId, "codex-1");
  assert.equal(lifecycle[0].cursorSuffix, "listen-codex-1");
  assert.equal(lifecycle[1].nextPollMs, 60_000);
  assert.equal(lifecycle[2].cursor, "c1");
  assert.equal(lifecycle[2].stopping, true);
  assert.equal(lifecycle[3].cursor, "c1");
  assert.deepEqual(sleeps, [60_000]);
  assert.equal(result.cursor, "c1");
});

test("Unit session listener: auto transport consumes stream before polling fallback", async () => {
  const emitted = [];
  const writes = [];
  const pollCalls = [];
  const streamCalls = [];

  const result = await listenSessionEvents({
    sessionId: "sess-stream-first",
    agentId: "codex-1",
    transport: "auto",
    replay: true,
    maxPolls: 1,
    _readCursor: async () => null,
    _writeCursor: async (sessionId, cursor, options) => {
      writes.push({ sessionId, cursor, options });
      return { written: true };
    },
    _stream: async (sessionId, options) => {
      streamCalls.push({ sessionId, since: options.since });
      await options.onHeartbeat();
      await options.onEvent(evt("c1", { to: "codex-1" }));
      return { ok: true, reason: "", cursor: "c1", eventCount: 1, errorCount: 0 };
    },
    _poll: async (sessionId, options) => {
      pollCalls.push({ sessionId, since: options.since });
      return { ok: true, events: [], cursor: "c1" };
    },
    _sleep: async () => {},
    onEvent: async (event) => emitted.push(event.cursor),
  });

  assert.deepEqual(streamCalls, [{ sessionId: "sess-stream-first", since: null }]);
  assert.deepEqual(pollCalls, [{ sessionId: "sess-stream-first", since: "c1" }]);
  assert.deepEqual(emitted, ["c1"]);
  assert.deepEqual(writes.map((write) => write.cursor), ["c1"]);
  assert.equal(result.streamAttempted, true);
  assert.equal(result.streamFallbackReason, "stream_closed");
  assert.equal(result.transport, "poll");
  assert.equal(result.cursor, "c1");
});

test("Unit session listener: auto transport falls back to durable polling when stream fails", async () => {
  const emitted = [];
  const errors = [];

  const result = await listenSessionEvents({
    sessionId: "sess-stream-fallback",
    agentId: "codex-1",
    transport: "auto",
    replay: true,
    maxPolls: 1,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _stream: async () => ({ ok: false, reason: "api_404", cursor: null, eventCount: 0, errorCount: 0 }),
    _poll: async (sessionId, options) => {
      assert.equal(options.since, null);
      return { ok: true, events: [evt("c1", { to: "codex-1" })], cursor: "c1" };
    },
    _sleep: async () => {},
    onError: async (error) => errors.push(error.reason),
    onEvent: async (event) => emitted.push(event.cursor),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(emitted, ["c1"]);
  assert.equal(result.streamAttempted, true);
  assert.equal(result.streamFallbackReason, "api_404");
  assert.equal(result.cursor, "c1");
});

test("Unit session listener: advances across listener presence without emitting it", async () => {
  const emitted = [];
  const presenceEvent = evt(
    "c1",
    { source: "session_listen", listenerId: "listener-codex-1" },
    { event: "session_listener_heartbeat", agent: { id: "codex-1" } },
  );
  const messageEvent = evt("c2", { to: "codex-1" });

  const result = await listenSessionEvents({
    sessionId: "sess-presence-noise",
    agentId: "codex-1",
    replay: true,
    maxPolls: 1,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => ({ ok: true, events: [presenceEvent, messageEvent], cursor: "c2" }),
    _sleep: async () => {},
    onEvent: async (event) => emitted.push(event.event),
  });

  assert.deepEqual(emitted, ["session_message"]);
  assert.equal(result.cursor, "c2");
  assert.equal(result.emitted, 1);
});

test("Unit session listener: emits listener_stop directives while skipping lifecycle noise", async () => {
  const emitted = [];
  const heartbeat = evt(
    "c1",
    { source: "session_listen", listenerId: "listener-codex-1" },
    { event: "session_listener_heartbeat", agent: { id: "codex-1" } },
  );
  const stop = {
    event: "listener_stop",
    cursor: "c2",
    agent: { id: "session-control" },
    payload: { targetAgentId: "codex-1", reason: "operator_stop" },
  };

  const result = await listenSessionEvents({
    sessionId: "sess-stop-control",
    agentId: "codex-1",
    replay: true,
    maxPolls: 1,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => ({ ok: true, events: [heartbeat, stop], cursor: "c2" }),
    _sleep: async () => {},
    onEvent: async (event) => emitted.push(event.event),
  });

  assert.deepEqual(emitted, ["listener_stop"]);
  assert.equal(result.cursor, "c2");
  assert.equal(result.emitted, 1);
});

test("Unit session listener: advances cursor across nonmatching first poll and emits later matches", async () => {
  const writes = [];
  const emitted = [];
  const pollCalls = [];
  const batches = [
    {
      ok: true,
      events: [
        evt("c1", { to: "claude-1" }),
        evt("c2", { to: "*" }),
      ],
      cursor: "c2",
    },
    {
      ok: true,
      events: [
        evt("c3", { to: "codex-1" }),
        evt("c4"),
      ],
      cursor: "c4",
    },
  ];

  const result = await listenSessionEvents({
    sessionId: "sess-1",
    agentId: "codex-1",
    intervalSeconds: 1,
    maxPolls: 2,
    _readCursor: async () => null,
    _writeCursor: async (sessionId, cursor, options) => {
      writes.push({ sessionId, cursor, options });
      return { written: true };
    },
    _poll: async (sessionId, options) => {
      pollCalls.push({ sessionId, options });
      return batches.shift();
    },
    _sleep: async () => {},
    onEvent: async (event) => {
      emitted.push(event.cursor);
    },
  });

  assert.deepEqual(pollCalls.map((call) => call.options.since), [null, "c2"]);
  assert.deepEqual(writes.map((write) => write.cursor), ["c2", "c4"]);
  assert.equal(writes[0].options.suffix, "listen-codex-1");
  assert.deepEqual(emitted, ["c3", "c4"]);
  assert.equal(result.emitted, 2);
  assert.equal(result.cursor, "c4");
});

test("Unit session listener: empty first poll primes listener so first new event is emitted", async () => {
  const emitted = [];
  const batches = [
    { ok: true, events: [], cursor: null },
    { ok: true, events: [evt("c1", { to: "codex-1" })], cursor: "c1" },
  ];

  const result = await listenSessionEvents({
    sessionId: "sess-empty",
    agentId: "codex-1",
    intervalSeconds: 1,
    maxPolls: 2,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => batches.shift(),
    _sleep: async () => {},
    onEvent: async (event) => {
      emitted.push(event.cursor);
    },
  });

  assert.deepEqual(emitted, ["c1"]);
  assert.equal(result.emitted, 1);
  assert.equal(result.cursor, "c1");
});

test("Unit session listener: empty poll at the same cursor is a quiet idle cycle", async () => {
  const errors = [];
  const writes = [];
  const emitted = [];

  const result = await listenSessionEvents({
    sessionId: "sess-idle",
    agentId: "codex-1",
    intervalSeconds: 1,
    maxPolls: 1,
    _readCursor: async () => "1779371147039:00002724",
    _writeCursor: async (sessionId, cursor, options) => {
      writes.push({ sessionId, cursor, options });
      return { written: true };
    },
    _poll: async (sessionId, options) => {
      assert.equal(options.since, "1779371147039:00002724");
      return { ok: true, events: [], cursor: "1779371147039:00002724" };
    },
    _sleep: async () => {},
    onError: async (error) => errors.push(error.reason),
    onEvent: async (event) => emitted.push(event.cursor),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(emitted, []);
  assert.equal(result.reason, "");
  assert.equal(result.cursor, "1779371147039:00002724");
});

test("Unit session listener: stale cursors are not persisted or re-emitted", async () => {
  const writes = [];
  const errors = [];
  const emitted = [];
  const staleEvent = evt("1779364717000:000026d2", { to: "codex-1" });
  const batches = [
    {
      ok: true,
      events: [staleEvent],
      cursor: "1779364717000:000026d2",
    },
    {
      ok: true,
      events: [staleEvent],
      cursor: "1779364717000:000026d2",
    },
  ];

  const result = await listenSessionEvents({
    sessionId: "sess-stale-cursor",
    agentId: "codex-1",
    intervalSeconds: 1,
    maxPolls: 2,
    replay: true,
    _readCursor: async () => "1779369999000:000026d3",
    _writeCursor: async (sessionId, cursor, options) => {
      writes.push({ sessionId, cursor, options });
      return { written: true };
    },
    _poll: async (sessionId, options) => {
      assert.equal(options.since, "1779369999000:000026d3");
      return batches.shift();
    },
    _sleep: async () => {},
    onError: async (error) => errors.push(error.reason),
    onEvent: async (event) => emitted.push(event.cursor),
  });

  assert.deepEqual(writes, []);
  assert.deepEqual(errors, ["cursor_not_advanced", "cursor_not_advanced"]);
  assert.deepEqual(emitted, []);
  assert.equal(result.cursor, "1779369999000:000026d3");
});

test("Unit session listener: reports stored-cursor catch-up before replaying old backlog", async () => {
  const catchups = [];
  const emitted = [];
  const oldEvent = evt(
    "1779364717000:000026d4",
    { to: "codex-1" },
    { ts: "2026-05-24T20:00:00.000Z" },
  );

  const result = await listenSessionEvents({
    sessionId: "sess-catchup",
    agentId: "codex-1",
    maxPolls: 1,
    _nowMs: () => Date.parse("2026-05-24T21:00:00.000Z"),
    _readCursor: async () => "1779364717000:000026d3",
    _writeCursor: async () => ({ written: true }),
    _poll: async (sessionId, options) => {
      assert.equal(options.since, "1779364717000:000026d3");
      return { ok: true, events: [oldEvent], cursor: "1779364717000:000026d4" };
    },
    _sleep: async () => {},
    onCatchup: async (catchup) => catchups.push(catchup),
    onEvent: async (event) => emitted.push(event.cursor),
  });

  assert.deepEqual(emitted, ["1779364717000:000026d4"]);
  assert.equal(catchups.length, 1);
  assert.equal(catchups[0].cursorSource, "stored");
  assert.equal(catchups[0].cursor, "1779364717000:000026d3");
  assert.equal(catchups[0].candidateCursor, "1779364717000:000026d4");
  assert.equal(catchups[0].eventCount, 1);
  assert.equal(catchups[0].matchingEventCount, 1);
  assert.equal(catchups[0].preStartEventCount, 1);
  assert.equal(catchups[0].oldestEventAt, "2026-05-24T20:00:00.000Z");
  assert.equal(result.catchupNotified, true);
  assert.equal(result.catchupEventCount, 1);
  assert.equal(result.catchupMatchingEventCount, 1);
});

test("Unit session listener: fromNow primes and persists the latest cursor before polling", async () => {
  const writes = [];
  const pollCalls = [];

  const result = await listenSessionEvents({
    sessionId: "sess-from-now",
    agentId: "codex-1",
    fromNow: true,
    persistStartCursor: true,
    maxPolls: 1,
    _readCursor: async () => "1779364717000:000026d3",
    _writeCursor: async (sessionId, cursor, options) => {
      writes.push({ sessionId, cursor, options });
      return { written: true };
    },
    _pollLatest: async (sessionId, options) => {
      assert.equal(sessionId, "sess-from-now");
      assert.equal(options.limit, 1);
      return { ok: true, events: [evt("1779369999000:000026d9")], cursor: "1779369999000:000026d9" };
    },
    _poll: async (sessionId, options) => {
      pollCalls.push({ sessionId, options });
      return { ok: true, events: [], cursor: "1779369999000:000026d9" };
    },
    _sleep: async () => {},
  });

  assert.deepEqual(writes.map((write) => write.cursor), ["1779369999000:000026d9"]);
  assert.equal(writes[0].options.suffix, "listen-codex-1");
  assert.deepEqual(pollCalls.map((call) => call.options.since), ["1779369999000:000026d9"]);
  assert.equal(result.cursorSource, "from_now");
  assert.equal(result.cursor, "1779369999000:000026d9");
  assert.equal(result.persistedCursor, true);
  assert.equal(result.catchupNotified, false);
});

test("Unit session listener: fromNow force-probes latest cursor through open inbound circuit", async () => {
  const latestCalls = [];

  const result = await listenSessionEvents({
    sessionId: "sess-from-now-circuit",
    agentId: "codex-1",
    fromNow: true,
    persistStartCursor: true,
    maxPolls: 1,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _pollLatest: async (sessionId, options) => {
      latestCalls.push({ sessionId, options });
      if (!options.forceCircuitProbe) {
        return { ok: false, reason: "circuit_breaker_open", events: [], cursor: null };
      }
      return { ok: true, events: [evt("1779369999000:000026e0")], cursor: "1779369999000:000026e0" };
    },
    _poll: async (sessionId, options) => {
      assert.equal(options.since, "1779369999000:000026e0");
      return { ok: true, events: [], cursor: "1779369999000:000026e0" };
    },
    _sleep: async () => {},
  });

  assert.equal(latestCalls.length, 1);
  assert.equal(latestCalls[0].sessionId, "sess-from-now-circuit");
  assert.equal(latestCalls[0].options.forceCircuitProbe, true);
  assert.equal(result.cursorSource, "from_now");
  assert.equal(result.cursor, "1779369999000:000026e0");
  assert.equal(result.reason, "");
});

test("Unit session listener: first poll emits matching events created after listener start", async () => {
  const emitted = [];
  const oldEvent = evt("old", { to: "codex-1" });
  oldEvent.ts = "2026-04-28T04:00:00.000Z";
  const newEvent = evt("new", { to: "codex-1" });
  newEvent.ts = "2026-04-28T04:00:01.000Z";

  const result = await listenSessionEvents({
    sessionId: "sess-race",
    agentId: "codex-1",
    maxPolls: 1,
    _nowMs: () => Date.parse("2026-04-28T04:00:00.500Z"),
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => ({ ok: true, events: [oldEvent, newEvent], cursor: "new" }),
    _sleep: async () => {},
    onEvent: async (event) => {
      emitted.push(event.cursor);
    },
  });

  assert.deepEqual(emitted, ["new"]);
  assert.equal(result.emitted, 1);
});

test("Unit session listener: reports poll failures and keeps looping", async () => {
  const errors = [];
  const emitted = [];
  const batches = [
    { ok: false, reason: "api_503", events: [], cursor: null },
    { ok: true, events: [evt("c1", { to: "codex-1" })], cursor: "c1" },
  ];

  const result = await listenSessionEvents({
    sessionId: "sess-errors",
    agentId: "codex-1",
    intervalSeconds: 1,
    maxPolls: 2,
    replay: true,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => batches.shift(),
    _sleep: async () => {},
    onError: async (error) => errors.push(error.reason),
    onEvent: async (event) => emitted.push(event.cursor),
  });

  assert.deepEqual(errors, ["api_503"]);
  assert.deepEqual(emitted, ["c1"]);
  assert.equal(result.reason, "");
});

test("Unit session listener: recent human activity switches to active cadence", async () => {
  let nowMs = Date.parse("2026-05-03T12:00:00.000Z");
  const sleeps = [];
  const batches = [
    {
      ok: true,
      events: [
        evt(
          "c1",
          { source: "human", to: "codex-1" },
          { agent: { id: "human-carter", model: "human" }, ts: "2026-05-03T11:59:59.000Z" },
        ),
      ],
      cursor: "c1",
    },
    { ok: true, events: [], cursor: "c1" },
  ];

  const result = await listenSessionEvents({
    sessionId: "sess-active",
    agentId: "codex-1",
    intervalSeconds: 60,
    activeIntervalSeconds: 5,
    activeWindowSeconds: 300,
    maxPolls: 2,
    _nowMs: () => nowMs,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => batches.shift(),
    _sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });

  assert.deepEqual(sleeps, [5_000]);
  assert.equal(result.lastSleepMs, 5_000);
  assert.equal(result.lastHumanActivityAt, "2026-05-03T11:59:59.000Z");
});

test("Unit session listener: agent-only traffic keeps the idle cadence", async () => {
  const sleeps = [];
  const batches = [
    {
      ok: true,
      events: [
        evt(
          "c1",
          { source: "agent", to: "codex-1" },
          { agent: { id: "claude-verifier", model: "claude-opus-4-7" }, ts: "2026-05-03T12:00:00.000Z" },
        ),
      ],
      cursor: "c1",
    },
    { ok: true, events: [], cursor: "c1" },
  ];

  const result = await listenSessionEvents({
    sessionId: "sess-idle",
    agentId: "codex-1",
    intervalSeconds: 60,
    activeIntervalSeconds: 5,
    maxPolls: 2,
    _nowMs: () => Date.parse("2026-05-03T12:00:00.000Z"),
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => batches.shift(),
    _sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.deepEqual(sleeps, [60_000]);
  assert.equal(result.lastHumanActivityAt, null);
});

test("Unit session listener: active cadence expires back to idle", async () => {
  let nowMs = Date.parse("2026-05-03T12:00:00.000Z");
  const sleeps = [];
  const batches = [
    {
      ok: true,
      events: [
        evt(
          "c1",
          { source: "human", to: "codex-1" },
          { agent: { id: "human-carter", model: "human" }, ts: "2026-05-03T12:00:00.000Z" },
        ),
      ],
      cursor: "c1",
    },
    { ok: true, events: [], cursor: "c1" },
    { ok: true, events: [], cursor: "c1" },
    { ok: true, events: [], cursor: "c1" },
  ];

  await listenSessionEvents({
    sessionId: "sess-expire",
    agentId: "codex-1",
    intervalSeconds: 60,
    activeIntervalSeconds: 1,
    activeWindowSeconds: 1,
    maxPolls: 4,
    _nowMs: () => nowMs,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => batches.shift(),
    _sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });

  assert.deepEqual(sleeps, [1_000, 1_000, 60_000]);
});
