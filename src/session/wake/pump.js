// Wake pump — the live event source for the sentid daemon (Wake-Up Bus L2).
//
// Connects a session's event stream to the dispatcher: fetch new events, run
// them through dispatcher.dispatchBatch (which applies resolveTarget routing,
// the at-least-once retry/DLQ contract, and the in-memory RESUME cursor), then
// persist that cursor for restart RESUME.
//
// The event source `pollEvents` is INJECTED, not imported: importing
// sync.js/listener.js would drag the heavy auth/`open` module graph into the
// daemon and make this untestable. The thin sentid runtime entrypoint adapts
// the real pollSessionEvents to the contract below; tests inject a fake.
//
// At-least-once end to end: the fetch cursor advances only to the cursor of the
// last COMMITTED event (one whose seq the dispatcher actually advanced past). A
// retryable/uncommitted failure stops the batch, the fetch cursor stays behind
// it, and the next poll re-delivers that event — so a transient wake failure is
// retried, never silently skipped.

import { readWakeCursor, writeWakeCursor } from "./cursor-store.js";

function seqOf(event) {
  const raw = event?.sequenceId ?? event?.seq ?? event?.payload?.sequenceId;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function cursorOf(event) {
  const c = event?.cursor;
  return typeof c === "string" && c ? c : null;
}

const defaultSleep = (ms, { signal } = {}) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {{ dispatchBatch:Function, getCursor:Function, setCursor:Function }} opts.dispatcher
 * @param {(sessionId:string, o:{afterCursor:string|null}) => Promise<{events:object[], cursor?:string|null}>} opts.pollEvents
 * @param {{ targetPath?:string, idleMs?:number, readCursor?:Function, writeCursor?:Function, sleep?:Function, logger?:Function }} [opts]
 */
export function createWakePump({
  sessionId,
  dispatcher,
  pollEvents,
  targetPath,
  idleMs = 1500,
  readCursor = readWakeCursor,
  writeCursor = writeWakeCursor,
  sleep = defaultSleep,
  logger,
} = {}) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new TypeError("wake pump: sessionId must be a non-empty string");
  }
  if (!dispatcher || typeof dispatcher.dispatchBatch !== "function" || typeof dispatcher.getCursor !== "function") {
    throw new TypeError("wake pump: dispatcher with dispatchBatch()/getCursor() is required");
  }
  if (typeof pollEvents !== "function") {
    throw new TypeError("wake pump: pollEvents function is required");
  }
  const log = typeof logger === "function" ? logger : () => {};
  let seeded = false;

  // Seed the dispatcher's RESUME cursor from disk once, on first use.
  async function ensureSeeded() {
    if (seeded) return;
    seeded = true;
    if (typeof dispatcher.setCursor === "function") {
      dispatcher.setCursor(await readCursor(sessionId, { targetPath }));
    }
  }

  // The fetch cursor advances only to the last COMMITTED event's cursor.
  function nextFetchCursor(events, committedSeq, fallback) {
    let best = fallback;
    let bestSeq = -Infinity;
    for (const event of events) {
      const seq = seqOf(event);
      const cursor = cursorOf(event);
      if (cursor !== null && seq !== null && seq <= committedSeq && seq > bestSeq) {
        bestSeq = seq;
        best = cursor;
      }
    }
    return best;
  }

  /**
   * One fetch -> dispatch -> persist cycle. Returns the next fetch cursor and the
   * dispatch results so the caller (or a test) can observe progress.
   */
  async function tickOnce({ fetchCursor = null, deps = {} } = {}) {
    await ensureSeeded();
    const { events = [], cursor: latestCursor = null } = (await pollEvents(sessionId, { afterCursor: fetchCursor })) || {};
    if (!Array.isArray(events) || events.length === 0) {
      return { fetchCursor, results: [], idle: true };
    }
    const results = await dispatcher.dispatchBatch(events, deps);
    const committedSeq = dispatcher.getCursor();
    // Only adopt the poller's latest cursor if the WHOLE batch committed.
    const allCommitted = results.length === events.length && results.every((r) => !r.retryable);
    const advanced = nextFetchCursor(events, committedSeq, fetchCursor);
    const next = allCommitted && typeof latestCursor === "string" && latestCursor ? latestCursor : advanced;
    await writeCursor(sessionId, committedSeq, { targetPath });
    log("debug", "wake pump tick", { committedSeq, fetched: events.length, advanced: next !== fetchCursor });
    return { fetchCursor: next, results, idle: false };
  }

  /** Run the fetch loop until `signal` aborts. */
  async function start({ signal, fetchCursor = null, deps = {} } = {}) {
    let cursor = fetchCursor;
    while (!signal?.aborted) {
      let idle = true;
      try {
        const tick = await tickOnce({ fetchCursor: cursor, deps });
        cursor = tick.fetchCursor;
        idle = tick.idle;
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") break;
        log("error", "wake pump tick failed; backing off", { reason: error?.message });
      }
      if (!signal?.aborted) await sleep(idle ? idleMs : 0, { signal });
    }
    return { fetchCursor: cursor };
  }

  return { tickOnce, start, ensureSeeded };
}

export default createWakePump;
