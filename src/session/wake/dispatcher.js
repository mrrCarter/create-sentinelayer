// Wake dispatcher — the decision core of the `sentid` daemon (Wake-Up Bus L2).
//
// Given session events (from the L0 stream/listener), it decides which, if any,
// agent to wake and routes the wake through the adapter registry. It is kept
// pure and dependency-injected so it can be unit-tested with a fake adapter and
// a fake target resolver, independent of the live stream or any host CLI.
//
// Monotonic-seq RESUME: the dispatcher tracks the highest sequence it has acted
// on and skips anything at or below it. On startup the daemon calls setCursor()
// with the last-acked seq persisted across restarts, so a reconnect replays the
// backlog exactly once (no missed wakes, no double wakes).

function seqOf(event) {
  const raw = event?.sequenceId ?? event?.seq ?? event?.payload?.sequenceId;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} opts
 * @param {{ resolve: Function }} opts.registry  wake-adapter registry
 * @param {(event:object) => ({host:string, sessionId:string, message:string}|null)} opts.resolveTarget
 *   Maps an event to the agent to wake, or null to skip (e.g. broadcast with no
 *   subscriber, or the event's own author — caller owns self-wake avoidance).
 * @param {(result:object, event:object) => void} [opts.onResult]
 * @param {(level:string, msg:string, meta?:object) => void} [opts.logger]
 */
export function createWakeDispatcher({ registry, resolveTarget, onResult, logger } = {}) {
  if (!registry || typeof registry.resolve !== "function") {
    throw new TypeError("wake dispatcher: registry with resolve() is required");
  }
  if (typeof resolveTarget !== "function") {
    throw new TypeError("wake dispatcher: resolveTarget(event) function is required");
  }
  const log = typeof logger === "function" ? logger : () => {};
  let lastSeq = 0;

  async function dispatchEvent(event, deps = {}) {
    const seq = seqOf(event);
    if (seq !== null && seq <= lastSeq) {
      return { skipped: true, reason: "already_seen", seq };
    }

    const target = resolveTarget(event);
    if (!target) {
      if (seq !== null) lastSeq = Math.max(lastSeq, seq);
      return { skipped: true, reason: "no_target", seq };
    }

    const { host, sessionId, message } = target;
    let result;
    try {
      const adapter = registry.resolve(host);
      result = await adapter.wake({ sessionId, message }, deps);
    } catch (error) {
      // A failed or unknown-host wake must never crash the daemon.
      result = { ok: false, hostName: host ?? null, sessionId: sessionId ?? null, code: null, reason: error?.message || "wake_threw" };
      log("error", "wake dispatch failed", { host, sessionId, reason: result.reason });
    }

    if (seq !== null) lastSeq = Math.max(lastSeq, seq);
    if (typeof onResult === "function") onResult(result, event);
    return { skipped: false, seq, result };
  }

  async function dispatchBatch(events = [], deps = {}) {
    if (!Array.isArray(events)) throw new TypeError("wake dispatcher: events must be an array");
    // Process in monotonic seq order so the RESUME cursor advances correctly even
    // if the source delivers out of order. Events without a seq keep input order.
    const ordered = [...events].sort((a, b) => {
      const sa = seqOf(a);
      const sb = seqOf(b);
      if (sa === null || sb === null) return 0;
      return sa - sb;
    });
    const results = [];
    for (const event of ordered) {
      results.push(await dispatchEvent(event, deps));
    }
    return results;
  }

  return {
    dispatchEvent,
    dispatchBatch,
    getCursor: () => lastSeq,
    /** Seed the RESUME cursor from a persisted last-acked seq on daemon startup. */
    setCursor: (n) => {
      const v = Number(n);
      if (Number.isFinite(v) && v >= 0) lastSeq = v;
      return lastSeq;
    },
  };
}

export default createWakeDispatcher;
