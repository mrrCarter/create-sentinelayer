import test from "node:test";
import assert from "node:assert/strict";

import { createWakeRegistry, wakeVia } from "../src/session/wake/registry.js";

// A minimal adapter implementing the locked interface, capturing wake() calls.
function fakeAdapter(hostName) {
  const calls = [];
  return {
    hostName,
    calls,
    wake(target, deps = {}) {
      calls.push({ target, deps });
      return Promise.resolve({ ok: true, hostName, sessionId: target.sessionId, code: 0, reason: null });
    },
  };
}

test("Unit wake registry: register then resolve returns the adapter", () => {
  const reg = createWakeRegistry();
  const a = fakeAdapter("claude");
  reg.register(a);
  assert.equal(reg.resolve("claude"), a);
  assert.equal(reg.has("claude"), true);
  assert.deepEqual(reg.hosts(), ["claude"]);
});

test("Unit wake registry: seeds from constructor array", () => {
  const reg = createWakeRegistry([fakeAdapter("claude"), fakeAdapter("codex")]);
  assert.deepEqual(reg.hosts().sort(), ["claude", "codex"]);
});

test("Unit wake registry: resolve unknown host throws with known list", () => {
  const reg = createWakeRegistry([fakeAdapter("claude")]);
  assert.throws(() => reg.resolve("copilot"), /no adapter registered for host "copilot".*known: claude/);
});

test("Unit wake registry: duplicate registration throws", () => {
  const reg = createWakeRegistry([fakeAdapter("claude")]);
  assert.throws(() => reg.register(fakeAdapter("claude")), /already registered/);
});

test("Unit wake registry: rejects invalid adapters", () => {
  assert.throws(() => createWakeRegistry([{ hostName: "x" }]), /must expose a wake\(\) function/);
  assert.throws(() => createWakeRegistry([{ wake() {} }]), /hostName must be a non-empty string/);
  assert.throws(() => createWakeRegistry([null]), /adapter must be an object/);
  assert.throws(() => createWakeRegistry("nope"), /adapters must be an array/);
});

test("Unit wake registry: wakeVia routes to the right adapter and forwards deps", async () => {
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  const reg = createWakeRegistry([claude, codex]);
  const deps = { execFileImpl: () => {} };
  const result = await wakeVia(reg, { host: "codex", sessionId: "s-9", message: "wake: 1 new" }, deps);

  assert.deepEqual(result, { ok: true, hostName: "codex", sessionId: "s-9", code: 0, reason: null });
  assert.equal(codex.calls.length, 1);
  assert.equal(claude.calls.length, 0);
  assert.deepEqual(codex.calls[0].target, { sessionId: "s-9", message: "wake: 1 new" });
  assert.equal(codex.calls[0].deps, deps);
});

test("Unit wake registry: wakeVia surfaces resolve errors for unknown host", async () => {
  const reg = createWakeRegistry([fakeAdapter("claude")]);
  await assert.rejects(() => wakeVia(reg, { host: "codex", sessionId: "s", message: "m" }), /no adapter registered/);
});
