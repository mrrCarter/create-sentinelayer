import test from "node:test";
import assert from "node:assert/strict";

import { shouldPublishListenerPresenceHeartbeat } from "../src/commands/session.js";

function heartbeat(overrides = {}) {
  return {
    type: "heartbeat",
    active: false,
    state: "idle",
    transport: "poll",
    idleIntervalSeconds: 60,
    activeIntervalSeconds: 10,
    activeWindowSeconds: 300,
    lastHumanActivityAt: null,
    ...overrides,
  };
}

test("Unit session listener presence: publishes first, interval, and keepalive heartbeats", () => {
  const first = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 1_000,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(first.publish, true);
  assert.equal(first.reason, "first");

  const duplicate = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 16_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(duplicate.publish, false);
  assert.equal(duplicate.reason, "interval");

  const interval = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 31_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(interval.publish, true);
  assert.equal(interval.reason, "interval");

  const keepalive = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 181_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 30_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(keepalive.publish, true);
  assert.equal(keepalive.reason, "keepalive");
});

test("Unit session listener presence: publishes state changes and stopping heartbeats immediately", () => {
  const first = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat(),
    nowMs: 10_000,
  });

  const changed = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat({
      active: true,
      state: "active",
      lastHumanActivityAt: "2026-06-23T22:00:00.000Z",
    }),
    nowMs: 11_000,
    lastHeartbeatMs: 10_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 60_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(changed.publish, true);
  assert.equal(changed.reason, "changed");

  const stopping = shouldPublishListenerPresenceHeartbeat({
    lifecycle: heartbeat({ stopping: true }),
    nowMs: 12_000,
    lastHeartbeatMs: 10_000,
    lastFingerprint: first.fingerprint,
    presenceIntervalMs: 60_000,
    presenceKeepaliveMs: 180_000,
  });
  assert.equal(stopping.publish, true);
  assert.equal(stopping.reason, "stopping");
});

test("Unit session listener presence: always publishes non-heartbeat lifecycle events", () => {
  const started = shouldPublishListenerPresenceHeartbeat({
    lifecycle: { type: "started", state: "started" },
    nowMs: 1_000,
    lastHeartbeatMs: 1_000,
    lastFingerprint: "same",
  });
  assert.equal(started.publish, true);
  assert.equal(started.reason, "lifecycle");
});
