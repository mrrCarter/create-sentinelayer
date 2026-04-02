import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  getDomainById,
  getTargetById,
  listDomainTargetRecords,
  recordDomainProofResponse,
  recordTargetProofResponse,
} from "../src/ai/domain-target-store.js";

test("Unit domain/target store: records and reads domain proof metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-domain-store-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    await recordDomainProofResponse({
      outputRoot,
      domain: {
        id: "dom_1",
        domainName: "swarm.customer.local",
        verificationStatus: "PENDING",
        freezeStatus: "ACTIVE",
        projectId: "proj_test",
      },
      proof: {
        proofId: "proof_dom_1",
        challengeValue: "aidenid-domain-challenge",
        proofStatus: "PENDING",
      },
      context: {
        source: "domain-create",
        idempotencyKey: "idem-domain-create",
      },
    });

    const records = await listDomainTargetRecords({ outputRoot });
    assert.equal(records.domains.length, 1);
    assert.equal(records.domains[0].domainId, "dom_1");
    assert.equal(records.domains[0].challengeValue, "aidenid-domain-challenge");

    const fetched = await getDomainById({ outputRoot, domainId: "dom_1" });
    assert.ok(fetched.domain);
    assert.equal(fetched.domain.domainName, "swarm.customer.local");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit domain/target store: records and reads target proof metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-domain-store-"));
  try {
    const outputRoot = path.join(tempRoot, ".sentinelayer");
    await recordTargetProofResponse({
      outputRoot,
      target: {
        id: "tgt_1",
        host: "api.swarm.customer.local",
        domainId: "dom_1",
        verificationStatus: "PENDING",
        status: "PENDING",
        freezeStatus: "ACTIVE",
        projectId: "proj_test",
        policy: {
          allowedPaths: ["/auth/*"],
          allowedMethods: ["GET", "POST"],
          allowedScenarios: ["signup_burst"],
          maxRps: 25,
          maxConcurrency: 10,
          stopConditions: {},
        },
      },
      proof: {
        proofId: "proof_tgt_1",
        challengeValue: "aidenid-target-challenge",
        proofStatus: "PENDING",
      },
      context: {
        source: "target-create",
        idempotencyKey: "idem-target-create",
      },
    });

    const records = await listDomainTargetRecords({ outputRoot });
    assert.equal(records.targets.length, 1);
    assert.equal(records.targets[0].targetId, "tgt_1");
    assert.equal(records.targets[0].challengeValue, "aidenid-target-challenge");

    const fetched = await getTargetById({ outputRoot, targetId: "tgt_1" });
    assert.ok(fetched.target);
    assert.equal(fetched.target.host, "api.swarm.customer.local");
    assert.deepEqual(fetched.target.policy.allowedMethods, ["GET", "POST"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
