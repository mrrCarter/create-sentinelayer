import fsp from "node:fs/promises";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { createAgentEvent, normalizeAgentEvent } from "../events/schema.js";
import { resolveSessionPaths } from "./paths.js";

const DEFAULT_POLL_MS = 500;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_MAX_STREAM_EVENTS = 10_000;

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

async function readSessionMetadata(paths) {
  try {
    const raw = await fsp.readFile(paths.metadataPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSessionMetadata(paths, metadata = {}) {
  await fsp.mkdir(paths.sessionDir, { recursive: true });
  const tmpPath = `${paths.metadataPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  await fsp.rename(tmpPath, paths.metadataPath);
}

function isSessionExpired(metadata = {}, nowIso = new Date().toISOString()) {
  const status = normalizeString(metadata.status).toLowerCase();
  if (status === "expired" || status === "archived") {
    return true;
  }
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  const expiryEpoch = Date.parse(normalizeIsoTimestamp(metadata.expiresAt, nowIso));
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(expiryEpoch)) {
    return false;
  }
  return nowEpoch >= expiryEpoch;
}

function materializeCanonicalEvent(sessionId, event = {}) {
  const strictNormalized = normalizeAgentEvent(event, { allowLegacy: false });
  if (strictNormalized) {
    if (strictNormalized.sessionId) {
      return strictNormalized;
    }
    return createAgentEvent({
      ...strictNormalized,
      sessionId,
    });
  }

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("appendToStream requires a valid event payload.");
  }

  const payload = {
    ...event,
    sessionId: normalizeString(event.sessionId) || sessionId,
  };
  return createAgentEvent(payload);
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
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
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
        // If stat/remove fails, continue waiting.
      }

      if (Date.now() - start >= timeoutMs) {
        throw new Error("Timed out waiting for session stream lock.");
      }
      await sleep(pollMs);
    }
  }
}

async function releaseLock(lockPath) {
  await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

async function readEventsFromFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    if (!raw) {
      return [];
    }
    const events = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const normalized = normalizeAgentEvent(parsed, { allowLegacy: false });
        if (normalized) {
          events.push(normalized);
        }
      } catch {
        // Ignore malformed historical lines.
      }
    }
    return events;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readAllEvents(paths) {
  const [rotated, current] = await Promise.all([
    readEventsFromFile(paths.rotatedStreamPath),
    readEventsFromFile(paths.streamPath),
  ]);
  return [...rotated, ...current];
}

async function rotateStreamIfNeeded(paths, maxEvents) {
  const raw = await fsp.readFile(paths.streamPath, "utf-8").catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= maxEvents) {
    return;
  }

  const overflowCount = lines.length - maxEvents;
  const overflowLines = lines.slice(0, overflowCount);
  const retainedLines = lines.slice(overflowCount);

  await fsp.mkdir(paths.sessionDir, { recursive: true });
  if (overflowLines.length > 0) {
    await fsp.appendFile(paths.rotatedStreamPath, `${overflowLines.join("\n")}\n`, "utf-8");
  }
  const retainedPayload = retainedLines.length > 0 ? `${retainedLines.join("\n")}\n` : "";
  await fsp.writeFile(paths.streamPath, retainedPayload, "utf-8");
}

function filterBySince(events = [], since) {
  const normalizedSince = normalizeString(since);
  if (!normalizedSince) {
    return events;
  }
  const sinceEpoch = Date.parse(normalizedSince);
  if (!Number.isFinite(sinceEpoch)) {
    return events;
  }
  return events.filter((event) => {
    const eventEpoch = Date.parse(normalizeIsoTimestamp(event.ts, "1970-01-01T00:00:00.000Z"));
    return Number.isFinite(eventEpoch) && eventEpoch >= sinceEpoch;
  });
}

export async function appendToStream(
  sessionId,
  event,
  { targetPath = process.cwd(), maxEvents = DEFAULT_MAX_STREAM_EVENTS } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const metadata = await readSessionMetadata(paths);
  if (!metadata) {
    throw new Error(`Session '${paths.sessionId}' was not found.`);
  }
  if (isSessionExpired(metadata)) {
    throw new Error(`Session '${paths.sessionId}' is expired and does not accept new events.`);
  }

  const canonicalEvent = materializeCanonicalEvent(paths.sessionId, event);
  const nowIso = new Date().toISOString();
  const normalizedMaxEvents = normalizePositiveInteger(maxEvents, DEFAULT_MAX_STREAM_EVENTS);

  await acquireLock(paths.lockPath);
  try {
    await fsp.mkdir(paths.sessionDir, { recursive: true });
    await fsp.appendFile(paths.streamPath, `${JSON.stringify(canonicalEvent)}\n`, "utf-8");
    await rotateStreamIfNeeded(paths, normalizedMaxEvents);

    metadata.lastInteractionAt = nowIso;
    metadata.updatedAt = nowIso;
    await writeSessionMetadata(paths, metadata);
  } finally {
    await releaseLock(paths.lockPath);
  }

  return canonicalEvent;
}

export async function readStream(
  sessionId,
  { tail = 20, since = null, targetPath = process.cwd() } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const events = await readAllEvents(paths);
  const filtered = filterBySince(events, since);
  const normalizedTail = Number(tail);
  if (!Number.isFinite(normalizedTail) || normalizedTail <= 0) {
    return filtered;
  }
  return filtered.slice(-Math.floor(normalizedTail));
}

export async function* tailStream(
  sessionId,
  {
    onEvent = null,
    signal = null,
    pollMs = DEFAULT_POLL_MS,
    targetPath = process.cwd(),
    since = null,
    replayTail = 0,
  } = {}
) {
  const normalizedPollMs = normalizePositiveInteger(pollMs, DEFAULT_POLL_MS);
  let allEvents = await readStream(sessionId, { tail: 0, since, targetPath });
  let cursor = allEvents.length;

  const replayCount = Math.max(0, Math.floor(Number(replayTail) || 0));
  if (replayCount > 0) {
    const replayEvents = allEvents.slice(-replayCount);
    for (const event of replayEvents) {
      if (typeof onEvent === "function") {
        await onEvent(event);
      }
      yield event;
    }
  }

  while (true) {
    if (signal && signal.aborted) {
      return;
    }

    allEvents = await readStream(sessionId, { tail: 0, since, targetPath });
    if (allEvents.length < cursor) {
      cursor = 0;
    }
    if (allEvents.length > cursor) {
      for (const event of allEvents.slice(cursor)) {
        if (typeof onEvent === "function") {
          await onEvent(event);
        }
        yield event;
      }
      cursor = allEvents.length;
    }

    try {
      await sleep(normalizedPollMs, null, signal ? { signal } : undefined);
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") {
        return;
      }
      throw error;
    }
  }
}

export { DEFAULT_MAX_STREAM_EVENTS };
