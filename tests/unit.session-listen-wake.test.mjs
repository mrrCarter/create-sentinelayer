import test from "node:test";
import assert from "node:assert/strict";

import { createListenerHostWake } from "../src/session/wake/listen-wake.js";

function makeFakeAdapter() {
  const calls = [];
  return {
    hostName: "fake",
    wake: async (target) => {
      calls.push(target);
      return { ok: true, hostName: "fake", sessionId: target.sessionId };
    },
    calls,
  };
}

function messageEvent({ from = "ui-01", to = "api-01", text = "ping" } = {}) {
  return {
    event: "session_message",
    agent: { id: from },
    payload: { message: text, to },
  };
}

test("Unit listen-wake: resumes the host on an addressed message", async () => {
  const fake = makeFakeAdapter();
  const wake = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: fake },
  });
  assert.ok(wake && typeof wake.trigger === "function", "expected a wake controller");
  const outcome = await wake.trigger(messageEvent({ from: "ui-01", to: "api-01" }));
  assert.equal(outcome.woken, true);
  assert.equal(fake.calls.length, 1);
  // Resumes the HOST rollout id (not the senti id), with the routed message.
  assert.equal(fake.calls[0].sessionId, "host-rollout-1");
  assert.ok(typeof fake.calls[0].message === "string" && fake.calls[0].message.length > 0);
});

test("Unit listen-wake: never self-wakes and ignores non-message events", async () => {
  const fake = makeFakeAdapter();
  const wake = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: fake },
  });
  // Own message → no self-wake.
  const self = await wake.trigger(messageEvent({ from: "api-01", to: "api-01" }));
  assert.equal(self.woken, false);
  assert.equal(self.reason, "not_routed");
  // An ack/reaction is not a wake-worthy message.
  const ack = await wake.trigger({ event: "session_action", agent: { id: "ui-01" }, payload: { actionType: "ack", to: "api-01" } });
  assert.equal(ack.woken, false);
  assert.equal(fake.calls.length, 0);
});

test("Unit listen-wake: a message addressed to a different agent does not wake us", async () => {
  const fake = makeFakeAdapter();
  const wake = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: fake },
  });
  const other = await wake.trigger(messageEvent({ from: "ui-01", to: "rules-01" }));
  assert.equal(other.woken, false);
  assert.equal(fake.calls.length, 0);
});

test("Unit listen-wake: surfaces an adapter failure without throwing", async () => {
  const failing = {
    hostName: "fake",
    wake: async () => ({ ok: false, reason: "resume_timeout" }),
  };
  const wake = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: failing },
  });
  const outcome = await wake.trigger(messageEvent({ to: "api-01" }));
  assert.equal(outcome.woken, false);
  assert.equal(outcome.reason, "resume_timeout");
});

test("Unit listen-wake: returns null (disabled) without host/resume id", () => {
  assert.equal(createListenerHostWake({ host: "", resumeSessionId: "x", agentId: "a", sessionId: "s" }), null);
  assert.equal(createListenerHostWake({ host: "claude", resumeSessionId: "", agentId: "a", sessionId: "s" }), null);
  assert.equal(
    createListenerHostWake({ host: "nosuch", resumeSessionId: "x", agentId: "a", sessionId: "s" }),
    null,
  );
});

function ackedMessage(seq, to = "api-01") {
  return { event: "session_message", agent: { id: "ui-01" }, payload: { message: "ping", to }, sequenceId: seq };
}

test("Unit listen-wake reconcile: confirms a wake when the agent acks the message", async () => {
  const fake = makeFakeAdapter();
  const wake = createListenerHostWake({
    host: "claude", resumeSessionId: "host-1", agentId: "api-01", sessionId: "senti-1",
    adapters: { claude: fake }, confirmWindowMs: 1000, maxAttempts: 3,
  });
  await wake.trigger(ackedMessage(10));
  assert.equal(wake.pendingCount(), 1);
  // Agent acked seq 10 → confirmed, no retry.
  const fetchActions = async (seq) =>
    seq === 10 ? { ok: true, actions: [{ actorId: "api-01", actionType: "ack" }] } : { ok: true, actions: [] };
  const out = await wake.reconcile({ fetchActions, nowMs: 5000 });
  assert.equal(out.confirmed, 1);
  assert.equal(out.retried, 0);
  assert.equal(wake.pendingCount(), 0);
  assert.equal(fake.calls.length, 1); // only the initial wake; no re-resume
});

test("Unit listen-wake reconcile: re-resumes when no ack within the window, then dead-letters", async () => {
  const fake = makeFakeAdapter();
  const wake = createListenerHostWake({
    host: "claude", resumeSessionId: "host-1", agentId: "api-01", sessionId: "senti-1",
    adapters: { claude: fake }, confirmWindowMs: 1000, maxAttempts: 3,
  });
  await wake.trigger(ackedMessage(11)); // attempt 1
  const noAck = async () => ({ ok: true, actions: [] });
  // t=0 stamps lastWakeAt; window not elapsed yet → still pending
  let out = await wake.reconcile({ fetchActions: noAck, nowMs: 0 });
  assert.equal(out.stillPending, 1);
  // window elapsed → retry (attempt 2)
  out = await wake.reconcile({ fetchActions: noAck, nowMs: 2000 });
  assert.equal(out.retried, 1);
  // again → attempt 3
  out = await wake.reconcile({ fetchActions: noAck, nowMs: 4000 });
  assert.equal(out.retried, 1);
  // attempts exhausted (3) → dead-letter, stop re-resuming
  out = await wake.reconcile({ fetchActions: noAck, nowMs: 6000 });
  assert.equal(out.deadLettered, 1);
  assert.equal(wake.pendingCount(), 0);
  // 1 initial + 2 retries = 3 resume calls, never more
  assert.equal(fake.calls.length, 3);
});

test("Unit listen-wake reconcile: a non-self ack does not confirm our wake", async () => {
  const fake = makeFakeAdapter();
  const wake = createListenerHostWake({
    host: "claude", resumeSessionId: "host-1", agentId: "api-01", sessionId: "senti-1",
    adapters: { claude: fake }, confirmWindowMs: 1000, maxAttempts: 3,
  });
  await wake.trigger(ackedMessage(12));
  // Someone ELSE acked seq 12 — not our agent; we're still unconfirmed.
  const otherAck = async () => ({ ok: true, actions: [{ actorId: "ui-01", actionType: "ack" }] });
  await wake.reconcile({ fetchActions: otherAck, nowMs: 0 });
  const out = await wake.reconcile({ fetchActions: otherAck, nowMs: 2000 });
  assert.equal(out.confirmed, 0);
  assert.equal(out.retried, 1);
});
