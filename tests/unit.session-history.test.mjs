// Unit tests for session history (listAllSessions + archive surfacing).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createSession,
  listActiveSessions,
  listAllSessions,
} from "../src/session/store.js";
import { resolveSessionPaths } from "../src/session/paths.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-history-"));
}

/**
 * Direct on-disk metadata mutation to mark a session archived without
 * pulling in the real `archiveSession()` (which uploads to S3 + needs
 * a bucket). Mirrors the shape `archiveSession` writes back.
 */
async function markArchivedOnDisk(sessionId, { targetPath }) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const raw = await fsp.readFile(paths.metadataPath, "utf-8");
  const metadata = JSON.parse(raw);
  metadata.status = "archived";
  metadata.archiveStatus = "archived";
  metadata.archivedAt = new Date().toISOString();
  await fsp.writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
}

test("listAllSessions: empty cache returns []", async () => {
  const root = await makeTempRepo();
  try {
    const sessions = await listAllSessions({ targetPath: root });
    assert.deepEqual(sessions, []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("listAllSessions: surfaces active session with archiveStatus=active", async () => {
  const root = await makeTempRepo();
  try {
    await createSession({ targetPath: root });
    const all = await listAllSessions({ targetPath: root });
    assert.equal(all.length, 1);
    assert.equal(all[0].archiveStatus, "active");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("listAllSessions: includes archived sessions that listActiveSessions hides", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await markArchivedOnDisk(created.sessionId, { targetPath: root });

    const active = await listActiveSessions({ targetPath: root });
    const all = await listAllSessions({ targetPath: root });

    assert.equal(active.length, 0, "archived session must not appear in active list");
    assert.equal(all.length, 1, "archived session must appear in full list");
    assert.equal(all[0].sessionId, created.sessionId);
    assert.equal(all[0].archiveStatus, "archived");
    assert.ok(all[0].archivedAt);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("listAllSessions: sort newest-first by createdAt", async () => {
  const root = await makeTempRepo();
  try {
    const a = await createSession({ targetPath: root });
    // ensure ordering by tiny delay so timestamps differ
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await createSession({ targetPath: root });
    const all = await listAllSessions({ targetPath: root });
    assert.equal(all[0].sessionId, b.sessionId, "newest first");
    assert.equal(all[1].sessionId, a.sessionId);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("listAllSessions: mixed active + archived returns both with correct labels", async () => {
  const root = await makeTempRepo();
  try {
    const a = await createSession({ targetPath: root });
    const b = await createSession({ targetPath: root });
    await markArchivedOnDisk(a.sessionId, { targetPath: root });
    const all = await listAllSessions({ targetPath: root });
    const byId = new Map(all.map((s) => [s.sessionId, s]));
    assert.equal(byId.get(a.sessionId).archiveStatus, "archived");
    assert.equal(byId.get(b.sessionId).archiveStatus, "active");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
