import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  getIdentityById,
  listIdentities,
  recordProvisionedIdentity,
  updateIdentityStatus,
} from "../src/ai/identity-store.js";

test("Unit identity store: record/list/show identity lifecycle", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-store-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    const empty = await listIdentities({ outputRoot });
    assert.equal(empty.identities.length, 0);

    const recorded = await recordProvisionedIdentity({
      outputRoot,
      response: {
        id: "id_123",
        emailAddress: "scan@aidenid.com",
        status: "ACTIVE",
        expiresAt: "2026-05-01T00:00:00.000Z",
        projectId: "proj_test",
      },
      context: {
        apiUrl: "https://api.aidenid.com",
        orgId: "org_test",
        projectId: "proj_test",
        idempotencyKey: "idem-123",
      },
    });
    assert.equal(recorded.identity.identityId, "id_123");
    assert.equal(recorded.identity.status, "ACTIVE");

    const listed = await listIdentities({ outputRoot });
    assert.equal(listed.identities.length, 1);
    assert.equal(listed.identities[0].identityId, "id_123");

    const shown = await getIdentityById({ outputRoot, identityId: "id_123" });
    assert.ok(shown.identity);
    assert.equal(shown.identity.emailAddress, "scan@aidenid.com");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit identity store: update status transitions identity to revoked", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-store-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    await recordProvisionedIdentity({
      outputRoot,
      response: {
        id: "id_123",
        emailAddress: "scan@aidenid.com",
        status: "ACTIVE",
        projectId: "proj_test",
      },
      context: {
        apiUrl: "https://api.aidenid.com",
        orgId: "org_test",
        projectId: "proj_test",
        idempotencyKey: "idem-123",
      },
    });

    const updated = await updateIdentityStatus({
      outputRoot,
      identityId: "id_123",
      status: "REVOKED",
      revokedAt: "2026-05-01T00:00:00.000Z",
      metadataPatch: { reason: "integration-test" },
    });
    assert.equal(updated.identity.identityId, "id_123");
    assert.equal(updated.identity.status, "REVOKED");
    assert.equal(updated.identity.revokedAt, "2026-05-01T00:00:00.000Z");
    assert.equal(updated.identity.metadata.reason, "integration-test");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
