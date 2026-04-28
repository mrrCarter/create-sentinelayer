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
