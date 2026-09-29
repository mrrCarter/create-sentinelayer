import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  archiveSession,
  createSession,
  expireSession,
  getSession,
  listActiveSessions,
  renewSession,
} from "../src/session/store.js";
import { withSessionStreamLock } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify(
      {
        name: "session-store-fixture",
        version: "1.0.0",
        scripts: {
          test: "node --test",
        },
        dependencies: {
          express: "5.0.0",
        },
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(
    path.join(rootPath, "src", "index.js"),
    "export function main() { return 'ok'; }\n",
    "utf-8"
  );
}

test("Unit session store: creates metadata with ingest context and lists active sessions", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  try {
    await seedWorkspace(tempRoot);

    const created = await createSession({ targetPath: tempRoot, ttlSeconds: 60 });
    assert.ok(created.sessionId);
    assert.equal(created.targetPath, path.resolve(tempRoot));
    assert.ok(created.sessionDir.endsWith(created.sessionId));
    assert.match(created.elapsedTimer, /m|h/);

    const metadata = await getSession(created.sessionId, { targetPath: tempRoot });
    assert.equal(metadata?.sessionId, created.sessionId);
    assert.equal(metadata?.targetPath, path.resolve(tempRoot));
    assert.equal(metadata?.status, "active");
    assert.ok(metadata?.codebaseContext);
    assert.ok(Number.isFinite(Number(metadata?.codebaseContext?.summary?.filesScanned)));

    const active = await listActiveSessions({ targetPath: tempRoot });
    assert.equal(active.length, 1);
    assert.equal(active[0].sessionId, created.sessionId);
    assert.equal(active[0].targetPath, path.resolve(tempRoot));

    const rawMetadata = JSON.parse(
      await readFile(path.join(created.sessionDir, "metadata.json"), "utf-8")
    );
    assert.equal(rawMetadata.sessionId, created.sessionId);
    assert.equal(rawMetadata.status, "active");
    assert.ok(Array.isArray(rawMetadata.codebaseContext.frameworks));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session store: missing sessions and unsafe ids fail closed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-invalid-"));
  try {
    await seedWorkspace(tempRoot);

    const missing = await getSession("missing-session", { targetPath: tempRoot });
    assert.equal(missing, null);

    await assert.rejects(
      () => createSession({ targetPath: tempRoot, sessionId: "../escape" }),
      /sessionId must not contain path traversal segments/,
    );
    await assert.rejects(
      () => createSession({ targetPath: tempRoot, sessionId: "nested/path" }),
      /sessionId must not contain path traversal segments/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session store: requested-ID creation is idempotent and preserves the winning metadata", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-session-create-race-"));
  try {
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => createSession({
      targetPath: root, sessionId: "same-room", title: `creator-${index}`, ttlSeconds: 600 + index,
    })));
    const winner = await getSession("same-room", { targetPath: root });
    for (const result of results) {
      assert.equal(result.title, winner.title);
      assert.equal(result.createdAt, winner.createdAt);
      assert.equal(result.expiresAt, winner.expiresAt);
    }
    await expireSession("same-room", { targetPath: root });
    const before = await readFile(winner.metadataPath, "utf8");
    const retry = await createSession({ targetPath: root, sessionId: "same-room", title: "must-not-reset", ttlSeconds: 99_999 });
    assert.equal(retry.status, "expired");
    assert.equal(retry.title, winner.title);
    assert.equal(await readFile(winner.metadataPath, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Unit session store: materializer rechecks existence only after the stream writer releases its lock", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-session-create-lock-"));
  let unlock;
  let held;
  try {
    const original = await createSession({ targetPath: root, sessionId: "locked-room", title: "original" });
    let ready;
    const acquired = new Promise((resolve) => { ready = resolve; });
    held = withSessionStreamLock("locked-room", async () => {
      ready();
      await new Promise((resolve) => { unlock = resolve; });
    }, { targetPath: root });
    await acquired;
    let finished = false;
    const retry = createSession({ targetPath: root, sessionId: "locked-room", title: "must-not-win" }).then((value) => {
      finished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(finished, false);
    const metadata = JSON.parse(await readFile(original.metadataPath, "utf8"));
    metadata.title = "written-under-lock";
    metadata.renewalCount = 3;
    await writeFile(original.metadataPath, JSON.stringify(metadata));
    unlock();
    await held;
    const result = await retry;
    assert.equal(result.title, "written-under-lock");
    assert.equal(result.renewalCount, 3);
    assert.equal(await readFile(original.metadataPath, "utf8"), JSON.stringify(metadata));
  } finally {
    unlock?.();
    await held;
    await rm(root, { recursive: true, force: true });
  }
});

test("Unit session store: renew extends expiry but respects 72h max lifetime cap", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-renew-"));
  try {
    await seedWorkspace(tempRoot);
    const created = await createSession({ targetPath: tempRoot, ttlSeconds: 24 * 60 * 60 });
    const first = await getSession(created.sessionId, { targetPath: tempRoot });
    const firstExpiry = Date.parse(first.expiresAt);

    const renew1 = await renewSession(created.sessionId, { targetPath: tempRoot });
    const renew2 = await renewSession(created.sessionId, { targetPath: tempRoot });
    const renew3 = await renewSession(created.sessionId, { targetPath: tempRoot });

    const renew1Expiry = Date.parse(renew1.expiresAt);
    const renew2Expiry = Date.parse(renew2.expiresAt);
    const renew3Expiry = Date.parse(renew3.expiresAt);

    assert.ok(renew1Expiry > firstExpiry);
    assert.ok(renew2Expiry >= renew1Expiry);
    assert.equal(renew3Expiry, renew2Expiry);
    assert.equal(renew3.renewalCount, 2);

    const maxLifetimeMs = 72 * 60 * 60 * 1000;
    assert.ok(renew3Expiry - Date.parse(renew3.createdAt) <= maxLifetimeMs);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session store: expire marks session non-active and archive writes s3 metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-expire-"));
  try {
    await seedWorkspace(tempRoot);
    const created = await createSession({ targetPath: tempRoot, ttlSeconds: 60 });

    const expired = await expireSession(created.sessionId, { targetPath: tempRoot });
    assert.equal(expired.status, "expired");

    const activeAfterExpire = await listActiveSessions({ targetPath: tempRoot });
    assert.equal(activeAfterExpire.length, 0);

    const archived = await archiveSession(created.sessionId, {
      targetPath: tempRoot,
      s3Bucket: "sentinelayer-audit-artifacts",
      s3Prefix: "training",
    });
    assert.equal(archived.status, "archived");
    assert.ok(String(archived.s3Path).startsWith("s3://sentinelayer-audit-artifacts/training/sessions/"));
    assert.ok(archived.archivedAt);

    const analyticsSidecar = JSON.parse(
      await readFile(path.join(created.sessionDir, "analytics.json"), "utf-8")
    );
    const artifactChainSidecar = JSON.parse(
      await readFile(path.join(created.sessionDir, "artifact-chain.json"), "utf-8")
    );
    const archiveManifest = JSON.parse(
      await readFile(path.join(created.sessionDir, "archive-manifest.json"), "utf-8")
    );
    assert.equal(analyticsSidecar.sessionId, created.sessionId);
    assert.equal(typeof analyticsSidecar.metrics, "object");
    assert.equal(artifactChainSidecar.sessionId, created.sessionId);
    assert.equal(Array.isArray(artifactChainSidecar.workItems), true);
    assert.equal(Array.isArray(archiveManifest.files), true);
    assert.equal(archiveManifest.files.includes("analytics.json"), true);
    assert.equal(archiveManifest.files.includes("artifact-chain.json"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
