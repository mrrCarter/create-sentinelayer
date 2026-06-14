import { createResolveTarget } from "./resolve-target.js";
import claudeWakeAdapter from "./claude.js";
import codexWakeAdapter from "./codex.js";

const BUILTIN_ADAPTERS = {
  claude: claudeWakeAdapter,
  codex: codexWakeAdapter,
};

function normalizeString(value) {
  return String(value || "").trim();
}

/**
 * Wire the built wake bus (resolve-target routing + a host adapter) into the
 * live `sl session listen` poll so an addressed message INSTANTLY resumes the
 * host (claude --resume / codex resume) — the auto-wake cutover. No second
 * process: the same poll that delivers events also wakes the host.
 *
 * Returns a trigger `(event) => Promise<{ woken, reason, ok? }>`:
 *  - resolve-target decides routing (real message types only; addressed to us
 *    or broadcast; never self-wake) → returns null for skips ("not_routed").
 *  - on a routed event, the adapter resumes the host; the result carries the
 *    adapter ok/reason so the caller can surface or (later) retry.
 */
export function createListenerHostWake({
  host,
  resumeSessionId,
  agentId,
  sessionId,
  adapters = BUILTIN_ADAPTERS,
} = {}) {
  const hostName = normalizeString(host).toLowerCase();
  const resumeId = normalizeString(resumeSessionId);
  const selfId = normalizeString(agentId);
  const sid = normalizeString(sessionId);
  const adapter = adapters[hostName];
  if (!adapter || typeof adapter.wake !== "function") {
    return null;
  }
  if (!resumeId || !selfId || !sid) {
    return null;
  }

  const resolveTarget = createResolveTarget({
    agentId: selfId,
    host: hostName,
    sessionId: resumeId,
  });

  // Serialize wakes: a resume spawns a host process; never run two at once.
  let queue = Promise.resolve();
  return function triggerHostWake(event) {
    const target = resolveTarget(event);
    if (!target) {
      return Promise.resolve({ woken: false, reason: "not_routed" });
    }
    queue = queue.then(async () => {
      try {
        const result = await adapter.wake(target);
        return {
          woken: Boolean(result?.ok),
          ok: Boolean(result?.ok),
          reason: result?.ok ? "resumed" : normalizeString(result?.reason) || "wake_failed",
          host: hostName,
        };
      } catch (error) {
        return { woken: false, ok: false, reason: normalizeString(error?.message) || "wake_error", host: hostName };
      }
    });
    return queue;
  };
}

export { BUILTIN_ADAPTERS };
