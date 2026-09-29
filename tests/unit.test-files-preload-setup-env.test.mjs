import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 2026-09-29: a raw `node --test` run (no `--import ./tests/setup-env.mjs`) synced thousands
// of test sessions to the API with the developer's stored credentials, and spawned a
// detached daemon per session. A test file's safety must not depend on how it is invoked:
// every test file loads setup-env.mjs FIRST (ESM evaluates imports in order, so the offline
// flags are set before any module under test loads).
test("every test file preloads setup-env.mjs as its first import", async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".test.mjs"));
  assert.ok(files.length > 100, `found only ${files.length} test files`);
  const offenders = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf-8");
    const firstImport = text.split(/\r?\n/).find((line) => /^\s*import\b/.test(line)) || "";
    if (firstImport.trim() !== 'import "./setup-env.mjs";') offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
