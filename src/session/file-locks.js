import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { createAgentEvent } from "../events/schema.js";
import { resolveSessionPaths } from "./paths.js";
import { appendToStream } from "./stream.js";

const FILE_LOCK_SCHEMA_VERSION = "1.0.0";
const DEFAULT_FILE_LOCK_TTL_SECONDS = 300;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 25;
const SENTI_AGENT_ID = "senti";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeIsoTimestamp(value, fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallbackIso;
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    return fallbackIso;
  }
  return new Date(epoch).toISOString();
}

function normalizePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Value must be a positive integer.");
  }
  return Math.floor(normalized);
}

function toIsoAfterSeconds(nowIso, seconds) {
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, nowIso));
  return new Date(nowEpoch + Math.max(1, Math.floor(Number(seconds) || 0)) * 1000).toISOString();
}

function parseEpoch(value, fallbackIso = new Date().toISOString()) {
  return Date.parse(normalizeIsoTimestamp(value, fallbackIso)) || 0;
}

function formatSince(fromIso, nowIso = new Date().toISOString()) {
  const nowEpoch = parseEpoch(nowIso, nowIso);
  const fromEpoch = parseEpoch(fromIso, nowIso);
  const deltaMs = Math.max(0, nowEpoch - fromEpoch);
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function normalizeFilePath(filePath, { targetPath = process.cwd() } = {}) {
  const raw = normalizeString(filePath);
  if (!raw) {
    throw new Error("filePath is required.");
  }

  let normalized = raw;
  if (path.isAbsolute(raw)) {
    normalized = path.relative(path.resolve(String(targetPath || ".")), path.resolve(raw));
  }
  normalized = normalizeString(normalized).replace(/\\/g, "/");
  normalized = normalized.replace(/^\.\/+/, "");
  if (!normalized || normalized === ".") {
    throw new Error("filePath is required.");
  }
  return normalized;
}

function normalizeAgentId(agentId) {
  const normalized = normalizeString(agentId).toLowerCase();
  if (!normalized) {
    throw new Error("agentId is required.");
  }
  return normalized;
}

function isLockExpired(lockRecord, nowIso = new Date().toISOString()) {
  const nowEpoch = parseEpoch(nowIso, nowIso);
  const expiresAtEpoch = parseEpoch(lockRecord?.expiresAt, nowIso);
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(expiresAtEpoch)) {
    return false;
  }
  return nowEpoch >= expiresAtEpoch;
}

function normalizeLockRecord(filePath, raw = {}, { nowIso = new Date().toISOString() } = {}) {
  const normalizedFile = normalizeString(filePath);
  if (!normalizedFile) {
    return null;
  }
  const agentId = normalizeString(raw.agentId).toLowerCase();
  if (!agentId) {
    return null;
  }
  const ttlSeconds = normalizePositiveInteger(raw.ttlSeconds, DEFAULT_FILE_LOCK_TTL_SECONDS);
  const lockedAt = normalizeIsoTimestamp(raw.lockedAt, nowIso);
  const expiresAt = normalizeIsoTimestamp(raw.expiresAt, toIsoAfterSeconds(lockedAt, ttlSeconds));
  return {
    file: normalizedFile,
    agentId,
    intent: normalizeString(raw.intent),
    lockedAt,
    expiresAt,
    ttlSeconds,
  };
}

function normalizeRegistry(raw = {}, { sessionId, nowIso = new Date().toISOString() } = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const inputLocks = source.locks && typeof source.locks === "object" ? source.locks : {};
  const locks = {};
  for (const [filePath, value] of Object.entries(inputLocks)) {
    const normalizedFilePath = normalizeString(filePath);
    if (!normalizedFilePath) {
      continue;
    }
    const record = normalizeLockRecord(normalizedFilePath, value, { nowIso });
    if (!record) {
      continue;
    }
    locks[normalizedFilePath] = record;
  }

  return {
    schemaVersion: FILE_LOCK_SCHEMA_VERSION,
    sessionId: normalizeString(source.sessionId) || normalizeString(sessionId),
    updatedAt: normalizeIsoTimestamp(source.updatedAt, nowIso),
    locks,
  };
}

async function readJsonFile(filePath, { allowMissing = true } = {}) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (allowMissing && error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await fsp.rename(tmpPath, filePath);
}

async function ensureSessionExists(paths) {
  try {
    await fsp.access(paths.metadataPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`Session '${paths.sessionId}' was not found.`);
    }
    throw error;
  }
}

async function acquireLock(lockPath, {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
  pollMs = DEFAULT_LOCK_POLL_MS,
} = {}) {
  const start = Date.now();
  while (true) {
    try {
      await fsp.mkdir(lockPath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      if (!(code === "EEXIST" || code === "EPERM" || code === "EACCES")) {
        throw error;
      }

      try {
        const stat = await fsp.stat(lockPath);
        const ageMs = Date.now() - Number(stat.mtimeMs || 0);
        if (Number.isFinite(ageMs) && ageMs > staleMs) {
          await fsp.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Continue waiting.
      }

      if (Date.now() - start >= timeoutMs) {
        throw new Error("Timed out waiting for session file lock registry.");
      }
      await sleep(pollMs);
    }
  }
}

async function releaseLock(lockPath) {
  await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

function pruneExpiredLocks(registry, { nowIso = new Date().toISOString() } = {}) {
  const expired = [];
  for (const [filePath, lockRecord] of Object.entries(registry.locks || {})) {
    if (!isLockExpired(lockRecord, nowIso)) {
      continue;
    }
    expired.push({
      ...lockRecord,
      file: filePath,
      expiredAt: normalizeIsoTimestamp(nowIso, new Date().toISOString()),
    });
    delete registry.locks[filePath];
  }
  return expired;
}

function presentLock(lockRecord, { nowIso = new Date().toISOString() } = {}) {
  if (!lockRecord) {
    return null;
  }
  return {
    file: normalizeString(lockRecord.file),
    agentId: normalizeString(lockRecord.agentId),
    intent: normalizeString(lockRecord.intent),
    lockedAt: normalizeIsoTimestamp(lockRecord.lockedAt, nowIso),
    expiresAt: normalizeIsoTimestamp(lockRecord.expiresAt, nowIso),
    ttlSeconds: normalizePositiveInteger(lockRecord.ttlSeconds, DEFAULT_FILE_LOCK_TTL_SECONDS),
    since: formatSince(lockRecord.lockedAt, nowIso),
  };
}

async function appendLockEvent(
  sessionId,
  event,
  agentId,
  payload,
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  return appendToStream(
    sessionId,
    createAgentEvent({
      event,
      agentId: normalizeAgentId(agentId),
      sessionId,
      ts: normalizeIsoTimestamp(nowIso, new Date().toISOString()),
      payload,
    }),
    {
      targetPath,
    }
  );
}

async function emitExpiredLockEvents(
  sessionId,
  expiredLocks = [],
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    actorAgentId = SENTI_AGENT_ID,
  } = {}
) {
  const events = [];
  for (const lockRecord of expiredLocks) {
    const payload = {
      file: normalizeString(lockRecord.file),
      heldBy: normalizeString(lockRecord.agentId),
      intent: normalizeString(lockRecord.intent),
      lockedAt: normalizeIsoTimestamp(lockRecord.lockedAt, nowIso),
      expiresAt: normalizeIsoTimestamp(lockRecord.expiresAt, nowIso),
      expiredAt: normalizeIsoTimestamp(nowIso, new Date().toISOString()),
    };
    const event = await appendLockEvent(
      sessionId,
      "file_lock_expired",
      actorAgentId,
      payload,
      {
        targetPath,
        nowIso,
      }
    );
    events.push(event);
  }
  return events;
}

async function mutateRegistry(
  sessionId,
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    emitExpiredEvents = true,
    expiredEventAgentId = SENTI_AGENT_ID,
  } = {},
  mutator = async () => ({})
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  await ensureSessionExists(paths);
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());

  await acquireLock(paths.fileLocksLockPath);
  let result = null;
  let expiredLocks = [];
  try {
    const rawRegistry = await readJsonFile(paths.fileLocksPath, { allowMissing: true });
    const registry = normalizeRegistry(rawRegistry || {}, {
      sessionId: paths.sessionId,
      nowIso: normalizedNow,
    });
    expiredLocks = pruneExpiredLocks(registry, {
      nowIso: normalizedNow,
    });
    result = await mutator(registry, {
      nowIso: normalizedNow,
      paths,
    });
    registry.updatedAt = normalizedNow;
    await writeJsonFile(paths.fileLocksPath, registry);
  } finally {
    await releaseLock(paths.fileLocksLockPath);
  }

  const expiredEvents = emitExpiredEvents
    ? await emitExpiredLockEvents(sessionId, expiredLocks, {
        targetPath,
        nowIso: normalizedNow,
        actorAgentId: expiredEventAgentId,
      })
    : [];

  return {
    result,
    expiredLocks,
    expiredEvents,
  };
}

export async function lockFile(
  sessionId,
  agentId,
  filePath,
  {
    intent = "",
    ttlSeconds = DEFAULT_FILE_LOCK_TTL_SECONDS,
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedFilePath = normalizeFilePath(filePath, { targetPath });
  const normalizedIntent = normalizeString(intent);
  const normalizedTtlSeconds = normalizePositiveInteger(ttlSeconds, DEFAULT_FILE_LOCK_TTL_SECONDS);
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());

  const mutation = await mutateRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
      emitExpiredEvents: true,
      expiredEventAgentId: SENTI_AGENT_ID,
    },
    async (registry) => {
      const existing = registry.locks[normalizedFilePath] || null;
      if (existing && existing.agentId !== normalizedAgentId) {
        return {
          locked: false,
          file: normalizedFilePath,
          heldBy: normalizeString(existing.agentId),
          since: formatSince(existing.lockedAt, normalizedNow),
          lock: presentLock({ ...existing, file: normalizedFilePath }, { nowIso: normalizedNow }),
        };
      }

      const lockedAt = normalizedNow;
      const expiresAt = toIsoAfterSeconds(lockedAt, normalizedTtlSeconds);
      const lockRecord = {
        file: normalizedFilePath,
        agentId: normalizedAgentId,
        intent: normalizedIntent,
        lockedAt,
        expiresAt,
        ttlSeconds: normalizedTtlSeconds,
      };
      registry.locks[normalizedFilePath] = lockRecord;
      return {
        locked: true,
        file: normalizedFilePath,
        lock: presentLock(lockRecord, { nowIso: normalizedNow }),
      };
    }
  );

  if (mutation.result?.locked) {
    const event = await appendLockEvent(
      sessionId,
      "file_lock",
      normalizedAgentId,
      {
        file: normalizedFilePath,
        intent: normalizedIntent,
        ttlSeconds: normalizedTtlSeconds,
        expiresAt: mutation.result.lock?.expiresAt || toIsoAfterSeconds(normalizedNow, normalizedTtlSeconds),
      },
      {
        targetPath,
        nowIso: normalizedNow,
      }
    );
    return {
      ...mutation.result,
      event,
      expiredEvents: mutation.expiredEvents,
    };
  }

  return {
    ...mutation.result,
    expiredEvents: mutation.expiredEvents,
  };
}

export async function unlockFile(
  sessionId,
  agentId,
  filePath,
  {
    reason = "manual_release",
    force = false,
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    actorAgentId = null,
  } = {}
) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedFilePath = normalizeFilePath(filePath, { targetPath });
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedReason = normalizeString(reason) || "manual_release";

  const mutation = await mutateRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
      emitExpiredEvents: true,
      expiredEventAgentId: SENTI_AGENT_ID,
    },
    async (registry) => {
      const existing = registry.locks[normalizedFilePath] || null;
      if (!existing) {
        return {
          unlocked: false,
          file: normalizedFilePath,
          reason: "not_locked",
        };
      }
      if (!force && normalizeString(existing.agentId) !== normalizedAgentId) {
        return {
          unlocked: false,
          file: normalizedFilePath,
          reason: "held_by_other_agent",
          heldBy: normalizeString(existing.agentId),
          since: formatSince(existing.lockedAt, normalizedNow),
          lock: presentLock({ ...existing, file: normalizedFilePath }, { nowIso: normalizedNow }),
        };
      }

      delete registry.locks[normalizedFilePath];
      return {
        unlocked: true,
        file: normalizedFilePath,
        lock: presentLock({ ...existing, file: normalizedFilePath }, { nowIso: normalizedNow }),
      };
    }
  );

  if (!mutation.result?.unlocked) {
    return {
      ...mutation.result,
      expiredEvents: mutation.expiredEvents,
    };
  }

  const emittedBy = normalizeAgentId(actorAgentId || (force ? SENTI_AGENT_ID : normalizedAgentId));
  const event = await appendLockEvent(
    sessionId,
    "file_unlock",
    emittedBy,
    {
      file: normalizedFilePath,
      heldBy: normalizeString(mutation.result.lock?.agentId) || normalizedAgentId,
      intent: normalizeString(mutation.result.lock?.intent),
      reason: normalizedReason,
    },
    {
      targetPath,
      nowIso: normalizedNow,
    }
  );

  return {
    ...mutation.result,
    event,
    expiredEvents: mutation.expiredEvents,
  };
}

export async function checkFileLock(
  sessionId,
  filePath,
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    emitExpiredEvents = true,
  } = {}
) {
  const normalizedFilePath = normalizeFilePath(filePath, { targetPath });
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());

  const mutation = await mutateRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
      emitExpiredEvents,
      expiredEventAgentId: SENTI_AGENT_ID,
    },
    async (registry) => {
      const existing = registry.locks[normalizedFilePath] || null;
      if (!existing) {
        return null;
      }
      return presentLock({ ...existing, file: normalizedFilePath }, { nowIso: normalizedNow });
    }
  );

  return mutation.result;
}

export async function listFileLocks(
  sessionId,
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    emitExpiredEvents = true,
  } = {}
) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());

  const mutation = await mutateRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
      emitExpiredEvents,
      expiredEventAgentId: SENTI_AGENT_ID,
    },
    async (registry) =>
      Object.entries(registry.locks || {})
        .map(([file, lockRecord]) => presentLock({ ...lockRecord, file }, { nowIso: normalizedNow }))
        .filter(Boolean)
        .sort((left, right) => parseEpoch(left.lockedAt, normalizedNow) - parseEpoch(right.lockedAt, normalizedNow))
  );

  return mutation.result;
}

export async function releaseFileLocksForAgent(
  sessionId,
  agentId,
  {
    reason = "agent_killed",
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    actorAgentId = SENTI_AGENT_ID,
  } = {}
) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedReason = normalizeString(reason) || "agent_killed";

  const mutation = await mutateRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
      emitExpiredEvents: true,
      expiredEventAgentId: normalizeAgentId(actorAgentId || SENTI_AGENT_ID),
    },
    async (registry) => {
      const released = [];
      for (const [filePath, lockRecord] of Object.entries(registry.locks || {})) {
        if (normalizeString(lockRecord.agentId) !== normalizedAgentId) {
          continue;
        }
        released.push(presentLock({ ...lockRecord, file: filePath }, { nowIso: normalizedNow }));
        delete registry.locks[filePath];
      }
      return released;
    }
  );

  const events = [];
  const actor = normalizeAgentId(actorAgentId || SENTI_AGENT_ID);
  for (const lockRecord of mutation.result || []) {
    const event = await appendLockEvent(
      sessionId,
      "file_unlock",
      actor,
      {
        file: normalizeString(lockRecord.file),
        heldBy: normalizedAgentId,
        intent: normalizeString(lockRecord.intent),
        reason: normalizedReason,
      },
      {
        targetPath,
        nowIso: normalizedNow,
      }
    );
    events.push(event);
  }

  return {
    releasedCount: events.length,
    released: mutation.result || [],
    events,
    expiredEvents: mutation.expiredEvents,
  };
}

export {
  DEFAULT_FILE_LOCK_TTL_SECONDS,
};
