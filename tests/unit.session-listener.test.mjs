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
