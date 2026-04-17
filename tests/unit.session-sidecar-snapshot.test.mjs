// Mid-session sidecar snapshot test (audit finding §2.6).
// Spec §PR 10 line 1451-1453 requires analytics.json + artifact-chain.json
// observability across the session lifecycle, not only at archive time.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, access, rm, writeFile, mkdir } from "node:fs/promises";

import {
  createSession,
  persistSessionSidecarsSnapshot,
} from "../src/session/store.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "sidecar-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const value = 1;\n", "utf-8");
}

test("persistSessionSidecarsSnapshot: writes analytics.json and artifact-chain.json mid-session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "senti-sidecar-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    // No archive call — just snapshot.
    const result = await persistSessionSidecarsSnapshot(session.sessionId, {
      targetPath: tempRoot,
    });

    assert.equal(result.sessionId, session.sessionId);
    assert.ok(result.analyticsSidecar, "analyticsSidecar must be returned");
    assert.ok(result.artifactChainSidecar, "artifactChainSidecar must be returned");

    const sessionDir = path.join(tempRoot, ".sentinelayer", "sessions", session.sessionId);
    await access(path.join(sessionDir, "analytics.json"));
    await access(path.join(sessionDir, "artifact-chain.json"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistSessionSidecarsSnapshot: idempotent repeated calls overwrite sidecar cleanly", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "senti-sidecar-idem-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await persistSessionSidecarsSnapshot(session.sessionId, { targetPath: tempRoot });
    const second = await persistSessionSidecarsSnapshot(session.sessionId, { targetPath: tempRoot });
    assert.equal(second.sessionId, session.sessionId);
    assert.ok(second.analyticsSidecar.generatedAt);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("persistSessionSidecarsSnapshot: unknown session id throws", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "senti-sidecar-missing-"));
  try {
    await seedWorkspace(tempRoot);
    await assert.rejects(
      () => persistSessionSidecarsSnapshot("does-not-exist", { targetPath: tempRoot }),
      /was not found/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
