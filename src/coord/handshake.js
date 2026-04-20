// LOCK / ACK / RELEASE handshake — #A9, spec §5.6.
//
// Cross-persona coordination primitive. One lock file per hashed repo path
// under .sentinel/locks/<hash>.lock.json. All state transitions stream into
// .sentinel/events.jsonl via events-log.js so the same log can drive Omar
// Gate's layer 2 lease verification, replay, and operator dashboards.
//
// Concurrency model:
//   - A dir-based mutex at .sentinel/.lock-mutex.lock serializes every
//     acquire / release so read-check-write races cannot split decisions.
//   - The mutex is ~microseconds for well-behaved callers; the tradeoff is
//     simplicity vs the wall clock of a fine-grained atomic design, and
//     with ≤13 personas it's the right call.
//   - Lock files are written via temp + rename for atomic publish once the
//     acquire decision is committed.
//
// Fairness model:
//   - Same-agent calls renew (the common re-entrant case during retries).
//   - Higher-priority caller preempts and publishes a lock_preempted event
//     so the incumbent can resume or bail.
//   - Lower-or-equal priority caller is denied and a waiter entry is
//     recorded for detectDeadlock().

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { appendEvent } from "./events-log.js";
import {
  resolveLocksDir,
  resolveMutexLockPath,
  resolveSentinelDir,
  resolveWaitsLockPath,
  resolveWaitsPath,
  hashLockKey,
  lockFileFor,
  normalizeLockPath,
} from "./paths.js";
import {
  PERSONA_PRIORITY,
  lowestPriorityAgent,
  outranks,
  priorityIndex,
} from "./priority.js";
import { findCycles } from "./tarjan.js";

const LOCK_SCHEMA_VERSION = "1.0.0";
const MAX_TTL_S = 300;
const MIN_TTL_S = 1;
const DEFAULT_TTL_S = 120;
const MUTEX_TIMEOUT_MS = 10_000;
const MUTEX_STALE_MS = 30_000;
const MUTEX_POLL_MS = 25;
const WAIT_TTL_MS = 10 * 60 * 1000; // 10 minutes — waits older than this are stale.

function normalizeAgent(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeReason(value) {
  return String(value || "").trim();
}

function normalizeTtlSeconds(value) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_TTL_S;
  }
  const floored = Math.floor(candidate);
  if (floored < MIN_TTL_S) {
    return MIN_TTL_S;
  }
  if (floored > MAX_TTL_S) {
    return MAX_TTL_S;
  }
  return floored;
}

function isoNow() {
  return new Date().toISOString();
}

function isExpired(grant, nowIso = isoNow()) {
  if (!grant || !grant.expiresAt) {
    return false;
  }
  const expiresEpoch = Date.parse(grant.expiresAt);
  const nowEpoch = Date.parse(nowIso);
  if (!Number.isFinite(expiresEpoch) || !Number.isFinite(nowEpoch)) {
    return false;
  }
  return nowEpoch >= expiresEpoch;
}

async function readLockFile(lockPath) {
  try {
    const raw = await fsp.readFile(lockPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function writeLockFileAtomic(lockPath, grant) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(grant, null, 2)}\n`, "utf-8");
  await fsp.rename(tmpPath, lockPath);
}

async function deleteLockFile(lockPath) {
  await fsp.rm(lockPath, { force: true }).catch(() => {});
}

async function acquireMutex(
  lockPath,
  {
    timeoutMs = MUTEX_TIMEOUT_MS,
    staleMs = MUTEX_STALE_MS,
    pollMs = MUTEX_POLL_MS,
  } = {}
) {
  const start = Date.now();
  while (true) {
    try {
      await fsp.mkdir(lockPath);
      return;
    } catch (err) {
      const code = err && typeof err === "object" ? err.code : "";
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
        throw err;
      }
      try {
        const stat = await fsp.stat(lockPath);
        const ageMs = Date.now() - Number(stat.mtimeMs || 0);
        if (Number.isFinite(ageMs) && ageMs > staleMs) {
          await fsp.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Stat race — loop back.
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error("Timed out waiting for .sentinel handshake mutex.");
      }
      await sleep(pollMs);
    }
  }
}

async function releaseMutex(lockPath) {
  await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

async function withHandshakeMutex(targetPath, fn) {
  const sentinelDir = resolveSentinelDir({ targetPath });
  await fsp.mkdir(sentinelDir, { recursive: true });
  const mutexPath = resolveMutexLockPath({ targetPath });
  await acquireMutex(mutexPath);
  try {
    return await fn();
  } finally {
    await releaseMutex(mutexPath);
  }
}

// ---------------- Waiters registry ----------------

async function acquireWaitsMutex(waitsLockPath) {
  await acquireMutex(waitsLockPath);
}

async function releaseWaitsMutex(waitsLockPath) {
  await releaseMutex(waitsLockPath);
}

async function readWaitsRegistry(waitsPath) {
  try {
    const raw = await fsp.readFile(waitsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { entries: {} };
    }
    return {
      entries:
        parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries)
          ? parsed.entries
          : {},
    };
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return { entries: {} };
    }
    throw err;
  }
}

async function writeWaitsRegistryAtomic(waitsPath, registry) {
  await fsp.mkdir(path.dirname(waitsPath), { recursive: true });
  const tmpPath = `${waitsPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
  await fsp.rename(tmpPath, waitsPath);
}

function pruneStaleWaits(entries, nowEpoch = Date.now()) {
  const next = {};
  const dropped = [];
  for (const [agent, entry] of Object.entries(entries || {})) {
    const recordedAt = Date.parse(entry?.recordedAt || "");
    if (!Number.isFinite(recordedAt) || nowEpoch - recordedAt > WAIT_TTL_MS) {
      dropped.push({ agent, entry });
      continue;
    }
    next[agent] = entry;
  }
  return { entries: next, dropped };
}

async function mutateWaitsRegistry(targetPath, mutator) {
  const waitsPath = resolveWaitsPath({ targetPath });
  const waitsLockPath = resolveWaitsLockPath({ targetPath });
  const sentinelDir = resolveSentinelDir({ targetPath });
  await fsp.mkdir(sentinelDir, { recursive: true });
  await acquireWaitsMutex(waitsLockPath);
  try {
    const registry = await readWaitsRegistry(waitsPath);
    const pruned = pruneStaleWaits(registry.entries, Date.now());
    registry.entries = pruned.entries;
    const result = await mutator(registry, pruned.dropped);
    await writeWaitsRegistryAtomic(waitsPath, registry);
    return { result, dropped: pruned.dropped };
  } finally {
    await releaseWaitsMutex(waitsLockPath);
  }
}

async function recordWaiter({
  targetPath,
  agent,
  blockedPath,
  waitingForAgent,
  reason,
}) {
  const nowIso = isoNow();
  await mutateWaitsRegistry(targetPath, async (registry) => {
    registry.entries[agent] = {
      agent,
      blockedPath,
      waitingForAgent,
      reason,
      recordedAt: nowIso,
    };
    return registry.entries[agent];
  });
  await appendEvent(
    {
      type: "wait_recorded",
      agent,
      path: blockedPath,
      waitingForAgent,
      reason,
      ts: nowIso,
    },
    { targetPath }
  );
}

async function clearWaiter({ targetPath, agent, pathHint }) {
  const nowIso = isoNow();
  let cleared = null;
  await mutateWaitsRegistry(targetPath, async (registry) => {
    const existing = registry.entries[agent];
    if (existing) {
      cleared = existing;
      delete registry.entries[agent];
    }
    return cleared;
  });
  if (cleared) {
    await appendEvent(
      {
        type: "wait_cleared",
        agent,
        path: pathHint || cleared.blockedPath,
        ts: nowIso,
      },
      { targetPath }
    );
  }
  return cleared;
}

export async function listWaiters({ targetPath = process.cwd() } = {}) {
  const { result } = await mutateWaitsRegistry(targetPath, async (registry) =>
    Object.values(registry.entries)
  );
  return result;
}

// ---------------- Active lock scanning ----------------

async function scanActiveLocks(targetPath) {
  const locksDir = resolveLocksDir({ targetPath });
  let entries;
  try {
    entries = await fsp.readdir(locksDir);
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const locks = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lock.json")) {
      continue;
    }
    const lockPath = path.join(locksDir, entry);
    const grant = await readLockFile(lockPath);
    if (!grant) {
      continue;
    }
    locks.push({ ...grant, lockFile: lockPath });
  }
  return locks;
}

async function sweepExpiredLocks(targetPath, nowIso = isoNow()) {
  const active = await scanActiveLocks(targetPath);
  const expired = [];
  for (const grant of active) {
    if (!isExpired(grant, nowIso)) {
      continue;
    }
    await deleteLockFile(grant.lockFile);
    expired.push(grant);
    await appendEvent(
      {
        type: "lock_expired",
        path: grant.path,
        agent: grant.agent,
        token: grant.token,
        ts: nowIso,
      },
      { targetPath }
    );
  }
  return expired;
}

// ---------------- Public API ----------------

export async function requestLock(req, { targetPath = process.cwd() } = {}) {
  const agent = normalizeAgent(req?.agent);
  if (!agent) {
    throw new Error("agent is required.");
  }
  const normalizedPath = normalizeLockPath(req?.path, { targetPath });
  const reason = normalizeReason(req?.reason);
  const ttlSeconds = normalizeTtlSeconds(req?.ttl_s ?? req?.ttlSeconds);

  return withHandshakeMutex(targetPath, async () => {
    const nowIso = isoNow();
    const lockPath = lockFileFor(normalizedPath, { targetPath });
    let existing = await readLockFile(lockPath);

    if (existing && isExpired(existing, nowIso)) {
      await deleteLockFile(lockPath);
      await appendEvent(
        {
          type: "lock_expired",
          path: existing.path,
          agent: existing.agent,
          token: existing.token,
          ts: nowIso,
        },
        { targetPath }
      );
      existing = null;
    }

    if (existing) {
      if (normalizeAgent(existing.agent) === agent) {
        const renewedExpiresAt = new Date(
          Date.parse(nowIso) + ttlSeconds * 1000
        ).toISOString();
        const renewed = {
          ...existing,
          grantedAt: existing.grantedAt || nowIso,
          expiresAt: renewedExpiresAt,
          ttlSeconds,
          reason: reason || existing.reason || "",
        };
        await writeLockFileAtomic(lockPath, renewed);
        await appendEvent(
          {
            type: "lock_renewed",
            path: renewed.path,
            agent: renewed.agent,
            token: renewed.token,
            ttlSeconds,
            expiresAt: renewed.expiresAt,
            ts: nowIso,
          },
          { targetPath }
        );
        await clearWaiter({ targetPath, agent, pathHint: normalizedPath });
        return {
          granted: true,
          renewed: true,
          ...publicGrant(renewed),
        };
      }

      if (outranks(agent, existing.agent)) {
        await deleteLockFile(lockPath);
        await appendEvent(
          {
            type: "lock_preempted",
            path: normalizedPath,
            preempted: existing.agent,
            preemptedToken: existing.token,
            newAgent: agent,
            ts: nowIso,
          },
          { targetPath }
        );
        existing = null;
      } else {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((Date.parse(existing.expiresAt) - Date.parse(nowIso)) / 1000)
        );
        await appendEvent(
          {
            type: "lock_denied",
            path: normalizedPath,
            agent,
            heldBy: existing.agent,
            retryAfterSeconds,
            ts: nowIso,
          },
          { targetPath }
        );
        await recordWaiter({
          targetPath,
          agent,
          blockedPath: normalizedPath,
          waitingForAgent: normalizeAgent(existing.agent),
          reason,
        });
        return {
          granted: false,
          retryAfterSeconds,
          heldBy: normalizeAgent(existing.agent),
          path: normalizedPath,
        };
      }
    }

    const token = crypto.randomUUID();
    const grant = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      path: normalizedPath,
      agent,
      token,
      grantedAt: nowIso,
      expiresAt: new Date(Date.parse(nowIso) + ttlSeconds * 1000).toISOString(),
      ttlSeconds,
      reason,
      holderPid: process.pid,
      holderHostname: os.hostname(),
    };
    await writeLockFileAtomic(lockPath, grant);

    const verify = await readLockFile(lockPath);
    if (!verify || verify.token !== token) {
      // Raced with someone else — under the mutex this should never happen,
      // but defensive: report as a retry-after-1s denial rather than claiming
      // a grant we don't actually own.
      return {
        granted: false,
        retryAfterSeconds: 1,
        heldBy: verify ? normalizeAgent(verify.agent) : null,
        path: normalizedPath,
      };
    }

    await appendEvent(
      {
        type: "lock_granted",
        path: normalizedPath,
        agent,
        token,
        ttlSeconds,
        expiresAt: grant.expiresAt,
        reason,
        ts: nowIso,
      },
      { targetPath }
    );
    await clearWaiter({ targetPath, agent, pathHint: normalizedPath });
    return {
      granted: true,
      renewed: false,
      ...publicGrant(grant),
    };
  });
}

export async function releaseLock(
  pathValue,
  agentValue,
  tokenValue,
  diffHash,
  { targetPath = process.cwd() } = {}
) {
  const agent = normalizeAgent(agentValue);
  if (!agent) {
    throw new Error("agent is required.");
  }
  const token = String(tokenValue || "").trim();
  if (!token) {
    throw new Error("token is required.");
  }
  const normalizedPath = normalizeLockPath(pathValue, { targetPath });

  return withHandshakeMutex(targetPath, async () => {
    const nowIso = isoNow();
    const lockPath = lockFileFor(normalizedPath, { targetPath });
    const existing = await readLockFile(lockPath);
    if (!existing) {
      return { released: false, reason: "not_locked", path: normalizedPath };
    }
    if (
      normalizeAgent(existing.agent) !== agent ||
      existing.token !== token
    ) {
      return {
        released: false,
        reason: "mismatched_lease",
        path: normalizedPath,
        heldBy: normalizeAgent(existing.agent),
      };
    }
    await deleteLockFile(lockPath);
    const normalizedDiffHash = String(diffHash || "").trim() || null;
    await appendEvent(
      {
        type: "lock_released",
        path: normalizedPath,
        agent,
        token,
        diffHash: normalizedDiffHash,
        ts: nowIso,
      },
      { targetPath }
    );
    return {
      released: true,
      path: normalizedPath,
      agent,
      token,
      diffHash: normalizedDiffHash,
    };
  });
}

export async function listActiveLocks({ targetPath = process.cwd() } = {}) {
  return withHandshakeMutex(targetPath, async () => {
    const nowIso = isoNow();
    await sweepExpiredLocks(targetPath, nowIso);
    const active = await scanActiveLocks(targetPath);
    return active.map((grant) => publicGrant(grant));
  });
}

export async function checkLock(pathValue, { targetPath = process.cwd() } = {}) {
  const normalizedPath = normalizeLockPath(pathValue, { targetPath });
  return withHandshakeMutex(targetPath, async () => {
    const nowIso = isoNow();
    const lockPath = lockFileFor(normalizedPath, { targetPath });
    const existing = await readLockFile(lockPath);
    if (!existing) {
      return null;
    }
    if (isExpired(existing, nowIso)) {
      await deleteLockFile(lockPath);
      await appendEvent(
        {
          type: "lock_expired",
          path: existing.path,
          agent: existing.agent,
          token: existing.token,
          ts: nowIso,
        },
        { targetPath }
      );
      return null;
    }
    return publicGrant(existing);
  });
}

export async function detectDeadlock({ targetPath = process.cwd() } = {}) {
  return withHandshakeMutex(targetPath, async () => {
    const nowIso = isoNow();
    await sweepExpiredLocks(targetPath, nowIso);

    const active = await scanActiveLocks(targetPath);
    const holdings = new Map(); // path -> agent
    const heldByAgent = new Map(); // agent -> [paths]
    for (const grant of active) {
      holdings.set(grant.path, normalizeAgent(grant.agent));
      const list = heldByAgent.get(normalizeAgent(grant.agent)) || [];
      list.push(grant.path);
      heldByAgent.set(normalizeAgent(grant.agent), list);
    }

    const { result: waiters } = await mutateWaitsRegistry(
      targetPath,
      async (registry) => Object.values(registry.entries)
    );

    const adjacency = {};
    for (const waiter of waiters) {
      const waitingForAgent =
        waiter.waitingForAgent || holdings.get(waiter.blockedPath);
      if (!waitingForAgent || waitingForAgent === waiter.agent) {
        continue;
      }
      const list = adjacency[waiter.agent] || [];
      if (!list.includes(waitingForAgent)) {
        list.push(waitingForAgent);
      }
      adjacency[waiter.agent] = list;
    }

    const cycles = findCycles(adjacency);
    const broken = [];
    for (const cycle of cycles) {
      const victim = lowestPriorityAgent(cycle);
      if (!victim) {
        continue;
      }
      const victimPaths = heldByAgent.get(victim) || [];
      const releasedPaths = [];
      for (const victimPath of victimPaths) {
        const lockPath = lockFileFor(victimPath, { targetPath });
        const grant = await readLockFile(lockPath);
        if (!grant) {
          continue;
        }
        await deleteLockFile(lockPath);
        releasedPaths.push(victimPath);
        await appendEvent(
          {
            type: "lock_preempted",
            path: victimPath,
            preempted: victim,
            preemptedToken: grant.token,
            newAgent: null,
            reason: "deadlock_broken",
            ts: nowIso,
          },
          { targetPath }
        );
      }
      await appendEvent(
        {
          type: "deadlock_broken",
          cycle,
          victim,
          releasedPaths,
          ts: nowIso,
        },
        { targetPath }
      );
      broken.push({ cycle, victim, releasedPaths });
    }
    return { cycles, broken };
  });
}

function publicGrant(grant) {
  if (!grant) {
    return null;
  }
  return {
    schemaVersion: grant.schemaVersion || LOCK_SCHEMA_VERSION,
    path: grant.path,
    agent: normalizeAgent(grant.agent),
    token: grant.token,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    ttlSeconds: grant.ttlSeconds,
    reason: grant.reason || "",
    holderPid: grant.holderPid,
    holderHostname: grant.holderHostname,
  };
}

export {
  DEFAULT_TTL_S,
  LOCK_SCHEMA_VERSION,
  MAX_TTL_S,
  MIN_TTL_S,
  PERSONA_PRIORITY,
  hashLockKey,
  normalizeLockPath,
  outranks,
  priorityIndex,
};
