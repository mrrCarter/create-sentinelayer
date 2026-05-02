import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { pushSessionTitleToApi } from "../src/session/title-sync.js";
import {
  createSession,
  getSession,
  recordSessionRemoteTitleSync,
} from "../src/session/store.js";

test("Unit session title sync: push uses bounded retryable title endpoint and records success", async () => {
  const records = [];
  const calls = [];
  const env = {};

  const result = await pushSessionTitleToApi("sess-title-1", "  My Session  ", {
    targetPath: "/tmp/workspace",
    env,
    resolveAuthSession: async (args) => {
      assert.equal(args.cwd, "/tmp/workspace");
      assert.equal(args.env, env);
      assert.equal(args.autoRotate, false);
      return {
        token: "tok_test_123",
        apiUrl: "https://api.sentinelayer.com/",
      };
    },
    requestMutation: async (url, options) => {
      calls.push({ url, options });
      return { status: 204 };
    },
    recordRemoteTitleSync: async (sessionId, payload) => {
      records.push({ sessionId, payload });
    },
  });

  assert.equal(result.synced, true);
  assert.equal(result.status, 204);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-title-1/title",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.operationName, "session.set_title");
  assert.equal(calls[0].options.timeoutMs, 2_000);
  assert.equal(calls[0].options.maxRetries, 1);
  assert.equal(calls[0].options.retryDelayMs, 200);
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok_test_123");
  assert.deepEqual(calls[0].options.body, { title: "My Session" });
  assert.equal(records.length, 2);
  assert.equal(records[0].sessionId, "sess-title-1");
  assert.equal(records[0].payload.pending, true);
  assert.equal(records[0].payload.title, "My Session");
  assert.equal(records[1].payload.pending, false);
});

test("Unit session title sync: failed push leaves pending repair metadata", async () => {
  const records = [];

  const result = await pushSessionTitleToApi("sess-title-2", "Broken Link", {
    targetPath: "/tmp/workspace",
    env: {},
    resolveAuthSession: async () => ({
      token: "tok_test_123",
      apiUrl: "https://api.sentinelayer.com",
    }),
    requestMutation: async () => {
      throw new Error("network down");
    },
    recordRemoteTitleSync: async (sessionId, payload) => {
      records.push({ sessionId, payload });
    },
  });

  assert.equal(result.synced, false);
  assert.equal(result.reason, "network down");
  assert.equal(records.length, 2);
  assert.equal(records[0].payload.pending, true);
  assert.equal(records[1].payload.pending, true);
  assert.equal(records[1].payload.failureReason, "network down");
});

test("Unit session title sync: remoteTitleSync repair state survives metadata reload", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-title-sync-"));
  try {
    const created = await createSession({
      targetPath: tempRoot,
      title: "Local Title",
    });
    await recordSessionRemoteTitleSync(created.sessionId, {
      targetPath: tempRoot,
      title: "Local Title",
      pending: true,
      failureReason: "network down",
      lastAttemptAt: "2026-05-02T18:00:00.000Z",
    });

    const stored = await getSession(created.sessionId, { targetPath: tempRoot });
    assert.equal(stored.remoteTitleSync.pending, true);
    assert.equal(stored.remoteTitleSync.title, "Local Title");
    assert.equal(stored.remoteTitleSync.failureReason, "network down");
    assert.equal(stored.remoteTitleSync.lastAttemptAt, "2026-05-02T18:00:00.000Z");
    assert.equal(stored.remoteTitleSync.lastSyncedAt, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
