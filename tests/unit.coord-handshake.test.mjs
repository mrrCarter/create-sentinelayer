// Unit tests for coord/handshake.js (#A9 LOCK/ACK/RELEASE + deadlock detection).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkLock,
  detectDeadlock,
  listActiveLocks,
  listWaiters,
  releaseLock,
  requestLock,
} from "../src/coord/handshake.js";
import { readEvents } from "../src/coord/events-log.js";
import {
  resolveLocksDir,
  lockFileFor,
} from "../src/coord/paths.js";

async function makeTempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-coord-handshake-"));
}

test("requestLock: grants when path is free", async () => {
  const targetPath = await makeTempRoot();
  try {
    const grant = await requestLock(
      {
        path: "app/layout.tsx",
        agent: "frontend",
        ttl_s: 60,
        reason: "scaffold layout shell",
      },
      { targetPath }
    );
    assert.equal(grant.granted, true);
    assert.equal(grant.path, "app/layout.tsx");
    assert.equal(grant.agent, "frontend");
    assert.equal(typeof grant.token, "string");
    assert.ok(grant.token.length > 10);
    assert.equal(grant.ttlSeconds, 60);
    assert.equal(grant.renewed, false);

    const events = await readEvents({ targetPath });
    assert.equal(events.filter((e) => e.type === "lock_granted").length, 1);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock: ttl clamped to MAX_TTL_S=300", async () => {
  const targetPath = await makeTempRoot();
  try {
    const grant = await requestLock(
      { path: "a.ts", agent: "backend", ttl_s: 9_999 },
      { targetPath }
    );
    assert.equal(grant.ttlSeconds, 300);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock: same-agent second call renews with same token", async () => {
  const targetPath = await makeTempRoot();
  try {
    const first = await requestLock(
      { path: "a.ts", agent: "backend", ttl_s: 30 },
      { targetPath }
    );
    const second = await requestLock(
      { path: "a.ts", agent: "backend", ttl_s: 120 },
      { targetPath }
    );
    assert.equal(second.granted, true);
    assert.equal(second.renewed, true);
    assert.equal(second.token, first.token);
    assert.equal(second.ttlSeconds, 120);

    const events = await readEvents({ targetPath });
    assert.equal(events.filter((e) => e.type === "lock_renewed").length, 1);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock: lower-priority agent is denied and becomes a waiter", async () => {
  const targetPath = await makeTempRoot();
  try {
    await requestLock(
      { path: "a.ts", agent: "architect", ttl_s: 120 },
      { targetPath }
    );
    const denied = await requestLock(
      { path: "a.ts", agent: "docs", ttl_s: 60, reason: "add changelog" },
      { targetPath }
    );
    assert.equal(denied.granted, false);
    assert.equal(denied.heldBy, "architect");
    assert.ok(denied.retryAfterSeconds >= 1);

    const waiters = await listWaiters({ targetPath });
    assert.equal(waiters.length, 1);
    assert.equal(waiters[0].agent, "docs");
    assert.equal(waiters[0].waitingForAgent, "architect");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock: higher-priority agent preempts lower-priority incumbent", async () => {
  const targetPath = await makeTempRoot();
  try {
    const lower = await requestLock(
      { path: "app/layout.tsx", agent: "docs", ttl_s: 120 },
      { targetPath }
    );
    assert.equal(lower.granted, true);

    const higher = await requestLock(
      { path: "app/layout.tsx", agent: "architect", ttl_s: 60 },
      { targetPath }
    );
    assert.equal(higher.granted, true);
    assert.equal(higher.agent, "architect");
    assert.notEqual(higher.token, lower.token);

    const events = await readEvents({ targetPath });
    const preemptions = events.filter((e) => e.type === "lock_preempted");
    assert.equal(preemptions.length, 1);
    assert.equal(preemptions[0].preempted, "docs");
    assert.equal(preemptions[0].newAgent, "architect");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock: grants after existing lock expires", async () => {
  const targetPath = await makeTempRoot();
  try {
    const grant = await requestLock(
      { path: "a.ts", agent: "backend", ttl_s: 1 },
      { targetPath }
    );
    // Manually age out the lock file by rewriting an expired expiresAt.
    const lockPath = lockFileFor("a.ts", { targetPath });
    const raw = JSON.parse(await fsp.readFile(lockPath, "utf-8"));
    raw.expiresAt = "2020-01-01T00:00:00.000Z";
    await fsp.writeFile(lockPath, JSON.stringify(raw), "utf-8");

    const second = await requestLock(
      { path: "a.ts", agent: "frontend", ttl_s: 30 },
      { targetPath }
    );
    assert.equal(second.granted, true);
    assert.equal(second.agent, "frontend");
    assert.notEqual(second.token, grant.token);

    const events = await readEvents({ targetPath });
    assert.ok(events.some((e) => e.type === "lock_expired"));
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("releaseLock: owner releases successfully and emits event", async () => {
  const targetPath = await makeTempRoot();
  try {
    const grant = await requestLock(
      { path: "a.ts", agent: "backend", ttl_s: 60 },
      { targetPath }
    );
    const release = await releaseLock(
      "a.ts",
      "backend",
      grant.token,
      "deadbeef",
      { targetPath }
    );
    assert.equal(release.released, true);
    assert.equal(release.diffHash, "deadbeef");

    const check = await checkLock("a.ts", { targetPath });
    assert.equal(check, null);

    const events = await readEvents({ targetPath });
    const released = events.filter((e) => e.type === "lock_released");
    assert.equal(released.length, 1);
    assert.equal(released[0].diffHash, "deadbeef");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("releaseLock: mismatched token does not release", async () => {
  const targetPath = await makeTempRoot();
  try {
    await requestLock(
      { path: "a.ts", agent: "backend", ttl_s: 60 },
      { targetPath }
    );
    const release = await releaseLock("a.ts", "backend", "wrong-token", "diff", {
      targetPath,
    });
    assert.equal(release.released, false);
    assert.equal(release.reason, "mismatched_lease");
    const check = await checkLock("a.ts", { targetPath });
    assert.ok(check);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("releaseLock: non-existent path reports not_locked", async () => {
  const targetPath = await makeTempRoot();
  try {
    const release = await releaseLock("never.ts", "backend", "tok", null, {
      targetPath,
    });
    assert.equal(release.released, false);
    assert.equal(release.reason, "not_locked");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("listActiveLocks: returns all unexpired locks", async () => {
  const targetPath = await makeTempRoot();
  try {
    await requestLock({ path: "a.ts", agent: "backend", ttl_s: 60 }, { targetPath });
    await requestLock({ path: "b.ts", agent: "frontend", ttl_s: 60 }, { targetPath });
    const active = await listActiveLocks({ targetPath });
    const paths = active.map((g) => g.path).sort();
    assert.deepEqual(paths, ["a.ts", "b.ts"]);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("detectDeadlock: 2-agent cycle is broken by preempting lowest priority", async () => {
  const targetPath = await makeTempRoot();
  try {
    // Two equal-priority workers deadlock each other: strict priority-based
    // preemption cannot break cycles between agents of the same tier, so
    // Tarjan-based detection is what has to kick in. worker-alpha vs
    // worker-bravo — both off-canon tie at the bottom, lexicographic order
    // makes worker-alpha the deterministic victim.
    await requestLock(
      { path: "a.ts", agent: "worker-alpha", ttl_s: 120 },
      { targetPath }
    );
    await requestLock(
      { path: "b.ts", agent: "worker-bravo", ttl_s: 120 },
      { targetPath }
    );
    const alphaBlocked = await requestLock(
      { path: "b.ts", agent: "worker-alpha", ttl_s: 60 },
      { targetPath }
    );
    assert.equal(alphaBlocked.granted, false);
    const bravoBlocked = await requestLock(
      { path: "a.ts", agent: "worker-bravo", ttl_s: 60 },
      { targetPath }
    );
    assert.equal(bravoBlocked.granted, false);

    const { cycles, broken } = await detectDeadlock({ targetPath });
    assert.equal(cycles.length, 1);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].victim, "worker-alpha");
    assert.ok(broken[0].releasedPaths.includes("a.ts"));

    const events = await readEvents({ targetPath });
    assert.ok(events.some((e) => e.type === "deadlock_broken"));

    // a.ts should now be unlocked; worker-bravo can take it.
    const regrant = await requestLock(
      { path: "a.ts", agent: "worker-bravo", ttl_s: 30 },
      { targetPath }
    );
    assert.equal(regrant.granted, true);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("detectDeadlock: no cycles → no breakage", async () => {
  const targetPath = await makeTempRoot();
  try {
    await requestLock({ path: "a.ts", agent: "architect", ttl_s: 120 }, { targetPath });
    const denied = await requestLock(
      { path: "a.ts", agent: "docs", ttl_s: 60 },
      { targetPath }
    );
    assert.equal(denied.granted, false);

    const { cycles, broken } = await detectDeadlock({ targetPath });
    assert.equal(cycles.length, 0);
    assert.equal(broken.length, 0);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock: writes lockfile under .sentinel/locks/<hash>.lock.json", async () => {
  const targetPath = await makeTempRoot();
  try {
    await requestLock(
      { path: "app/layout.tsx", agent: "frontend", ttl_s: 60 },
      { targetPath }
    );
    const locksDir = resolveLocksDir({ targetPath });
    const entries = await fsp.readdir(locksDir);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].endsWith(".lock.json"));
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock: concurrent same-path grants resolve to one winner", async () => {
  const targetPath = await makeTempRoot();
  try {
    // Both requesters share the same priority (both 'backend') so no preemption
    // — one acquires, the other sees an incumbent and gets denied.
    const [first, second] = await Promise.all([
      requestLock({ path: "shared.ts", agent: "backend", ttl_s: 60 }, { targetPath }),
      requestLock({ path: "shared.ts", agent: "backend", ttl_s: 60 }, { targetPath }),
    ]);
    // Same agent-id on both calls → both should end up granted (renewed). If
    // a future design denies same-agent retries, update this assertion.
    assert.ok(first.granted);
    assert.ok(second.granted);
    assert.equal(first.token, second.token);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("requestLock + releaseLock: multiple agents on disjoint paths are independent", async () => {
  const targetPath = await makeTempRoot();
  try {
    const grantA = await requestLock(
      { path: "pkg/a.ts", agent: "backend", ttl_s: 60 },
      { targetPath }
    );
    const grantB = await requestLock(
      { path: "pkg/b.ts", agent: "frontend", ttl_s: 60 },
      { targetPath }
    );
    assert.equal(grantA.granted, true);
    assert.equal(grantB.granted, true);
    assert.notEqual(grantA.token, grantB.token);

    const releaseA = await releaseLock(
      "pkg/a.ts",
      "backend",
      grantA.token,
      null,
      { targetPath }
    );
    assert.equal(releaseA.released, true);

    const active = await listActiveLocks({ targetPath });
    assert.equal(active.length, 1);
    assert.equal(active[0].path, "pkg/b.ts");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});
