// Unit tests for coord/paths.js (#A9 filesystem layout + path normalization).

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  hashLockKey,
  lockFileFor,
  normalizeLockPath,
  resolveEventsPath,
  resolveLocksDir,
  resolveSentinelDir,
  resolveWaitsPath,
} from "../src/coord/paths.js";

const FAKE_ROOT = path.resolve("/tmp", "senti-coord-paths-fixture");

test("resolveSentinelDir lands under .sentinel at target root", () => {
  const dir = resolveSentinelDir({ targetPath: FAKE_ROOT });
  assert.equal(dir, path.join(FAKE_ROOT, ".sentinel"));
});

test("resolveLocksDir lands under .sentinel/locks", () => {
  assert.equal(
    resolveLocksDir({ targetPath: FAKE_ROOT }),
    path.join(FAKE_ROOT, ".sentinel", "locks")
  );
});

test("resolveEventsPath is .sentinel/events.jsonl", () => {
  assert.equal(
    resolveEventsPath({ targetPath: FAKE_ROOT }),
    path.join(FAKE_ROOT, ".sentinel", "events.jsonl")
  );
});

test("resolveWaitsPath is .sentinel/waits.json", () => {
  assert.equal(
    resolveWaitsPath({ targetPath: FAKE_ROOT }),
    path.join(FAKE_ROOT, ".sentinel", "waits.json")
  );
});

test("normalizeLockPath: rejects empty input", () => {
  assert.throws(() => normalizeLockPath("", { targetPath: FAKE_ROOT }));
  assert.throws(() => normalizeLockPath(null, { targetPath: FAKE_ROOT }));
});

test("normalizeLockPath: strips ./ prefix and normalizes backslashes", () => {
  assert.equal(
    normalizeLockPath("./app/layout.tsx", { targetPath: FAKE_ROOT }),
    "app/layout.tsx"
  );
  assert.equal(
    normalizeLockPath("app\\layout.tsx", { targetPath: FAKE_ROOT }),
    "app/layout.tsx"
  );
});

test("normalizeLockPath: relativizes absolute paths against targetPath", () => {
  const absolute = path.join(FAKE_ROOT, "app", "layout.tsx");
  assert.equal(
    normalizeLockPath(absolute, { targetPath: FAKE_ROOT }),
    "app/layout.tsx"
  );
});

test("normalizeLockPath: rejects paths that escape the target root", () => {
  assert.throws(() =>
    normalizeLockPath("../outside/file.txt", { targetPath: FAKE_ROOT })
  );
});

test("hashLockKey: deterministic + stable length", () => {
  const key = hashLockKey("app/layout.tsx");
  assert.equal(typeof key, "string");
  assert.equal(key.length, 16);
  assert.equal(hashLockKey("app/layout.tsx"), key);
});

test("hashLockKey: different paths → different keys", () => {
  assert.notEqual(
    hashLockKey("app/layout.tsx"),
    hashLockKey("app/page.tsx")
  );
});

test("hashLockKey: rejects empty input", () => {
  assert.throws(() => hashLockKey(""));
});

test("lockFileFor: composes hash into .sentinel/locks/<hash>.lock.json", () => {
  const file = lockFileFor("app/layout.tsx", { targetPath: FAKE_ROOT });
  assert.ok(
    file.startsWith(path.join(FAKE_ROOT, ".sentinel", "locks")),
    `expected lockFile under locks dir, got ${file}`
  );
  assert.ok(file.endsWith(".lock.json"));
});
