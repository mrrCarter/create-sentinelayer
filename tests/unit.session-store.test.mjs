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
    assert.ok(created.sessionDir.endsWith(created.sessionId));
    assert.match(created.elapsedTimer, /m|h/);

    const metadata = await getSession(created.sessionId, { targetPath: tempRoot });
    assert.equal(metadata?.sessionId, created.sessionId);
    assert.equal(metadata?.status, "active");
    assert.ok(metadata?.codebaseContext);
    assert.ok(Number.isFinite(Number(metadata?.codebaseContext?.summary?.filesScanned)));

    const active = await listActiveSessions({ targetPath: tempRoot });
    assert.equal(active.length, 1);
    assert.equal(active[0].sessionId, created.sessionId);

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
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
