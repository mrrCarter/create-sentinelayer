import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readWakeCursor, writeWakeCursor } from "../src/session/wake/cursor-store.js";

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cs-wake-cursor-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Unit wake cursor-store: missing cursor reads as 0", async () => {
  await withTempRoot(async (root) => {
    assert.equal(await readWakeCursor("sess-1", { targetPath: root }), 0);
  });
});

test("Unit wake cursor-store: write then read round-trips the seq", async () => {
  await withTempRoot(async (root) => {
    const written = await writeWakeCursor("sess-1", 42, { targetPath: root });
    assert.equal(written, 42);
    assert.equal(await readWakeCursor("sess-1", { targetPath: root }), 42);
  });
});

test("Unit wake cursor-store: persists seq + updatedAt as JSON", async () => {
  await withTempRoot(async (root) => {
    await writeWakeCursor("sess-2", 7, { targetPath: root });
    const file = path.join(root, ".sentinelayer", "sessions", "sess-2", "senti", "wake-resume-cursor.json");
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    assert.equal(parsed.seq, 7);
    assert.match(parsed.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("Unit wake cursor-store: rejects invalid seq without corrupting stored value", async () => {
  await withTempRoot(async (root) => {
    await writeWakeCursor("sess-3", 10, { targetPath: root });
    await writeWakeCursor("sess-3", -1, { targetPath: root });
    await writeWakeCursor("sess-3", 3.5, { targetPath: root });
    await writeWakeCursor("sess-3", "nope", { targetPath: root });
    assert.equal(await readWakeCursor("sess-3", { targetPath: root }), 10, "invalid writes are no-ops");
  });
});

test("Unit wake cursor-store: malformed file reads as 0", async () => {
  await withTempRoot(async (root) => {
    await writeWakeCursor("sess-4", 5, { targetPath: root });
    const file = path.join(root, ".sentinelayer", "sessions", "sess-4", "senti", "wake-resume-cursor.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ not json", "utf-8");
    assert.equal(await readWakeCursor("sess-4", { targetPath: root }), 0);
  });
});

test("Unit wake cursor-store: empty sessionId is a safe no-op / zero", async () => {
  await withTempRoot(async (root) => {
    assert.equal(await writeWakeCursor("", 9, { targetPath: root }), 0);
    assert.equal(await readWakeCursor("", { targetPath: root }), 0);
  });
});
