import test from "node:test";
import assert from "node:assert/strict";

import { listenSessionEvents } from "../src/session/listener.js";

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

test("Fault injection listener: malformed records are skipped while valid events advance", async () => {
  const emitted = [];

  const result = await listenSessionEvents({
    sessionId: "fault-malformed-records",
    agentId: "codex-1",
    replay: true,
    maxPolls: 1,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => ({
      ok: true,
      events: [
        undefined,
        null,
        "not-an-event",
        42,
        { event: "session_message", payload: { to: "claude-1" } },
        evt("c1", { to: "codex-1" }),
      ],
      cursor: "c1",
    }),
    _sleep: async () => {},
    onEvent: async (event) => emitted.push(event.cursor),
  });

  assert.deepEqual(emitted, ["c1"]);
  assert.equal(result.cursor, "c1");
  assert.equal(result.emitted, 1);
});

test("Fault injection listener: rejected event handler propagates and emits stopped lifecycle", async () => {
  const lifecycle = [];

  await assert.rejects(
    listenSessionEvents({
      sessionId: "fault-callback-rejects",
      agentId: "codex-1",
      replay: true,
      maxPolls: 1,
      _readCursor: async () => null,
      _writeCursor: async () => ({ written: true }),
      _poll: async () => ({ ok: true, events: [evt("c1", { to: "codex-1" })], cursor: "c1" }),
      _sleep: async () => {},
      onLifecycle: async (event) => lifecycle.push(event),
      onEvent: async () => {
        throw new Error("handler failed");
      },
    }),
    /handler failed/,
  );

  assert.deepEqual(
    lifecycle.map((event) => event.type),
    ["started", "stopped"],
  );
  assert.equal(lifecycle.at(-1).cursor, null);
});

test("Fault injection listener: abort during idle sleep exits without retry leak", async () => {
  const ac = new AbortController();
  const lifecycle = [];

  const result = await listenSessionEvents({
    sessionId: "fault-abort-during-sleep",
    agentId: "codex-1",
    intervalSeconds: 60,
    signal: ac.signal,
    _readCursor: async () => null,
    _writeCursor: async () => ({ written: true }),
    _poll: async () => ({ ok: true, events: [], cursor: null }),
    _sleep: async () => {
      ac.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
    onLifecycle: async (event) => lifecycle.push(event),
  });

  assert.equal(result.pollCount, 1);
  assert.equal(result.emitted, 0);
  assert.deepEqual(
    lifecycle.map((event) => event.type),
    ["started", "heartbeat", "stopped"],
  );
  assert.equal(lifecycle.at(-1).aborted, true);
});
