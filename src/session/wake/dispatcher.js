// Wake dispatcher — the decision core of the `sentid` daemon (Wake-Up Bus L2).
//
// Given session events (from the L0 stream/listener), it decides which, if any,
// agent to wake and routes the wake through the adapter registry. It is kept
// pure and dependency-injected so it can be unit-tested with a fake adapter and
// a fake target resolver, independent of the live stream or any host CLI.
//
// Delivery contract (the wake-bus invariant Carter cares about = NO SILENT
// MISSED MESSAGES). The RESUME cursor is the high-water mark of *committed*
// progress, NOT merely of attempts:
//   - successful wake .................... advance cursor
//   - resolver returns null (no target / self-wake / intentionally unroutable)
//     ................................... advance cursor (legitimately nothing to do)
//   - failed wake (adapter ok:false or throw) ... DO NOT advance; return
//     retryable=true so the daemon re-polls from the cursor and retries (with
//     backoff at the daemon-loop level). After `maxAttempts` for that seq, write
//     a durable dead-letter record and THEN advance, to escape a poison-event
//     wedge. If no dead-letter sink is wired, DO NOT advance (wedge-loud beats
//     silent-loss).
//   - unknown host (resolver routed to an UNREGISTERED host) ... CONFIG failure:
//     fail loud (dead-letter + error log), never silently advance.
//
// Monotonic-seq RESUME: setCursor() seeds the cursor from the last-acked seq
// persisted across restarts, so a reconnect replays the backlog exactly once.

function seqOf(event) {
  const raw = event?.sequenceId ?? event?.seq ?? event?.payload?.sequenceId;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} opts
 * @param {{ resolve: Function, has: Function }} opts.registry  wake-adapter registry
 * @param {(event:object) => ({host:string, sessionId:string, message:string}|null)} opts.resolveTarget
 *   Maps an event to the agent to wake, or null to skip (no target / self-wake /
 *   intentionally unroutable — the caller owns that policy).
 * @param {number} [opts.maxAttempts=5]  retries per seq before dead-lettering.
 * @param {(record:object) => (void|Promise<void>)} [opts.deadLetter]  durable DLQ sink.
 * @param {(result:object, event:object) => void} [opts.onResult]
 * @param {(level:string, msg:string, meta?:object) => void} [opts.logger]
 */
export function createWakeDispatcher({
  registry,
  resolveTarget,
  maxAttempts = 5,
  deadLetter,
  onResult,
  logger,
} = {}) {
  if (!registry || typeof registry.resolve !== "function" || typeof registry.has !== "function") {
    throw new TypeError("wake dispatcher: registry with resolve() and has() is required");
  }
  if (typeof resolveTarget !== "function") {
    throw new TypeError("wake dispatcher: resolveTarget(event) function is required");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("wake dispatcher: maxAttempts must be a positive integer");
  }
  const log = typeof logger === "function" ? logger : () => {};
  const hasDeadLetter = typeof deadLetter === "function";
  let lastSeq = 0;
  // Per-seq attempt counts for in-flight (not yet committed) failed wakes.
  const attempts = new Map();

  function advance(seq) {
    if (seq !== null) {
      lastSeq = Math.max(lastSeq, seq);
      attempts.delete(seq);
    }
  }

  async function toDeadLetter(record) {
    if (!hasDeadLetter) return false;
    try {
      await deadLetter(record);
      return true;
    } catch (error) {
      log("error", "dead-letter sink threw", { seq: record.seq, reason: error?.message });
      return false;
    }
  }

  function finalize(result, event, { advanceSeq, seq } = {}) {
    if (advanceSeq) advance(seq);
    if (typeof onResult === "function") onResult(result, event);
    return result;
  }

  async function dispatchEvent(event, deps = {}) {
    const seq = seqOf(event);
    if (seq !== null && seq <= lastSeq) {
      return { skipped: true, reason: "already_seen", seq };
    }

    const target = resolveTarget(event);
    if (!target) {
      advance(seq);
      return { skipped: true, reason: "no_target", seq };
    }

    const { host, sessionId, message } = target;

    // Unknown host = config failure: fail loud, never a silent skip.
    if (!registry.has(host)) {
      log("error", "wake dispatch: unknown host (config failure)", { host, sessionId, seq });
      const wrote = await toDeadLetter({ kind: "config_error", reason: "unknown_host", host, sessionId, seq });
      // Advance only if the failure is durably recorded; otherwise wedge loudly.
      return finalize(
        { ok: false, skipped: false, hostName: host ?? null, sessionId: sessionId ?? null, seq, reason: "unknown_host", retryable: false, deadLettered: wrote },
        event,
        { advanceSeq: wrote, seq }
      );
    }

    let result;
    try {
      result = await registry.resolve(host).wake({ sessionId, message }, deps);
    } catch (error) {
      result = { ok: false, hostName: host, sessionId, code: null, reason: error?.message || "wake_threw" };
    }

    if (result?.ok) {
      return finalize({ ...result, skipped: false, seq, retryable: false }, event, { advanceSeq: true, seq });
    }

    // Failed wake: retry until maxAttempts, then dead-letter to escape wedge.
    const n = (seq !== null ? attempts.get(seq) || 0 : 0) + 1;
    if (seq !== null) attempts.set(seq, n);

    if (n < maxAttempts) {
      log("warn", "wake failed; will retry", { host, sessionId, seq, attempt: n, reason: result?.reason });
      // DO NOT advance -> daemon re-polls from cursor and retries.
      return finalize({ ...result, ok: false, skipped: false, seq, retryable: true, attempt: n }, event, { advanceSeq: false, seq });
    }

    log("error", "wake failed; attempts exhausted", { host, sessionId, seq, attempts: n, reason: result?.reason });
    const wrote = await toDeadLetter({ kind: "wake_failure", host, sessionId, seq, reason: result?.reason, attempts: n });
    // Advance past a poison event only if durably dead-lettered; else wedge loud.
    return finalize(
      { ...result, ok: false, skipped: false, seq, retryable: !wrote, attempts: n, deadLettered: wrote },
      event,
      { advanceSeq: wrote, seq }
    );
  }

  async function dispatchBatch(events = [], deps = {}) {
    if (!Array.isArray(events)) throw new TypeError("wake dispatcher: events must be an array");
    // Process in monotonic seq order so the cursor advances correctly even if the
    // source delivers out of order. A retryable failure stops the batch so the
    // backlog stays in order (the daemon will re-poll from the cursor).
    const ordered = [...events].sort((a, b) => {
      const sa = seqOf(a);
      const sb = seqOf(b);
      if (sa === null || sb === null) return 0;
      return sa - sb;
    });
    const results = [];
    for (const event of ordered) {
      const seq = seqOf(event);
      const beforeCursor = lastSeq;
      const r = await dispatchEvent(event, deps);
      results.push(r);
      const uncommittedSeq = seq !== null && seq > beforeCursor && lastSeq < seq;
      const uncommittedUnsequencedFailure = seq === null && r?.ok === false && !r?.skipped;
      if (r.retryable || uncommittedSeq || uncommittedUnsequencedFailure) break; // do not skip ahead of unacked work
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
