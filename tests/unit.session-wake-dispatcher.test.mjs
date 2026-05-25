import test from "node:test";
import assert from "node:assert/strict";

import { createWakeRegistry } from "../src/session/wake/registry.js";
import { createWakeDispatcher } from "../src/session/wake/dispatcher.js";

// Fake adapter: succeeds, or fails the first `failTimes` calls, or always throws.
function fakeAdapter(hostName, { failTimes = 0, throwAlways = false } = {}) {
  let fails = failTimes;
  const calls = [];
  return {
    hostName,
    calls,
    wake(target) {
      calls.push(target);
      if (throwAlways) return Promise.reject(new Error("boom"));
      if (fails > 0) {
        fails -= 1;
        return Promise.resolve({ ok: false, hostName, sessionId: target.sessionId, code: 1, reason: "transient" });
      }
      return Promise.resolve({ ok: true, hostName, sessionId: target.sessionId, code: 0, reason: null });
    },
  };
}

// Wakes "claude" for messages to claude-mythos, never for the author's own events.
function targetForMythos(event) {
  if (event?.payload?.to === "claude-mythos" && event?.agentId !== "claude-mythos") {
    return { host: "claude", sessionId: "sess-mythos", message: event.payload.message };
  }
  return null;
}
const ev = (seq, extra = {}) => ({ sequenceId: seq, agentId: "carter", payload: { to: "claude-mythos", message: "m", ...extra } });

test("Unit wake dispatcher: requires registry(resolve+has) + resolveTarget + valid maxAttempts", () => {
  assert.throws(() => createWakeDispatcher({}), /registry/);
  assert.throws(() => createWakeDispatcher({ registry: { resolve() {}, has() {} } }), /resolveTarget/);
  assert.throws(
    () => createWakeDispatcher({ registry: { resolve() {}, has() {} }, resolveTarget: () => null, maxAttempts: 0 }),
    /maxAttempts/
  );
});

test("Unit wake dispatcher: successful wake advances the cursor", async () => {
  const claude = fakeAdapter("claude");
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos });
  const out = await d.dispatchEvent(ev(5));
  assert.equal(out.skipped, false);
  assert.equal(out.result, undefined); // success returns the merged shape directly
  assert.equal(out.ok, true);
  assert.equal(out.retryable, false);
  assert.equal(d.getCursor(), 5);
});

test("Unit wake dispatcher: no_target (incl. self-wake) skips and advances", async () => {
  const claude = fakeAdapter("claude");
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos });
  const other = await d.dispatchEvent({ sequenceId: 7, agentId: "carter", payload: { to: "codex", message: "x" } });
  assert.equal(other.reason, "no_target");
  assert.equal(d.getCursor(), 7);
  const selfWake = await d.dispatchEvent({ sequenceId: 8, agentId: "claude-mythos", payload: { to: "claude-mythos", message: "self" } });
  assert.equal(selfWake.reason, "no_target");
  assert.equal(claude.calls.length, 0);
  assert.equal(d.getCursor(), 8);
});

test("Unit wake dispatcher: dedupes events at or below the cursor", async () => {
  const d = createWakeDispatcher({ registry: createWakeRegistry([fakeAdapter("claude")]), resolveTarget: targetForMythos });
  d.setCursor(10);
  const stale = await d.dispatchEvent(ev(9));
  assert.equal(stale.reason, "already_seen");
  assert.equal(d.getCursor(), 10);
});

test("Unit wake dispatcher: FAILED wake does NOT advance and is retryable (at-least-once)", async () => {
  const claude = fakeAdapter("claude", { failTimes: 1 });
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos, maxAttempts: 3 });

  const first = await d.dispatchEvent(ev(4));
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.equal(first.attempt, 1);
  assert.equal(d.getCursor(), 0, "cursor must stay behind a failed wake so it retries");

  // Daemon re-polls the same seq; this time the adapter succeeds.
  const retry = await d.dispatchEvent(ev(4));
  assert.equal(retry.ok, true);
  assert.equal(d.getCursor(), 4);
});

test("Unit wake dispatcher: exhausting retries WITH a dead-letter sink records then advances", async () => {
  const failing = fakeAdapter("claude", { throwAlways: true });
  const dlq = [];
  const d = createWakeDispatcher({
    registry: createWakeRegistry([failing]),
    resolveTarget: targetForMythos,
    maxAttempts: 2,
    deadLetter: (rec) => { dlq.push(rec); },
  });

  const a1 = await d.dispatchEvent(ev(6));
  assert.equal(a1.retryable, true);
  assert.equal(d.getCursor(), 0);

  const a2 = await d.dispatchEvent(ev(6)); // attempt 2 == maxAttempts -> dead-letter
  assert.equal(a2.retryable, false);
  assert.equal(a2.deadLettered, true);
  assert.equal(d.getCursor(), 6, "advances past a poison event only after durable dead-letter");
  assert.equal(dlq.length, 1);
  assert.deepEqual({ kind: dlq[0].kind, seq: dlq[0].seq, host: dlq[0].host }, { kind: "wake_failure", seq: 6, host: "claude" });
});

test("Unit wake dispatcher: exhausting retries WITHOUT a sink wedges loud (no advance, no silent loss)", async () => {
  const failing = fakeAdapter("claude", { throwAlways: true });
  const d = createWakeDispatcher({ registry: createWakeRegistry([failing]), resolveTarget: targetForMythos, maxAttempts: 1 });
  const out = await d.dispatchEvent(ev(6));
  assert.equal(out.retryable, false);
  assert.equal(out.deadLettered, false);
  assert.equal(d.getCursor(), 0, "no DLQ -> never silently advance past a lost wake");
});

test("Unit wake dispatcher: unknown host is a loud config failure, never a silent skip", async () => {
  const dlq = [];
  const d = createWakeDispatcher({
    registry: createWakeRegistry([fakeAdapter("codex")]),
    resolveTarget: () => ({ host: "claude", sessionId: "s", message: "m" }),
    deadLetter: (rec) => { dlq.push(rec); },
  });
  const out = await d.dispatchEvent({ sequenceId: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "unknown_host");
  assert.equal(out.retryable, false);
  assert.equal(out.deadLettered, true);
  assert.equal(dlq[0].kind, "config_error");
  assert.equal(d.getCursor(), 1);

  // Without a DLQ sink, an unknown host wedges loud instead of advancing.
  const d2 = createWakeDispatcher({
    registry: createWakeRegistry([fakeAdapter("codex")]),
    resolveTarget: () => ({ host: "claude", sessionId: "s", message: "m" }),
  });
  const out2 = await d2.dispatchEvent({ sequenceId: 1 });
  assert.equal(out2.deadLettered, false);
  assert.equal(d2.getCursor(), 0);
});

test("Unit wake dispatcher: batch stops at the first retryable failure to preserve order", async () => {
  const claude = fakeAdapter("claude", { failTimes: 1 }); // first call fails
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos, maxAttempts: 3 });
  const results = await d.dispatchBatch([ev(2), ev(3), ev(1)]);
  // ordered [1,2,3]; seq 1 fails (retryable) -> batch stops, 2 and 3 not attempted yet.
  assert.equal(results.length, 1);
  assert.equal(results[0].seq, 1);
  assert.equal(results[0].retryable, true);
  assert.equal(d.getCursor(), 0);
});

test("Unit wake dispatcher: batch of successes advances to the max seq", async () => {
  const claude = fakeAdapter("claude");
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos });
  await d.dispatchBatch([ev(3), ev(1), ev(2)]);
  assert.deepEqual(claude.calls.map((_, i) => i), [0, 1, 2]);
  assert.equal(d.getCursor(), 3);
});

test("Unit wake dispatcher: setCursor seeds RESUME, getCursor reports it, negatives ignored", () => {
  const d = createWakeDispatcher({ registry: createWakeRegistry(), resolveTarget: () => null });
  assert.equal(d.getCursor(), 0);
  d.setCursor(42);
  assert.equal(d.getCursor(), 42);
  d.setCursor(-1);
  assert.equal(d.getCursor(), 42);
});
