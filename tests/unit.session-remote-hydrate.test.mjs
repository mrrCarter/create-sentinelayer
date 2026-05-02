// Unit tests for the on-demand remote hydrator.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hydrateSessionFromRemote } from "../src/session/remote-hydrate.js";
import { readStream } from "../src/session/stream.js";
import { readSyncCursor, writeSyncCursor } from "../src/session/sync-cursor.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-hydrate-"));
}

test("hydrateSessionFromRemote: rejects empty session id", async () => {
  const result = await hydrateSessionFromRemote({ sessionId: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_session_id");
});

test("hydrateSessionFromRemote: bubbles poll failure without crashing", async () => {
  const root = await makeTempRepo();
  try {
    const result = await hydrateSessionFromRemote({
      sessionId: "abc",
      targetPath: root,
      _poll: async () => ({ ok: false, reason: "no_session", events: [], cursor: null }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_session");
    assert.equal(result.relayed, 0);
    assert.equal(result.persistedCursor, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: appends each event + persists cursor", async () => {
  const root = await makeTempRepo();
  try {
    const appended = [];
    const result = await hydrateSessionFromRemote({
      sessionId: "sess-1",
      targetPath: root,
      _poll: async () => ({
        ok: true,
        reason: "",
        events: [
          { type: "session_message", at: "2026-04-25T07:00:00.000Z" },
          { type: "session_message", at: "2026-04-25T07:00:01.000Z" },
        ],
        cursor: "2026-04-25T07:00:01.000Z",
        dropped: [],
      }),
      _append: async (sessionId, event) => {
        appended.push({ sessionId, event });
        return event;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.relayed, 2);
    assert.equal(result.persistedCursor, true);
    assert.equal(appended.length, 2);
    assert.equal(appended[0].sessionId, "sess-1");

    const stored = await readSyncCursor("sess-1", { targetPath: root });
    assert.equal(stored, "2026-04-25T07:00:01.000Z");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: uses persisted cursor on next call", async () => {
  const root = await makeTempRepo();
  try {
    await writeSyncCursor("sess-2", "2026-04-25T06:00:00.000Z", { targetPath: root });
    let observedSince = "<unset>";
    await hydrateSessionFromRemote({
      sessionId: "sess-2",
      targetPath: root,
      _poll: async (_id, opts) => {
        observedSince = opts.since;
        return { ok: true, events: [], cursor: opts.since, dropped: [] };
      },
      _append: async () => undefined,
    });
    assert.equal(observedSince, "2026-04-25T06:00:00.000Z");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: explicit since overrides persisted cursor", async () => {
  const root = await makeTempRepo();
  try {
    await writeSyncCursor("sess-3", "2026-04-25T06:00:00.000Z", { targetPath: root });
    let observedSince = "<unset>";
    await hydrateSessionFromRemote({
      sessionId: "sess-3",
      targetPath: root,
      since: "2026-04-25T05:00:00.000Z",
      _poll: async (_id, opts) => {
        observedSince = opts.since;
        return { ok: true, events: [], cursor: opts.since, dropped: [] };
      },
      _append: async () => undefined,
    });
    assert.equal(observedSince, "2026-04-25T05:00:00.000Z");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: append failures don't abort the batch", async () => {
  const root = await makeTempRepo();
  try {
    let calls = 0;
    const result = await hydrateSessionFromRemote({
      sessionId: "sess-4",
      targetPath: root,
      _poll: async () => ({
        ok: true,
        events: [{ type: "a" }, { type: "b" }, { type: "c" }],
        cursor: "x",
        dropped: [],
      }),
      _append: async (_id, event) => {
        calls += 1;
        if (event.type === "b") throw new Error("disk full");
        return event;
      },
    });
    assert.equal(calls, 3);
    assert.equal(result.relayed, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: materializes remote-only sessions before local append", async () => {
  const root = await makeTempRepo();
  const oldSkip = process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "1";
  try {
    const result = await hydrateSessionFromRemote({
      sessionId: "remote-only",
      targetPath: root,
      _poll: async () => ({ ok: true, events: [], cursor: null, dropped: [] }),
      _pollEvents: async () => ({
        ok: true,
        events: [
          {
            event: "session_message",
            cursor: "e-1",
            ts: "2026-05-02T16:00:00.000Z",
            agent: { id: "claude-1", model: "claude-opus-4-7" },
            payload: { message: "remote message" },
          },
        ],
        cursor: "e-1",
      }),
    });
    const events = await readStream("remote-only", { targetPath: root, tail: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.relayed, 1);
    assert.equal(result.materializedLocalSession, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.message, "remote message");
    assert.equal(
      await readSyncCursor("remote-only", { targetPath: root, suffix: "events" }),
      "e-1",
    );
  } finally {
    if (oldSkip === undefined) delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    else process.env.SENTINELAYER_SKIP_REMOTE_SYNC = oldSkip;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: does not advance cursors when local append fails", async () => {
  const root = await makeTempRepo();
  try {
    const result = await hydrateSessionFromRemote({
      sessionId: "append-fails",
      targetPath: root,
      _poll: async () => ({
        ok: true,
        events: [{ event: "human_relay", cursor: "h-1", payload: { message: "human" } }],
        cursor: "h-1",
      }),
      _pollEvents: async () => ({
        ok: true,
        events: [{ event: "session_message", cursor: "e-1", agent: { id: "codex" }, payload: { message: "agent" } }],
        cursor: "e-1",
      }),
      _append: async () => {
        throw new Error("missing metadata");
      },
      _ensureLocalSession: async () => ({ materialized: false }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.relayed, 0);
    assert.equal(result.persistedCursor, false);
    assert.equal(result.localAppendComplete, false);
    assert.equal(await readSyncCursor("append-fails", { targetPath: root }), null);
    assert.equal(await readSyncCursor("append-fails", { targetPath: root, suffix: "events" }), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: marks materialized killed-session events as post-kill", async () => {
  const root = await makeTempRepo();
  try {
    const appended = [];
    const result = await hydrateSessionFromRemote({
      sessionId: "killed-remote",
      targetPath: root,
      _poll: async () => ({ ok: true, events: [], cursor: null, dropped: [] }),
      _pollEvents: async () => ({
        ok: true,
        events: [
          {
            event: "session_message",
            cursor: "e-killed",
            agent: { id: "codex" },
            payload: { message: "late message" },
          },
        ],
        cursor: "e-killed",
      }),
      _ensureLocalSession: async () => ({ materialized: true, remoteStatus: "killed" }),
      _append: async (_sessionId, event) => {
        appended.push(event);
        return event;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.remoteStatus, "killed");
    assert.equal(appended.length, 1);
    assert.equal(appended[0]._post_kill, true);
    assert.equal(appended[0].payload._post_kill, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("readSyncCursor: returns null when missing", async () => {
  const root = await makeTempRepo();
  try {
    const value = await readSyncCursor("ghost", { targetPath: root });
    assert.equal(value, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("writeSyncCursor: refuses empty cursor", async () => {
  const root = await makeTempRepo();
  try {
    const result = await writeSyncCursor("sess-5", "", { targetPath: root });
    assert.equal(result.written, false);
    const stored = await readSyncCursor("sess-5", { targetPath: root });
    assert.equal(stored, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("writeSyncCursor: round-trips an iso timestamp", async () => {
  const root = await makeTempRepo();
  try {
    const ts = "2026-04-25T07:30:00.000Z";
    const result = await writeSyncCursor("sess-6", ts, { targetPath: root });
    assert.equal(result.written, true);
    const stored = await readSyncCursor("sess-6", { targetPath: root });
    assert.equal(stored, ts);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: merges human + agent events from both pollers (codex/claude blind-spot fix)", async () => {
  const root = await makeTempRepo();
  try {
    const appended = [];
    const result = await hydrateSessionFromRemote({
      sessionId: "blind-spot-fix",
      targetPath: root,
      _poll: async () => ({
        ok: true,
        reason: "",
        events: [
          { event: "human_relay", cursor: "h-1", payload: { message: "carter says hi" } },
        ],
        cursor: "h-1",
        dropped: [],
      }),
      _pollEvents: async () => ({
        ok: true,
        reason: "",
        events: [
          { event: "session_message", cursor: "e-1", agent: { id: "claude-1" }, payload: { message: "claude posts an update" } },
          { event: "agent_response", cursor: "e-2", agent: { id: "codex-1" }, payload: { response: "codex replies" } },
        ],
        cursor: "e-2",
      }),
      _append: async (sessionId, event) => {
        appended.push(event);
        return event;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.relayed, 3, "all 3 events should be relayed (1 human + 2 agent)");
    assert.equal(result.humanRelayed, 1);
    assert.equal(result.eventsRelayed, 2);
    assert.equal(appended[0].event, "human_relay");
    assert.equal(appended[1].event, "session_message");
    assert.equal(appended[2].event, "agent_response");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: dedups events that appear in both pollers", async () => {
  const root = await makeTempRepo();
  try {
    const appended = [];
    const result = await hydrateSessionFromRemote({
      sessionId: "dedup",
      targetPath: root,
      _poll: async () => ({
        ok: true,
        events: [{ event: "human_relay", cursor: "shared-1", payload: { message: "x" } }],
        cursor: "shared-1",
      }),
      _pollEvents: async () => ({
        ok: true,
        events: [
          { event: "human_relay", cursor: "shared-1", payload: { message: "x" } },
          { event: "session_message", cursor: "agent-2", agent: { id: "claude-1" }, payload: { message: "y" } },
        ],
        cursor: "agent-2",
      }),
      _append: async (_, event) => { appended.push(event); return event; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.relayed, 2, "shared cursor relayed once, plus the unique agent event");
    assert.equal(appended.length, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: persists separate cursors for human vs events sources", async () => {
  const root = await makeTempRepo();
  try {
    await hydrateSessionFromRemote({
      sessionId: "two-cursors",
      targetPath: root,
      _poll: async () => ({ ok: true, events: [], cursor: "human-cur" }),
      _pollEvents: async () => ({ ok: true, events: [], cursor: "events-cur" }),
      _append: async () => null,
    });
    assert.equal(await readSyncCursor("two-cursors", { targetPath: root }), "human-cur");
    assert.equal(
      await readSyncCursor("two-cursors", { targetPath: root, suffix: "events" }),
      "events-cur",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hydrateSessionFromRemote: events poll failure doesn't block human relay (partial success)", async () => {
  const root = await makeTempRepo();
  try {
    const appended = [];
    const result = await hydrateSessionFromRemote({
      sessionId: "partial",
      targetPath: root,
      _poll: async () => ({
        ok: true,
        events: [{ event: "human_relay", cursor: "h-only", payload: { message: "human went through" } }],
        cursor: "h-only",
      }),
      _pollEvents: async () => ({ ok: false, reason: "circuit_breaker_open", events: [], cursor: null }),
      _append: async (_, event) => { appended.push(event); return event; },
    });
    assert.equal(result.ok, true, "should still succeed when only one poller works");
    assert.equal(result.relayed, 1);
    assert.equal(result.humanRelayed, 1);
    assert.equal(result.eventsRelayed, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
