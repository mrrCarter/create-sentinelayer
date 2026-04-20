// Barrel export for the .sentinel cross-persona handshake (#A9, spec §5.6).
// Callers should import from "src/coord" rather than reaching into individual
// modules so we can reshape internals without rippling through the codebase.

export {
  DEFAULT_TTL_S,
  LOCK_SCHEMA_VERSION,
  MAX_TTL_S,
  MIN_TTL_S,
  PERSONA_PRIORITY,
  checkLock,
  detectDeadlock,
  hashLockKey,
  listActiveLocks,
  listWaiters,
  normalizeLockPath,
  outranks,
  priorityIndex,
  releaseLock,
  requestLock,
} from "./handshake.js";

export { appendEvent, readEvents, KNOWN_EVENT_TYPES } from "./events-log.js";

export { findCycles, tarjanSCC } from "./tarjan.js";

export { lowestPriorityAgent } from "./priority.js";

export {
  lockFileFor,
  resolveEventsPath,
  resolveLocksDir,
  resolveSentinelDir,
  resolveWaitsPath,
} from "./paths.js";
