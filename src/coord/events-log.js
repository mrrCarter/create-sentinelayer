// Append-only event log for the handshake primitive (#A9, spec §5.6).
//
// Every state transition — lock_granted, lock_denied, lock_renewed,
// lock_preempted, lock_released, lock_expired, deadlock_broken, wait_recorded
// — is written to .sentinel/events.jsonl. The log is the source of truth
// for replay / audit; callers should never mutate it in place.
//
// We serialize writes with a directory-mkdir mutex so concurrent personas on
// the same filesystem (workers + Omar Gate runner) don't interleave bytes.

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  resolveEventsLockPath,
  resolveEventsPath,
  resolveSentinelDir,
} from "./paths.js";

const EVENTS_LOCK_TIMEOUT_MS = 5000;
const EVENTS_LOCK_STALE_MS = 30_000;
const EVENTS_LOCK_POLL_MS = 25;

const KNOWN_EVENT_TYPES = new Set([
  "lock_granted",
  "lock_renewed",
  "lock_denied",
  "lock_preempted",
  "lock_released",
  "lock_expired",
  "wait_recorded",
  "wait_cleared",
  "deadlock_broken",
]);

async function acquireEventsLock(
  lockPath,
  { timeoutMs = EVENTS_LOCK_TIMEOUT_MS, staleMs = EVENTS_LOCK_STALE_MS, pollMs = EVENTS_LOCK_POLL_MS } = {}
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
        throw new Error("Timed out waiting for .sentinel/events.jsonl lock.");
      }
      await sleep(pollMs);
    }
  }
}

async function releaseEventsLock(lockPath) {
  await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

function stripUndefined(record) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export async function appendEvent(event, { targetPath = process.cwd() } = {}) {
  const type = String(event?.type || "").trim();
  if (!type) {
    throw new Error("event.type is required.");
  }
  if (!KNOWN_EVENT_TYPES.has(type)) {
    throw new Error(`Unknown handshake event type: ${type}`);
  }

  const sentinelDir = resolveSentinelDir({ targetPath });
  await fsp.mkdir(sentinelDir, { recursive: true });

  const record = stripUndefined({
    schemaVersion: "1.0.0",
    type,
    ts: event.ts || new Date().toISOString(),
    ...event,
  });

  const eventsPath = resolveEventsPath({ targetPath });
  const lockPath = resolveEventsLockPath({ targetPath });

  await acquireEventsLock(lockPath);
  try {
    await fsp.appendFile(eventsPath, `${JSON.stringify(record)}\n`, "utf-8");
  } finally {
    await releaseEventsLock(lockPath);
  }
  return record;
}

export async function readEvents({ targetPath = process.cwd() } = {}) {
  const eventsPath = resolveEventsPath({ targetPath });
  let raw;
  try {
    raw = await fsp.readFile(eventsPath, "utf-8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Corrupt row — skip rather than fail the caller.
    }
  }
  return events;
}

export { KNOWN_EVENT_TYPES };
