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

test("Unit session event identity: clientMessageId links optimistic local and canonical remote rows", () => {
  const known = new Set();
  const local = {
    event: "session_message",
    eventId: "cli-123",
    idempotencyToken: "cli-123",
    agent: { id: "codex" },
    payload: {
      message: "same logical post",
      channel: "session",
      clientMessageId: "cli-123",
    },
    ts: "2026-06-23T21:29:09.842Z",
  };
  const remote = {
    event: "session_message",
    cursor: "0000000101541:00018ca5",
    sequenceId: 101541,
    agent: { id: "codex" },
    payload: {
      message: "same logical post",
      channel: "session",
      clientMessageId: "cli-123",
    },
    ts: "2026-06-23T21:29:09.842000+00:00",
  };

  addSessionEventIdentityKeys(known, local);
  const deduped = dedupeSessionEvents([local, remote]);

  assert.equal(sessionEventHasKnownIdentity(remote, known), true);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].sequenceId, 101541);
  assert.equal(deduped[0].cursor, "0000000101541:00018ca5");
});

test("Unit session event identity: dedupes action events by durable action id", () => {
  const actionId = "166cf548-5dab-4987-92b5-64c535f1422c";
  const targetActionId = "ab044a13-7710-47cf-b061-1c468c6acfba";
  const localEcho = {
    event: "session_action",
    eventId: `session-action-${actionId}`,
    idempotencyToken: `session-action:${actionId}`,
    cursor: `action:${actionId}`,
    agent: { id: "codex" },
    payload: {
      actionId,
      actionType: "view",
      targetSequenceId: 11143,
      targetActionId,
      message: "view on reply action ab044a13 under #11143",
      source: "session_action",
    },
    ts: "2026-05-23T17:16:28.081Z",
  };
  const remoteMaterialized = {
    event: "session_action",
    eventId: "remote-event-id",
    idempotencyToken: "remote-event-id",
    cursor: "1779556588081:remote",
    agent: { id: "codex" },
    payload: {
      actionId,
      actionType: "view",
      targetSequenceId: 11143,
      message: "view #11143",
      source: "session_action",
    },
    ts: "2026-05-23T17:16:28.081000+00:00",
  };
  const projection = {
    ...localEcho,
    eventId: `session-action-${actionId}`,
    idempotencyToken: `session-action:${actionId}:projection`,
    cursor: `action:${actionId}`,
  };

  const deduped = dedupeSessionEvents([localEcho, remoteMaterialized, projection]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].payload.actionId, actionId);
  assert.equal(deduped[0].payload.targetActionId, targetActionId);
  assert.match(deduped[0].payload.message, /reply action/);
});

test("Unit session event identity: known-key set recognizes action ids", () => {
  const known = new Set();
  const actionId = "166cf548-5dab-4987-92b5-64c535f1422c";
  const localEcho = {
    event: "session_action",
    payload: {
      actionId,
      actionType: "view",
      targetSequenceId: 11143,
      targetActionId: "ab044a13-7710-47cf-b061-1c468c6acfba",
      message: "view on reply action ab044a13 under #11143",
      source: "session_action",
    },
    ts: "2026-05-23T17:16:28.081Z",
  };
  const remoteMaterialized = {
    event: "session_action",
    cursor: "1779556588081:remote",
    payload: {
      action_id: actionId,
      actionType: "view",
      targetSequenceId: 11143,
      message: "view #11143",
      source: "session_action",
    },
    ts: "2026-05-23T17:16:28.081000+00:00",
  };

  addSessionEventIdentityKeys(known, localEcho);

  assert.equal(sessionEventHasKnownIdentity(remoteMaterialized, known), true);
});
