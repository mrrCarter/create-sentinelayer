// Unit tests for the on-demand remote hydrator.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hydrateSessionFromRemote } from "../src/session/remote-hydrate.js";
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
