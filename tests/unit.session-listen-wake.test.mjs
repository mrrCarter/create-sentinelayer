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
  const trigger = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: fake },
  });
  assert.ok(trigger, "expected a trigger");
  const outcome = await trigger(messageEvent({ from: "ui-01", to: "api-01" }));
  assert.equal(outcome.woken, true);
  assert.equal(fake.calls.length, 1);
  // Resumes the HOST rollout id (not the senti id), with the routed message.
  assert.equal(fake.calls[0].sessionId, "host-rollout-1");
  assert.ok(typeof fake.calls[0].message === "string" && fake.calls[0].message.length > 0);
});

test("Unit listen-wake: never self-wakes and ignores non-message events", async () => {
  const fake = makeFakeAdapter();
  const trigger = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: fake },
  });
  // Own message → no self-wake.
  const self = await trigger(messageEvent({ from: "api-01", to: "api-01" }));
  assert.equal(self.woken, false);
  assert.equal(self.reason, "not_routed");
  // An ack/reaction is not a wake-worthy message.
  const ack = await trigger({ event: "session_action", agent: { id: "ui-01" }, payload: { actionType: "ack", to: "api-01" } });
  assert.equal(ack.woken, false);
  assert.equal(fake.calls.length, 0);
});

test("Unit listen-wake: a message addressed to a different agent does not wake us", async () => {
  const fake = makeFakeAdapter();
  const trigger = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: fake },
  });
  const other = await trigger(messageEvent({ from: "ui-01", to: "rules-01" }));
  assert.equal(other.woken, false);
  assert.equal(fake.calls.length, 0);
});

test("Unit listen-wake: surfaces an adapter failure without throwing", async () => {
  const failing = {
    hostName: "fake",
    wake: async () => ({ ok: false, reason: "resume_timeout" }),
  };
  const trigger = createListenerHostWake({
    host: "claude",
    resumeSessionId: "host-rollout-1",
    agentId: "api-01",
    sessionId: "senti-1",
    adapters: { claude: failing },
  });
  const outcome = await trigger(messageEvent({ to: "api-01" }));
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
