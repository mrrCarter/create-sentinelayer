import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { listSites, recordTemporarySite } from "../src/ai/site-store.js";

test("Unit site store: records and lists temporary callback sites", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-site-store-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    await recordTemporarySite({
      outputRoot,
      site: {
        id: "site_1",
        projectId: "proj_test",
        identityId: "id_123",
        domainId: "dom_1",
        host: "cb.domain.local",
        callbackPath: "/callback",
        callbackUrl: "https://cb.domain.local/callback",
        status: "ACTIVE",
        dnsCleanupStatus: "PENDING",
        dnsCleanupContract: { provider: "cloudflare" },
        metadata: { scenario: "otp" },
      },
      context: {
        source: "site-create",
        idempotencyKey: "idem-site-1",
      },
    });

    const allSites = await listSites({ outputRoot });
    assert.equal(allSites.sites.length, 1);
    assert.equal(allSites.sites[0].siteId, "site_1");
    assert.equal(allSites.sites[0].callbackUrl, "https://cb.domain.local/callback");

    const filtered = await listSites({ outputRoot, identityId: "id_123" });
    assert.equal(filtered.sites.length, 1);
    assert.equal(filtered.sites[0].identityId, "id_123");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
