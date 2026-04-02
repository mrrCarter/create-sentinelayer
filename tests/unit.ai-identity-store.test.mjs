import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  filterIdentitiesByTags,
  findStaleIdentities,
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
    assert.equal(recorded.identity.legalHoldStatus, "NONE");

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

test("Unit identity store: child identity records preserve parent linkage and source metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-store-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    const recorded = await recordProvisionedIdentity({
      outputRoot,
      response: {
        id: "id_child_1",
        parentIdentityId: "id_parent_1",
        emailAddress: "child@aidenid.com",
        status: "ACTIVE",
        projectId: "proj_test",
      },
      context: {
        source: "create-child",
        apiUrl: "https://api.aidenid.com",
        orgId: "org_test",
        projectId: "proj_test",
        idempotencyKey: "idem-child-1",
        parentIdentityId: "id_parent_1",
        eventBudget: 42,
      },
    });

    assert.equal(recorded.identity.identityId, "id_child_1");
    assert.equal(recorded.identity.parentIdentityId, "id_parent_1");
    assert.equal(recorded.identity.metadata.source, "create-child");
    assert.equal(recorded.identity.metadata.eventBudget, 42);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit identity store: stale detection excludes squashed identities", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-store-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    await recordProvisionedIdentity({
      outputRoot,
      response: {
        id: "id_stale",
        emailAddress: "stale@aidenid.com",
        status: "ACTIVE",
        projectId: "proj_test",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
      context: {
        apiUrl: "https://api.aidenid.com",
        orgId: "org_test",
        projectId: "proj_test",
        idempotencyKey: "idem-stale",
      },
    });
    await recordProvisionedIdentity({
      outputRoot,
      response: {
        id: "id_squashed",
        emailAddress: "squashed@aidenid.com",
        status: "SQUASHED",
        projectId: "proj_test",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
      context: {
        apiUrl: "https://api.aidenid.com",
        orgId: "org_test",
        projectId: "proj_test",
        idempotencyKey: "idem-squashed",
      },
    });

    const stale = await findStaleIdentities({
      outputRoot,
      nowIso: "2026-06-01T00:00:00.000Z",
    });
    assert.equal(stale.stale.length, 1);
    assert.equal(stale.stale[0].identityId, "id_stale");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit identity store: tag filter requires all requested tags", () => {
  const identities = [
    {
      identityId: "id_1",
      metadata: {
        tags: ["campaign-a", "team-security"],
      },
    },
    {
      identityId: "id_2",
      metadata: {
        tags: ["campaign-a"],
      },
    },
  ];
  const filtered = filterIdentitiesByTags(identities, ["campaign-a", "team-security"]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].identityId, "id_1");
});
