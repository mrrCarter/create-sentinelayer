import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { listErrorQueue } from "../src/daemon/error-worker.js";
import {
  getReliabilityLaneStatus,
  runReliabilityLane,
  setMaintenanceBillboard,
} from "../src/daemon/reliability-lane.js";

test("Unit daemon reliability lane: failing synthetic run opens maintenance billboard and queues daemon work", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-reliability-fail-"));
  try {
    const executed = await runReliabilityLane({
      targetPath: tempRoot,
      region: "us-east-1",
      timezone: "America/New_York",
      simulateFailures: ["aidenid_password_reset_flow"],
      nowIso: "2026-04-02T04:00:00.000Z",
    });
    assert.equal(executed.overallStatus, "FAIL");
    assert.equal(executed.failureCount, 1);
    assert.equal(executed.maintenance.enabled, true);
    assert.equal(executed.worker !== null, true);

    const queue = await listErrorQueue({
      targetPath: tempRoot,
      limit: 20,
    });
    assert.equal(queue.totalCount >= 1, true);
    assert.equal(
      queue.items.some((item) => String(item.endpoint || "").includes("/synthetic/aidenid_password_reset_flow")),
      true
    );

    const status = await getReliabilityLaneStatus({
      targetPath: tempRoot,
      limit: 5,
    });
    assert.equal(status.billboard.enabled, true);
    assert.equal(status.recentRuns.length, 1);
    assert.equal(status.recentRuns[0].overallStatus, "FAIL");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon reliability lane: passing run clears reliability maintenance billboard and manual toggles persist", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-reliability-pass-"));
  try {
    await runReliabilityLane({
      targetPath: tempRoot,
      simulateFailures: ["aidenid_invite_flow"],
      nowIso: "2026-04-02T04:10:00.000Z",
    });
    const passing = await runReliabilityLane({
      targetPath: tempRoot,
      nowIso: "2026-04-03T04:10:00.000Z",
      clearMaintenanceOnPass: true,
    });
    assert.equal(passing.overallStatus, "PASS");
    assert.equal(passing.maintenance.enabled, false);

    const manualOn = await setMaintenanceBillboard({
      targetPath: tempRoot,
      enabled: true,
      message: "manual maintenance",
      source: "manual",
      actor: "maya.markov@sentinelayer.local",
      nowIso: "2026-04-03T04:20:00.000Z",
    });
    assert.equal(manualOn.billboard.enabled, true);
    assert.equal(manualOn.billboard.message, "manual maintenance");

    const manualOff = await setMaintenanceBillboard({
      targetPath: tempRoot,
      enabled: false,
      message: "",
      source: "manual",
      actor: "maya.markov@sentinelayer.local",
      nowIso: "2026-04-03T04:21:00.000Z",
    });
    assert.equal(manualOff.billboard.enabled, false);

    const status = await getReliabilityLaneStatus({
      targetPath: tempRoot,
      limit: 5,
    });
    assert.equal(status.billboard.enabled, false);
    assert.equal(status.recentRuns.length >= 2, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
