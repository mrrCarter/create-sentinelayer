import test from "node:test";
import assert from "node:assert/strict";

import { fetchSessionPinnedMessages } from "../src/session/sync.js";

function actionsStub(projection) {
  return async () => ({ ok: true, reason: "", actions: [], count: 0, projection });
}

// Map of targetSequenceId -> event returned by the /events/before lookup.
function eventsBeforeStub(bySequence) {
  return async (_sessionId, { beforeSequence }) => {
    const seq = Number(beforeSequence) - 1;
    const event = bySequence[seq];
    return event
      ? { ok: true, reason: "", events: [event], cursor: null, beforeSequence: null }
      : { ok: true, reason: "", events: [], cursor: null, beforeSequence: null };
  };
}

test("Unit session pins: resolves pinned messages with author and content", async () => {
  const projection = {
    pinLimit: 10,
    pinnedMessages: [
      {
        targetSequenceId: 24321,
        targetCursor: "0000000024321:00005f01",
        actorId: "human-mrrcarter",
        actorKind: "human",
        createdAt: "2026-05-28T18:05:00.000Z",
      },
      {
        targetSequenceId: 14633,
        targetCursor: "0000000014633:00003929",
        actorId: "claude-mythos",
        actorKind: "agent",
        createdAt: "2026-05-27T10:00:00.000Z",
      },
    ],
  };
  const events = {
    24321: { sequenceId: 24321, agent: { id: "human-mrrcarter" }, payload: { message: "Few things I need help with..." } },
    14633: { sequenceId: 14633, agent: { id: "codex" }, payload: { note: "auto-scroll fix landed" } },
  };

  const result = await fetchSessionPinnedMessages("sess-1", {
    listActions: actionsStub(projection),
    fetchEventsBefore: eventsBeforeStub(events),
  });

  assert.equal(result.ok, true);
  assert.equal(result.pinLimit, 10);
  assert.equal(result.count, 2);

  const first = result.pins[0];
  assert.equal(first.targetSequenceId, 24321);
  assert.equal(first.author, "human-mrrcarter");
  assert.equal(first.content, "Few things I need help with...");
  assert.equal(first.pinnedBy, "human-mrrcarter");
  assert.equal(first.resolved, true);

  const second = result.pins[1];
  assert.equal(second.author, "codex");
  assert.equal(second.content, "auto-scroll fix landed");
  assert.equal(second.resolved, true);
});

test("Unit session pins: no pins returns an empty, ok result", async () => {
  const result = await fetchSessionPinnedMessages("sess-empty", {
    listActions: actionsStub({ pinLimit: 10, pinnedMessages: [] }),
    fetchEventsBefore: eventsBeforeStub({}),
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.deepEqual(result.pins, []);
});

test("Unit session pins: unresolvable content still lists the pin (resolved=false)", async () => {
  const projection = {
    pinLimit: 10,
    pinnedMessages: [
      { targetSequenceId: 999, actorId: "claude-mythos", actorKind: "agent", createdAt: "2026-05-28T00:00:00.000Z" },
    ],
  };
  const result = await fetchSessionPinnedMessages("sess-miss", {
    listActions: actionsStub(projection),
    fetchEventsBefore: eventsBeforeStub({}), // sequence 999 not found
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.pins[0].targetSequenceId, 999);
  assert.equal(result.pins[0].resolved, false);
  assert.equal(result.pins[0].content, "");
  assert.equal(result.pins[0].pinnedBy, "claude-mythos");
});

test("Unit session pins: propagates the actions-read failure", async () => {
  const result = await fetchSessionPinnedMessages("sess-fail", {
    listActions: async () => ({ ok: false, reason: "api_403", projection: null }),
    fetchEventsBefore: eventsBeforeStub({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "api_403");
  assert.deepEqual(result.pins, []);
});

test("Unit session pins: invalid session id is rejected", async () => {
  const result = await fetchSessionPinnedMessages("", {
    listActions: actionsStub({ pinLimit: 10, pinnedMessages: [] }),
    fetchEventsBefore: eventsBeforeStub({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_session_id");
});
