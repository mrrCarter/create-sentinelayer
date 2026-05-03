import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeSessionEvents,
  sessionEventHasKnownIdentity,
  addSessionEventIdentityKeys,
} from "../src/session/event-identity.js";

test("Unit session event identity: dedupes local optimistic and API canonical shapes", () => {
  const local = {
    stream: "sl_event",
    event: "session_message",
    agent: { id: "codex", model: "gpt-5-codex" },
    payload: {
      message: "status: already local - Codex",
      channel: "session",
      source: "agent",
      clientKind: "cli",
    },
    sessionId: "sess-1",
    ts: "2026-05-03T13:08:14.291Z",
    timestamp: "2026-05-03T13:08:14.291Z",
  };
  const remote = {
    ...local,
    payload: {
      ...local.payload,
      messageId: "remote-message-id",
    },
    ts: "2026-05-03T13:08:14.291000+00:00",
    timestamp: "2026-05-03T13:08:14.291000+00:00",
    cursor: "1777813694291:abae137b",
    eventId: "remote-event-id",
    idempotencyToken: "remote-event-id",
    sequenceId: 123,
  };

  const deduped = dedupeSessionEvents([local, remote]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].cursor, "1777813694291:abae137b");
  assert.equal(deduped[0].payload.messageId, "remote-message-id");
});

test("Unit session event identity: keeps same text from different agents separate", () => {
  const base = {
    stream: "sl_event",
    event: "session_message",
    payload: {
      message: "same status text",
      channel: "session",
      source: "agent",
    },
    ts: "2026-05-03T13:08:14.291Z",
  };

  const deduped = dedupeSessionEvents([
    { ...base, agent: { id: "codex" } },
    { ...base, agent: { id: "claude" } },
  ]);

  assert.equal(deduped.length, 2);
});

test("Unit session event identity: keeps distinct id-only events separate", () => {
  const deduped = dedupeSessionEvents([
    { id: "1", event: "session_message" },
    { id: "2", event: "session_message" },
  ]);

  assert.equal(deduped.length, 2);
});

test("Unit session event identity: known-key set recognizes alternate identity keys", () => {
  const known = new Set();
  const local = {
    stream: "sl_event",
    event: "session_message",
    agent: { id: "codex" },
    payload: {
      message: "known content",
      channel: "session",
      source: "agent",
    },
    ts: "2026-05-03T13:08:14.291Z",
  };
  const remote = {
    ...local,
    cursor: "cursor-1",
    eventId: "event-1",
    ts: "2026-05-03T13:08:14.291000+00:00",
  };

  addSessionEventIdentityKeys(known, local);

  assert.equal(sessionEventHasKnownIdentity(remote, known), true);
});
