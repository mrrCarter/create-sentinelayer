import { createResolveTarget } from "./resolve-target.js";
import claudeWakeAdapter from "./claude.js";
import codexWakeAdapter from "./codex.js";

const BUILTIN_ADAPTERS = {
  claude: claudeWakeAdapter,
  codex: codexWakeAdapter,
};

// Receipt-confirmation defaults (Carter's idea: a wake isn't done until the
// agent actually acks/views the message). Conservative so reconcile never
// spam-resumes a slow-but-awake agent.
const DEFAULT_CONFIRM_WINDOW_MS = 90_000;
const DEFAULT_MAX_WAKE_ATTEMPTS = 3;
const RECEIPT_ACTION_TYPES = new Set(["ack", "view", "reply", "working_on", "like"]);

function normalizeString(value) {
  return String(value || "").trim();
}

function eventSequence(event) {
  const raw = event?.sequenceId ?? event?.sequence_id ?? event?.payload?.sequenceId;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Wire the built wake bus (resolve-target routing + a host adapter) into the
 * live `sl session listen` poll so an addressed message INSTANTLY resumes the
 * host — the auto-wake cutover — and CONFIRMS the wake via read receipts.
 *
 * Returns { trigger, reconcile, pendingCount } or null when disabled:
 *  - trigger(event): route + resume the host on an addressed message, and (if
 *    the message has a durable sequence) record a pending wake to confirm.
 *  - reconcile({ fetchActions, nowMs }): for each pending wake, fetch the
 *    message's actions; if THIS agent acked/viewed/replied → confirmed (woke).
 *    Else past the confirm window, re-resume (up to maxAttempts) — the agent
 *    didn't wake. Past maxAttempts → dead-letter. Never throws.
 */
export function createListenerHostWake({
  host,
  resumeSessionId,
  agentId,
  sessionId,
  adapters = BUILTIN_ADAPTERS,
  confirmWindowMs = DEFAULT_CONFIRM_WINDOW_MS,
  maxAttempts = DEFAULT_MAX_WAKE_ATTEMPTS,
} = {}) {
  const hostName = normalizeString(host).toLowerCase();
  const resumeId = normalizeString(resumeSessionId);
  const selfId = normalizeString(agentId);
  const sid = normalizeString(sessionId);
  const adapter = adapters[hostName];
  if (!adapter || typeof adapter.wake !== "function") return null;
  if (!resumeId || !selfId || !sid) return null;

  const resolveTarget = createResolveTarget({
    agentId: selfId,
    host: hostName,
    sessionId: resumeId,
  });

  // Serialize resumes: each spawns a host process; never two at once.
  let queue = Promise.resolve();
  // seq -> { target, attempts, lastWakeAt }
  const pending = new Map();

  function resume(target) {
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
  }

  function trigger(event) {
    const target = resolveTarget(event);
    if (!target) return Promise.resolve({ woken: false, reason: "not_routed" });
    const seq = eventSequence(event);
    // Record a pending wake to confirm. lastWakeAt is stamped on the first
    // reconcile (callers own the clock) so the confirm window starts then.
    if (seq !== null && !pending.has(seq)) {
      pending.set(seq, { target, attempts: 1, lastWakeAt: Number.NaN });
    }
    return resume(target);
  }

  async function reconcile({ fetchActions, nowMs = 0 } = {}) {
    const summary = { confirmed: 0, retried: 0, deadLettered: 0, stillPending: 0 };
    if (typeof fetchActions !== "function" || pending.size === 0) {
      summary.stillPending = pending.size;
      return summary;
    }
    for (const [seq, entry] of [...pending.entries()]) {
      if (!Number.isFinite(entry.lastWakeAt)) entry.lastWakeAt = nowMs;
      let actions = [];
      try {
        const res = await fetchActions(seq);
        actions = Array.isArray(res?.actions) ? res.actions : [];
      } catch {
        // transient fetch error — leave pending, try next reconcile
        summary.stillPending += 1;
        continue;
      }
      const acked = actions.some(
        (a) =>
          normalizeString(a?.actorId).toLowerCase() === selfId.toLowerCase() &&
          RECEIPT_ACTION_TYPES.has(normalizeString(a?.actionType).toLowerCase()),
      );
      if (acked) {
        pending.delete(seq);
        summary.confirmed += 1;
        continue;
      }
      if (nowMs - entry.lastWakeAt >= confirmWindowMs) {
        if (entry.attempts < maxAttempts) {
          entry.attempts += 1;
          entry.lastWakeAt = nowMs;
          void resume(entry.target);
          summary.retried += 1;
        } else {
          pending.delete(seq);
          summary.deadLettered += 1;
        }
      } else {
        summary.stillPending += 1;
      }
    }
    return summary;
  }

  return { trigger, reconcile, pendingCount: () => pending.size };
}

export { BUILTIN_ADAPTERS };
