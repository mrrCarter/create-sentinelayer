import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionCoachingEvent } from "../src/commands/session.js";
import {
  SESSION_LIVE_SUCCESS_TIPS,
  getSessionLiveSuccessTips,
} from "../src/session/coordination-guidance.js";

test("Unit coaching tips: cover ack and claim-work, and are non-empty", () => {
  const tips = getSessionLiveSuccessTips();
  assert.ok(tips.length >= 3);
  assert.ok(tips.some((t) => /ack/i.test(t)), "a tip should cover acking");
  assert.ok(tips.some((t) => /working_on|claim/i.test(t)), "a tip should cover claiming work");
  // accessor returns a copy, not the frozen source
  assert.notEqual(tips, SESSION_LIVE_SUCCESS_TIPS);
});

test("Unit coaching event: shape, tips, and agent identity", () => {
  const event = buildSessionCoachingEvent({
    sessionId: "sess-1",
    agentId: "claude-mythos",
    listenerId: "listener-x",
    tick: 0,
  });
  assert.equal(event.event, "session_coaching");
  assert.equal(event.agent.id, "claude-mythos");
  assert.equal(event.payload.kind, "coaching");
  assert.deepEqual(event.payload.tips, [...SESSION_LIVE_SUCCESS_TIPS]);
});

test("Unit coaching event: tick makes each emission idempotency-distinct", () => {
  const a = buildSessionCoachingEvent({ sessionId: "s", agentId: "a", listenerId: "l", tick: 0 });
  const b = buildSessionCoachingEvent({ sessionId: "s", agentId: "a", listenerId: "l", tick: 1 });
  assert.notEqual(a.eventId, b.eventId);
  assert.notEqual(a.idempotencyToken, b.idempotencyToken);
});

test("Unit coaching event: falls back to default tips when given empty", () => {
  const event = buildSessionCoachingEvent({ sessionId: "s", agentId: "a", tips: [] });
  assert.deepEqual(event.payload.tips, [...SESSION_LIVE_SUCCESS_TIPS]);
});
