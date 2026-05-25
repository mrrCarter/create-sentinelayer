import test from "node:test";
import assert from "node:assert/strict";

import { createWakeRegistry } from "../src/session/wake/registry.js";
import { createWakeDispatcher } from "../src/session/wake/dispatcher.js";

function fakeAdapter(hostName, { fail = false } = {}) {
  const calls = [];
  return {
    hostName,
    calls,
    wake(target) {
      calls.push(target);
      if (fail) return Promise.reject(new Error("boom"));
      return Promise.resolve({ ok: true, hostName, sessionId: target.sessionId, code: 0, reason: null });
    },
  };
}

// resolveTarget that wakes "claude" for messages to agent "claude-mythos",
// skips everything else (incl. the author's own events).
function targetForMythos(event) {
  if (event?.payload?.to === "claude-mythos" && event?.agentId !== "claude-mythos") {
    return { host: "claude", sessionId: "sess-mythos", message: event.payload.message };
  }
  return null;
}

test("Unit wake dispatcher: requires registry + resolveTarget", () => {
  assert.throws(() => createWakeDispatcher({}), /registry/);
  assert.throws(() => createWakeDispatcher({ registry: { resolve() {} } }), /resolveTarget/);
});

test("Unit wake dispatcher: dispatches a wake-worthy event and advances cursor", async () => {
  const claude = fakeAdapter("claude");
  const reg = createWakeRegistry([claude]);
  const d = createWakeDispatcher({ registry: reg, resolveTarget: targetForMythos });

  const out = await d.dispatchEvent({
    sequenceId: 5,
    agentId: "carter",
    payload: { to: "claude-mythos", message: "ping" },
  });

  assert.equal(out.skipped, false);
  assert.equal(out.result.ok, true);
  assert.equal(out.result.hostName, "claude");
  assert.deepEqual(claude.calls[0], { sessionId: "sess-mythos", message: "ping" });
  assert.equal(d.getCursor(), 5);
});

test("Unit wake dispatcher: skips events with no target but still advances cursor", async () => {
  const claude = fakeAdapter("claude");
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos });

  const out = await d.dispatchEvent({ sequenceId: 7, agentId: "carter", payload: { to: "codex", message: "x" } });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, "no_target");
  assert.equal(claude.calls.length, 0);
  assert.equal(d.getCursor(), 7);
});

test("Unit wake dispatcher: does not self-wake the event author", async () => {
  const claude = fakeAdapter("claude");
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos });
  // Author IS the target agent -> resolveTarget returns null -> no wake.
  const out = await d.dispatchEvent({ sequenceId: 8, agentId: "claude-mythos", payload: { to: "claude-mythos", message: "self" } });
  assert.equal(out.skipped, true);
  assert.equal(claude.calls.length, 0);
});

test("Unit wake dispatcher: dedupes events at or below the cursor (RESUME-safe)", async () => {
  const claude = fakeAdapter("claude");
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos });
  d.setCursor(10);

  const old = await d.dispatchEvent({ sequenceId: 9, agentId: "carter", payload: { to: "claude-mythos", message: "stale" } });
  assert.equal(old.skipped, true);
  assert.equal(old.reason, "already_seen");
  assert.equal(claude.calls.length, 0);

  const fresh = await d.dispatchEvent({ sequenceId: 11, agentId: "carter", payload: { to: "claude-mythos", message: "new" } });
  assert.equal(fresh.skipped, false);
  assert.equal(d.getCursor(), 11);
});

test("Unit wake dispatcher: batch processes in seq order and advances to max", async () => {
  const claude = fakeAdapter("claude");
  const d = createWakeDispatcher({ registry: createWakeRegistry([claude]), resolveTarget: targetForMythos });

  await d.dispatchBatch([
    { sequenceId: 3, agentId: "carter", payload: { to: "claude-mythos", message: "c" } },
    { sequenceId: 1, agentId: "carter", payload: { to: "claude-mythos", message: "a" } },
    { sequenceId: 2, agentId: "carter", payload: { to: "claude-mythos", message: "b" } },
  ]);

  assert.deepEqual(claude.calls.map((c) => c.message), ["a", "b", "c"]);
  assert.equal(d.getCursor(), 3);
});

test("Unit wake dispatcher: a throwing adapter yields ok:false and never crashes the loop", async () => {
  const failing = fakeAdapter("claude", { fail: true });
  const results = [];
  const d = createWakeDispatcher({
    registry: createWakeRegistry([failing]),
    resolveTarget: targetForMythos,
    onResult: (r) => results.push(r),
  });

  const out = await d.dispatchEvent({ sequenceId: 4, agentId: "carter", payload: { to: "claude-mythos", message: "m" } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.reason, "boom");
  assert.equal(d.getCursor(), 4); // cursor still advances; backlog won't wedge
  assert.equal(results.length, 1);
});

test("Unit wake dispatcher: unknown host is caught, not thrown", async () => {
  const d = createWakeDispatcher({
    registry: createWakeRegistry([fakeAdapter("codex")]),
    resolveTarget: () => ({ host: "claude", sessionId: "s", message: "m" }),
  });
  const out = await d.dispatchEvent({ sequenceId: 1 });
  assert.equal(out.result.ok, false);
  assert.match(out.result.reason, /no adapter registered/);
});

test("Unit wake dispatcher: setCursor seeds RESUME and getCursor reports it", () => {
  const d = createWakeDispatcher({ registry: createWakeRegistry(), resolveTarget: () => null });
  assert.equal(d.getCursor(), 0);
  d.setCursor(42);
  assert.equal(d.getCursor(), 42);
  d.setCursor(-1); // ignored
  assert.equal(d.getCursor(), 42);
});
