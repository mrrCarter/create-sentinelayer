// sentid runtime entrypoint — assembles the Wake-Up Bus (L2) into a daemon.
//
// Wires the merged pieces into one local-agent waker:
//   registry(host adapters) + resolveTarget(routing) + dispatcher(at-least-once
//   + DLQ + RESUME cursor) + pump(live fetch -> dispatch -> persist).
// A sentid instance serves ONE local agent (agentId) and wakes it (host +
// resumeSessionId) when the session stream has a message for it.
//
// The real event source is pollSessionEvents (sync.js), but it is LAZY-imported
// inside the default poll adapter so this module stays unit-testable: importing
// sync.js at module load would drag the heavy auth/`open` graph in. Tests inject
// `pollImpl` (and fake adapters) and the lazy import never fires.

import { createWakeRegistry } from "./registry.js";
import { createResolveTarget } from "./resolve-target.js";
import { createWakeDispatcher } from "./dispatcher.js";
import { createWakePump } from "./pump.js";
import claudeWakeAdapter from "./claude.js";
import codexWakeAdapter from "./codex.js";

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`sentid: ${label} must be a non-empty string`);
  }
  return value.trim();
}

// Adapt pollSessionEvents(sessionId, {since, targetPath}) -> the pump's
// pollEvents(sessionId, {afterCursor}) -> { events, cursor } contract. A failed
// poll (ok:false: circuit open / auth / network) yields no events, which the
// pump treats as idle and retries on the next tick — never a thrown crash.
function makePollEvents(pollImpl, targetPath) {
  let poll = pollImpl;
  return async (sessionId, { afterCursor = null } = {}) => {
    if (!poll) {
      ({ pollSessionEvents: poll } = await import("../sync.js"));
    }
    const result = (await poll(sessionId, { since: afterCursor, targetPath })) || {};
    return {
      events: Array.isArray(result.events) ? result.events : [],
      cursor: typeof result.cursor === "string" ? result.cursor : afterCursor,
    };
  };
}

/**
 * @param {object} opts
 * @param {string} opts.sessionId        Senti session to watch
 * @param {string} opts.agentId          local agent this daemon wakes (e.g. "claude-mythos")
 * @param {string} opts.host             host adapter name (e.g. "claude")
 * @param {string} opts.resumeSessionId  host session id to resume on wake
 * @param {Array} [opts.adapters]        defaults to [claudeWakeAdapter, codexWakeAdapter]
 * @param {string} [opts.targetPath]
 * @param {number} [opts.maxAttempts]    dispatcher retry budget before DLQ
 * @param {number} [opts.idleMs]         pump idle backoff
 * @param {Function} [opts.deadLetter]   durable DLQ sink
 * @param {Function} [opts.logger]
 * @param {Function} [opts.pollImpl]     injected poller (default: lazy pollSessionEvents)
 * @param {object} [opts.wakeDeps]       deps forwarded to adapter.wake() (e.g. execFileImpl)
 */
export function createSentid({
  sessionId,
  agentId,
  host,
  resumeSessionId,
  adapters = [claudeWakeAdapter, codexWakeAdapter],
  targetPath,
  maxAttempts,
  idleMs,
  deadLetter,
  logger,
  pollImpl,
  wakeDeps = {},
} = {}) {
  const sid = requireNonEmptyString(sessionId, "sessionId");
  const localAgent = requireNonEmptyString(agentId, "agentId");
  const hostName = requireNonEmptyString(host, "host");
  const resumeId = requireNonEmptyString(resumeSessionId, "resumeSessionId");

  const registry = createWakeRegistry(adapters);
  if (!registry.has(hostName)) {
    throw new Error(`sentid: no adapter registered for host "${hostName}" (have: ${registry.hosts().join(", ") || "none"})`);
  }

  const resolveTarget = createResolveTarget({ agentId: localAgent, host: hostName, sessionId: resumeId });
  const dispatcher = createWakeDispatcher({ registry, resolveTarget, maxAttempts, deadLetter, logger });
  const pollEvents = makePollEvents(pollImpl, targetPath);
  const pump = createWakePump({ sessionId: sid, dispatcher, pollEvents, targetPath, idleMs, logger });

  return {
    sessionId: sid,
    agentId: localAgent,
    host: hostName,
    registry,
    dispatcher,
    pump,
    start: (o = {}) => pump.start({ ...o, deps: wakeDeps }),
    tickOnce: (o = {}) => pump.tickOnce({ ...o, deps: wakeDeps }),
    getCursor: () => dispatcher.getCursor(),
  };
}

export default createSentid;
