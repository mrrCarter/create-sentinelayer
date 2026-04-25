// Unit tests for session-preview helper.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pickLatestPreview, readSessionPreview } from "../src/session/preview.js";
import { createSession } from "../src/session/store.js";
import { appendToStream } from "../src/session/stream.js";
import { createAgentEvent } from "../src/events/schema.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-preview-"));
}

test("pickLatestPreview: empty events", () => {
  const result = pickLatestPreview([]);
  assert.equal(result.message, null);
  assert.equal(result.agentId, null);
});

test("pickLatestPreview: returns most recent meaningful event", () => {
  const events = [
    {
      event: "session_message",
      ts: "2026-04-25T07:00:00.000Z",
      agent: { id: "claude-1" },
      payload: { message: "first" },
    },
    {
      event: "agent_join",
      ts: "2026-04-25T07:00:01.000Z",
      agent: { id: "codex-1" },
      payload: { agentId: "codex-1" },
    },
    {
      event: "session_message",
      ts: "2026-04-25T07:00:02.000Z",
      agent: { id: "human-mrrcarter" },
      payload: { message: "second message body" },
    },
  ];
  const result = pickLatestPreview(events);
  assert.equal(result.message, "second message body");
  assert.equal(result.agentId, "human-mrrcarter");
  assert.equal(result.kind, "session_message");
});

test("pickLatestPreview: skips agent_join + heartbeat noise", () => {
  const events = [
    {
      event: "session_message",
      ts: "2026-04-25T07:00:00.000Z",
      agent: { id: "claude-1" },
      payload: { message: "real message" },
    },
    {
      event: "agent_join",
      ts: "2026-04-25T07:01:00.000Z",
      payload: { agentId: "x" },
    },
    {
      event: "heartbeat",
      ts: "2026-04-25T07:02:00.000Z",
      payload: {},
    },
  ];
  const result = pickLatestPreview(events);
  assert.equal(result.message, "real message");
});

test("pickLatestPreview: trims long messages", () => {
  const long = "a".repeat(200);
  const result = pickLatestPreview([
    {
      event: "session_message",
      ts: "2026-04-25T07:00:00.000Z",
      payload: { message: long },
    },
  ]);
  assert.ok(result.message.length <= 41); // 40 + ellipsis
  assert.ok(result.message.endsWith("…"));
});

test("readSessionPreview: returns null for missing session", async () => {
  const root = await makeTempRepo();
  try {
    const result = await readSessionPreview("nope", { targetPath: root });
    assert.equal(result.message, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("readSessionPreview: tails the most recent session_message", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "claude-1",
        sessionId: created.sessionId,
        payload: { message: "first hello" },
      }),
      { targetPath: root },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "human-mrrcarter",
        sessionId: created.sessionId,
        payload: { message: "second hello — most recent" },
      }),
      { targetPath: root },
    );
    const result = await readSessionPreview(created.sessionId, { targetPath: root });
    assert.match(result.message || "", /most recent/);
    assert.equal(result.agentId, "human-mrrcarter");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
