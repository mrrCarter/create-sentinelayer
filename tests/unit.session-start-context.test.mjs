import "./setup-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSessionCodebaseContext } from "../src/session/codebase-context.js";
import { fetchJsonWithFullTimeout } from "../src/session/sync.js";

test("Unit session start: optional context is cached-only and invalid caches are harmless", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sl-start-context-"));
  try {
    assert.deepEqual(await readSessionCodebaseContext(root), {});
    const cache = path.join(root, ".sentinelayer", "CODEBASE_INGEST.json");
    await fs.mkdir(path.dirname(cache));
    for (const value of ["{bad", "null", "[]", "x".repeat(2 * 1024 * 1024 + 1)]) {
      await fs.writeFile(cache, value);
      assert.deepEqual(await readSessionCodebaseContext(root), {});
    }
    const expected = { summary: { filesScanned: 27 }, frameworks: ["next"] };
    await fs.writeFile(cache, JSON.stringify(expected));
    assert.deepEqual(await readSessionCodebaseContext(root), expected);
    assert.deepEqual(await readSessionCodebaseContext(root, { timeoutMs: 1 }), {});
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const stage of ["headers", "body"]) {
  test(`Unit session request: ${stage} deadline aborts owned transport`, async () => {
    let signal;
    let cancelled = false;
    const fetchImpl = async (_url, init) => {
      signal = init.signal;
      if (stage === "headers") return new Promise(() => {});
      return { ok: true, status: 200, json: () => new Promise(() => {}), body: { cancel: () => { cancelled = true; } } };
    };
    await assert.rejects(fetchJsonWithFullTimeout("http://127.0.0.1/fixture", {}, 25, fetchImpl), /timeout/);
    assert.equal(signal.aborted, true);
    if (stage === "body") assert.equal(cancelled, true);
  });
}

for (const status of [401, 403, 404, 500]) {
  test(`Unit session request: ${status} error body is cancelled without reading it`, async () => {
    let cancelled = false;
    const { response } = await fetchJsonWithFullTimeout("http://127.0.0.1/fixture", {}, 25, async () => ({
      ok: false, status,
      json: () => assert.fail("denied/error body must not block probe"),
      body: { cancel: () => { cancelled = true; } },
    }));
    assert.equal(response.status, status);
    assert.equal(cancelled, true);
  });
}
