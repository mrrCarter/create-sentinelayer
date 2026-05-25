import test from "node:test";
import assert from "node:assert/strict";

import { createWakeRegistry } from "../src/session/wake/registry.js";
import { createWakeDispatcher } from "../src/session/wake/dispatcher.js";
import { createWakePump } from "../src/session/wake/pump.js";

// Adapter that fails (ok:false) when the wake message is "boom", else succeeds.
function fakeAdapter() {
  return {
    hostName: "claude",
    wake(target) {
      const ok = target.message !== "boom";
      return Promise.resolve({ ok, hostName: "claude", sessionId: target.sessionId, code: ok ? 0 : 1, reason: ok ? null : "transient" });
    },
  };
}

function makeDispatcher({ maxAttempts = 3 } = {}) {
  const registry = createWakeRegistry([fakeAdapter()]);
  const resolveTarget = (event) => ({ host: "claude", sessionId: "s", message: event.payload.message });
  return createWakeDispatcher({ registry, resolveTarget, maxAttempts });
}

const evt = (seq, cursor, message) => ({ sequenceId: seq, cursor, event: "session_message", agentId: "carter", payload: { message } });

// In-memory cursor IO so the pump never touches disk in unit tests.
function memCursor(initial = 0) {
  let v = initial;
  return {
    read: async () => v,
    write: async (_sid, seq) => { v = seq; },
    get: () => v,
  };
}

test("Unit wake pump: validates sessionId/dispatcher/pollEvents", () => {
  assert.throws(() => createWakePump({}), /sessionId/);
  assert.throws(() => createWakePump({ sessionId: "s" }), /dispatcher/);
  assert.throws(() => createWakePump({ sessionId: "s", dispatcher: makeDispatcher() }), /pollEvents/);
});

test("Unit wake pump: seeds dispatcher RESUME cursor from disk", async () => {
  const dispatcher = makeDispatcher();
  const cur = memCursor(10);
  const pump = createWakePump({
    sessionId: "s",
    dispatcher,
    pollEvents: async () => ({ events: [], cursor: null }),
    readCursor: cur.read,
    writeCursor: cur.write,
  });
  await pump.ensureSeeded();
  assert.equal(dispatcher.getCursor(), 10);
});

test("Unit wake pump: all-committed batch adopts the poller's latest cursor + persists max seq", async () => {
  const dispatcher = makeDispatcher();
  const cur = memCursor(0);
  const pump = createWakePump({
    sessionId: "s",
    dispatcher,
    pollEvents: async () => ({ events: [evt(1, "c1", "a"), evt(2, "c2", "b")], cursor: "LATEST" }),
    readCursor: cur.read,
    writeCursor: cur.write,
  });
  const tick = await pump.tickOnce({ fetchCursor: "c0" });
  assert.equal(tick.fetchCursor, "LATEST");
  assert.equal(dispatcher.getCursor(), 2);
  assert.equal(cur.get(), 2);
});

test("Unit wake pump: a retryable failure stops the batch and the fetch cursor stays at the last committed event", async () => {
  const dispatcher = makeDispatcher({ maxAttempts: 3 });
  const cur = memCursor(0);
  const events = [evt(1, "c1", "a"), evt(2, "c2", "boom"), evt(3, "c3", "c")];
  const pump = createWakePump({
    sessionId: "s",
    dispatcher,
    pollEvents: async () => ({ events, cursor: "LATEST" }),
    readCursor: cur.read,
    writeCursor: cur.write,
  });
  const tick = await pump.tickOnce({ fetchCursor: "c0" });
  // seq1 commits, seq2 fails retryable -> batch stops, seq3 untouched.
  assert.equal(dispatcher.getCursor(), 1);
  assert.equal(tick.fetchCursor, "c1", "fetch cursor stays at last committed so seq2 re-fetches");
  assert.notEqual(tick.fetchCursor, "LATEST");
  assert.equal(cur.get(), 1);
  assert.ok(tick.results.some((r) => r.retryable));
});

test("Unit wake pump: empty poll is idle, leaves fetch cursor and persisted seq unchanged", async () => {
  const dispatcher = makeDispatcher();
  const cur = memCursor(5);
  let writes = 0;
  const pump = createWakePump({
    sessionId: "s",
    dispatcher,
    pollEvents: async () => ({ events: [], cursor: "LATEST" }),
    readCursor: cur.read,
    writeCursor: async (...a) => { writes += 1; return cur.write(...a); },
  });
  const tick = await pump.tickOnce({ fetchCursor: "c9" });
  assert.equal(tick.idle, true);
  assert.equal(tick.fetchCursor, "c9");
  assert.equal(writes, 0, "no cursor write when there is nothing to commit");
});

test("Unit wake pump: re-fetched failed event succeeds on the next tick and advances", async () => {
  // Adapter that fails the first wake of "boom" then succeeds (transient).
  let boomFails = 1;
  const registry = createWakeRegistry([{
    hostName: "claude",
    wake(target) {
      if (target.message === "boom" && boomFails > 0) { boomFails -= 1; return Promise.resolve({ ok: false, hostName: "claude", sessionId: target.sessionId, code: 1, reason: "transient" }); }
      return Promise.resolve({ ok: true, hostName: "claude", sessionId: target.sessionId, code: 0, reason: null });
    },
  }]);
  const dispatcher = createWakeDispatcher({ registry, resolveTarget: (e) => ({ host: "claude", sessionId: "s", message: e.payload.message }), maxAttempts: 3 });
  const cur = memCursor(0);
  const events = [evt(1, "c1", "boom"), evt(2, "c2", "b")];
  const pump = createWakePump({ sessionId: "s", dispatcher, pollEvents: async () => ({ events, cursor: "LATEST" }), readCursor: cur.read, writeCursor: cur.write });

  const t1 = await pump.tickOnce({ fetchCursor: "c0" });
  assert.equal(dispatcher.getCursor(), 0, "first attempt: seq1 boom fails, nothing commits");
  assert.equal(t1.fetchCursor, "c0", "stays so seq1 re-fetches");

  const t2 = await pump.tickOnce({ fetchCursor: t1.fetchCursor });
  assert.equal(dispatcher.getCursor(), 2, "retry of seq1 succeeds, then seq2 commits");
  assert.equal(t2.fetchCursor, "LATEST");
});

test("Unit wake pump: start forwards wake deps into dispatch", async () => {
  const controller = new AbortController();
  const seenDeps = [];
  const dispatcher = {
    dispatchBatch: async (_events, deps) => {
      seenDeps.push(deps);
      return [{ ok: true, skipped: false, retryable: false, seq: 1 }];
    },
    getCursor: () => 1,
    setCursor: () => {},
  };
  const marker = { injected: true };
  const pump = createWakePump({
    sessionId: "s",
    dispatcher,
    pollEvents: async () => ({ events: [evt(1, "c1", "wake")], cursor: "c1" }),
    readCursor: async () => 0,
    writeCursor: async () => {},
    sleep: async () => { controller.abort(); },
  });

  await pump.start({ signal: controller.signal, deps: { marker } });
  assert.equal(seenDeps.length, 1);
  assert.equal(seenDeps[0].marker, marker);
});
