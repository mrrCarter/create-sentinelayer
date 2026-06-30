import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { createSession } from "../src/session/store.js";
import {
  resolveUsageSessionId,
  selectMostRecentUsageSession,
} from "../src/session/usage-session-resolver.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "usage-session-fixture", version: "1.0.0" }, null, 2),
    "utf-8",
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const ok = true;\n", "utf-8");
}

test("resolveUsageSessionId: explicit notify session wins", async () => {
  const result = await resolveUsageSessionId({
    explicitSessionId: "sess-explicit",
    listActiveSessionsFn: async () => {
      throw new Error("should not list local sessions");
    },
  });

  assert.equal(result.sessionId, "sess-explicit");
  assert.equal(result.source, "explicit");
});

test("resolveUsageSessionId: explicit notify session rejects path traversal", async () => {
  await assert.rejects(
    resolveUsageSessionId({
      explicitSessionId: "../outside",
      listActiveSessionsFn: async () => {
        throw new Error("should not list local sessions");
      },
    }),
    /Invalid --notify-session usage session id/,
  );
});

test("resolveUsageSessionId: environment session wins before local auto-detect", async () => {
  const result = await resolveUsageSessionId({
    env: { SENTINELAYER_SESSION_ID: "sess-env" },
    listActiveSessionsFn: async () => [{ sessionId: "sess-local", createdAt: "2026-01-01T00:00:00.000Z" }],
  });

  assert.equal(result.sessionId, "sess-env");
  assert.equal(result.source, "env");
  assert.equal(result.envKey, "SENTINELAYER_SESSION_ID");
});

test("resolveUsageSessionId: environment session rejects path separators", async () => {
  await assert.rejects(
    resolveUsageSessionId({
      env: { SENTINELAYER_SESSION_ID: "sessions/outside" },
      listActiveSessionsFn: async () => [{ sessionId: "sess-local", createdAt: "2026-01-01T00:00:00.000Z" }],
    }),
    /Invalid SENTINELAYER_SESSION_ID usage session id/,
  );
});

test("resolveUsageSessionId: environment session rejects non-allowlisted characters", async () => {
  await assert.rejects(
    resolveUsageSessionId({
      env: { SENTINELAYER_SESSION_ID: "sess:ads" },
      listActiveSessionsFn: async () => [{ sessionId: "sess-local", createdAt: "2026-01-01T00:00:00.000Z" }],
    }),
    /Invalid SENTINELAYER_SESSION_ID usage session id/,
  );
});

test("resolveUsageSessionId: selects newest active local session for a workspace", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-usage-session-"));
  try {
    await seedWorkspace(tempRoot);
    const older = await createSession({
      targetPath: tempRoot,
      sessionId: "sess-older",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastInteractionAt: "2026-01-01T00:10:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const newer = await createSession({
      targetPath: tempRoot,
      sessionId: "sess-newer",
      createdAt: "2026-01-01T00:01:00.000Z",
      lastInteractionAt: "2026-01-01T00:20:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    assert.equal(older.sessionId, "sess-older");
    assert.equal(newer.sessionId, "sess-newer");

    const result = await resolveUsageSessionId({ targetPath: tempRoot, env: {} });

    assert.equal(result.sessionId, "sess-newer");
    assert.equal(result.source, "local_active_session");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("selectMostRecentUsageSession: refuses tied active sessions instead of guessing", () => {
  const result = selectMostRecentUsageSession([
    { sessionId: "sess-a", lastInteractionAt: "2026-01-01T00:00:00.000Z" },
    { sessionId: "sess-b", lastInteractionAt: "2026-01-01T00:00:00.000Z" },
  ]);

  assert.equal(result.sessionId, "");
  assert.equal(result.source, "ambiguous");
  assert.equal(result.reason, "multiple_active_sessions_same_recency");
  assert.deepEqual(result.candidates, ["sess-a", "sess-b"]);
});

test("selectMostRecentUsageSession: ignores malformed and empty session payloads", () => {
  const result = selectMostRecentUsageSession([
    null,
    undefined,
    {},
    { sessionId: "   ", lastInteractionAt: "2026-01-01T00:00:00.000Z" },
    { sessionId: "sess-valid", lastInteractionAt: "not-a-date" },
  ]);

  assert.equal(result.sessionId, "sess-valid");
  assert.equal(result.source, "local_active_session");
  assert.deepEqual(result.candidates, ["sess-valid"]);
});

test("selectMostRecentUsageSession: ignores unsafe local session IDs", () => {
  const result = selectMostRecentUsageSession([
    { sessionId: "../outside", lastInteractionAt: "2026-01-01T00:30:00.000Z" },
    { sessionId: "sess\\outside", lastInteractionAt: "2026-01-01T00:20:00.000Z" },
    { sessionId: "sess:ads", lastInteractionAt: "2026-01-01T00:15:00.000Z" },
    { sessionId: "sess-safe", lastInteractionAt: "2026-01-01T00:10:00.000Z" },
  ]);

  assert.equal(result.sessionId, "sess-safe");
  assert.equal(result.source, "local_active_session");
  assert.deepEqual(result.candidates, ["sess-safe"]);
});

test("selectMostRecentUsageSession: handles non-array payloads as no active session", () => {
  const result = selectMostRecentUsageSession({ sessionId: "sess-not-array" });

  assert.equal(result.sessionId, "");
  assert.equal(result.source, "none");
  assert.equal(result.reason, "no_active_session");
});

test("selectMostRecentUsageSession: collapses duplicate session IDs before tie checks", () => {
  const originalSessions = [
    { sessionId: "sess-dup", lastInteractionAt: "2026-01-01T00:00:00.000Z", title: "older duplicate" },
    { sessionId: "sess-other", lastInteractionAt: "2026-01-01T00:10:00.000Z", title: "other" },
    { sessionId: "sess-dup", lastInteractionAt: "2026-01-01T00:20:00.000Z", title: "newer duplicate" },
  ];
  const snapshot = structuredClone(originalSessions);

  const result = selectMostRecentUsageSession(originalSessions);

  assert.deepEqual(originalSessions, snapshot);
  assert.equal(result.sessionId, "sess-dup");
  assert.equal(result.source, "local_active_session");
  assert.equal(result.title, "newer duplicate");
  assert.deepEqual(result.candidates, ["sess-dup", "sess-other"]);
});

test("selectMostRecentUsageSession: returns no active session cleanly", () => {
  const result = selectMostRecentUsageSession([]);

  assert.equal(result.sessionId, "");
  assert.equal(result.source, "none");
  assert.equal(result.reason, "no_active_session");
});

test("resolveUsageSessionId: local session listing failures fail open for auto-detect", async () => {
  const failure = new Error("permission denied");
  failure.code = "EACCES";

  const result = await resolveUsageSessionId({
    env: {},
    listActiveSessionsFn: async () => {
      throw failure;
    },
  });

  assert.equal(result.sessionId, "");
  assert.equal(result.source, "error");
  assert.equal(result.reason, "list_active_sessions_failed");
  assert.equal(result.errorCode, "EACCES");
});
