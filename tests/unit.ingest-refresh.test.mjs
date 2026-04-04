import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { resolveCodebaseIngest } from "../src/ingest/engine.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("Unit ingest resolver: missing ingest artifact triggers deterministic refresh", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ingest-resolve-"));
  try {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "ingest-resolver", version: "1.0.0", type: "module" }, null, 2),
      "utf-8"
    );
    await writeFile(path.join(tempRoot, "index.js"), "export const value = 1;\n", "utf-8");

    const first = await resolveCodebaseIngest({
      rootPath: tempRoot,
    });

    assert.equal(first.refreshed, true);
    assert.equal(first.stale, false);
    assert.equal(first.reasons.includes("missing_ingest"), true);
    assert.equal(typeof first.fingerprint.contentHash, "string");
    assert.equal(first.fingerprint.contentHash.length > 0, true);

    const stored = JSON.parse(await readFile(first.outputPath, "utf-8"));
    assert.equal(stored.cache.contentHash, first.fingerprint.contentHash);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit ingest resolver: detects stale cached ingest and refreshes on demand", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ingest-stale-"));
  try {
    await writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "ingest-stale", version: "1.0.0", type: "module" }, null, 2),
      "utf-8"
    );
    await writeFile(path.join(tempRoot, "src.js"), "export const build = 'v1';\n", "utf-8");

    await git(tempRoot, ["init"]);
    await git(tempRoot, ["config", "user.email", "qa@sentinelayer.local"]);
    await git(tempRoot, ["config", "user.name", "Sentinelayer QA"]);
    await git(tempRoot, ["add", "."]);
    await git(tempRoot, ["commit", "-m", "initial"]);

    const initial = await resolveCodebaseIngest({
      rootPath: tempRoot,
    });
    assert.equal(initial.refreshed, true);
    const initialHash = initial.fingerprint.contentHash;

    await writeFile(path.join(tempRoot, "src.js"), "export const build = 'v2';\n", "utf-8");
    await git(tempRoot, ["add", "."]);
    await git(tempRoot, ["commit", "-m", "update"]);

    const stale = await resolveCodebaseIngest({
      rootPath: tempRoot,
    });
    assert.equal(stale.refreshed, false);
    assert.equal(stale.stale, true);
    assert.equal(
      stale.reasons.includes("content_hash_mismatch") || stale.reasons.includes("older_than_last_commit"),
      true
    );

    const refreshed = await resolveCodebaseIngest({
      rootPath: tempRoot,
      refresh: true,
    });
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.stale, false);
    assert.equal(refreshed.fingerprint.contentHash !== initialHash, true);

    const cached = await resolveCodebaseIngest({
      rootPath: tempRoot,
    });
    assert.equal(cached.refreshed, false);
    assert.equal(cached.stale, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
