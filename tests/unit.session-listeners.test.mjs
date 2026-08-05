import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchSessionListeners,
  formatListenerLine,
  summarizeListeners,
} from "../src/session/listeners.js";

function heartbeat(agentId, payload = {}, ts = "2026-06-14T08:00:00.000Z", event = "session_listener_heartbeat") {
  return {
    event,
    agent: { id: agentId, model: "gpt-5.5", displayName: agentId },
    payload: { source: "session_listen", listenerId: agentId, ...payload },
    ts,
  };
}

const NOW = Date.parse("2026-06-14T08:00:30.000Z");

test("Unit listeners: one row per agent from the latest heartbeat, active vs idle cadence", () => {
  const rows = summarizeListeners(
    [
      heartbeat("api-01-gpt-5.5", { active: true, activeIntervalSeconds: 30, idleIntervalSeconds: 60 }, "2026-06-14T07:59:00Z"),
      heartbeat("api-01-gpt-5.5", { active: true, activeIntervalSeconds: 30, idleIntervalSeconds: 60 }, "2026-06-14T08:00:20Z"),
      heartbeat("ui-01-gpt-5.5", { active: false, activeIntervalSeconds: 30, idleIntervalSeconds: 90 }, "2026-06-14T08:00:10Z"),
    ],
    { nowMs: NOW },
  );
  assert.equal(rows.length, 2);
  const api = rows.find((r) => r.agentId === "api-01-gpt-5.5");
  const ui = rows.find((r) => r.agentId === "ui-01-gpt-5.5");
  assert.equal(api.status, "active");
  assert.equal(api.cadenceSeconds, 30); // active window → fast interval
  assert.equal(ui.status, "idle");
  assert.equal(ui.cadenceSeconds, 90); // idle → idle interval
  // active listed before idle
  assert.equal(rows[0].agentId, "api-01-gpt-5.5");
});

test("Unit listeners: stopped lifecycle and stale heartbeats are classified, not shown live", () => {
  const rows = summarizeListeners(
    [
      heartbeat("infra-gpt5.5", { active: false, idleIntervalSeconds: 60 }, "2026-06-14T07:55:00Z"), // 5.5min old → stale
      heartbeat("vision-01", { active: true }, "2026-06-14T08:00:25Z", "session_listener_stopped"),
    ],
    { nowMs: NOW },
  );
  const infra = rows.find((r) => r.agentId === "infra-gpt5.5");
  const vision = rows.find((r) => r.agentId === "vision-01");
  assert.equal(infra.status, "stale");
  assert.equal(vision.status, "stopped");
});

test("Unit listeners: advertised presence keepalive extends stale window", () => {
  const rows = summarizeListeners(
    [
      heartbeat(
        "codex",
        {
          active: false,
          idleIntervalSeconds: 60,
          presenceIntervalSeconds: 60,
          presenceKeepaliveSeconds: 300,
        },
        "2026-06-14T07:55:00Z",
      ),
    ],
    { nowMs: NOW },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "idle");
  assert.equal(rows[0].presenceKeepaliveSeconds, 300);
  assert.equal(rows[0].staleAfterSeconds, 360);
});

test("Unit listeners: advertised presence keepalive does not keep dead listeners live for 2.5x", () => {
  const rows = summarizeListeners(
    [
      heartbeat(
        "codex",
        {
          active: false,
          idleIntervalSeconds: 40,
          presenceIntervalSeconds: 30,
          presenceKeepaliveSeconds: 180,
        },
        "2026-06-14T07:56:49Z",
      ),
    ],
    { nowMs: NOW },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastSeenAgoSeconds, 221);
  assert.equal(rows[0].staleAfterSeconds, 220);
  assert.equal(rows[0].status, "stale");
});

test("Unit listeners: ignores non-listener events", () => {
  const rows = summarizeListeners(
    [
      { event: "session_message", agent: { id: "human-carter" }, payload: { message: "hi" }, ts: "2026-06-14T08:00:00Z" },
      heartbeat("api-01", { active: true, activeIntervalSeconds: 30 }, "2026-06-14T08:00:20Z"),
    ],
    { nowMs: NOW },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "api-01");
});

test("Unit listeners: fetchSessionListeners uses the ephemeral presence endpoint once", async () => {
  const calls = [];
  const result = await fetchSessionListeners("sess-1", {
    nowMs: () => NOW,
    fetchPresence: async (sessionId, options) => {
      calls.push({ sessionId, options });
      return {
        ok: true,
        status: "ok",
        enabled: true,
        present: [
          {
            agentId: "api-01",
            lastSeenMs: Date.parse("2026-06-14T08:00:20Z"),
          },
        ],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.authoritative, true);
  assert.equal(result.presenceStatus, "ok");
  assert.equal(result.listeners.length, 1);
  assert.equal(result.listeners[0].status, "present");
  assert.equal(result.listeners[0].lastSeenAgoSeconds, 10);
  assert.deepEqual(calls, [
    {
      sessionId: "sess-1",
      options: { targetPath: process.cwd(), forceCircuitProbe: true },
    },
  ]);
  assert.equal(result.scannedEventCount, 0);
  assert.equal(result.listenerEventCount, 0);
});

test("Unit listeners: degraded presence stays unknown and never scans event history", async () => {
  let presenceCalls = 0;
  const result = await fetchSessionListeners("sess-degraded", {
    fetchPresence: async () => {
      presenceCalls += 1;
      return {
        ok: false,
        status: "degraded",
        enabled: true,
        reason: "api_503",
        retryAfterMs: 12_000,
        present: [],
      };
    },
  });

  assert.equal(presenceCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.presenceStatus, "degraded");
  assert.equal(result.retryAfterMs, 12_000);
  assert.deepEqual(result.listeners, []);
  assert.equal(result.pageCount, 0);
  assert.equal(result.scannedEventCount, 0);
});

test("Unit listeners: disabled or unsupported presence never re-enables durable heartbeats", async () => {
  for (const response of [
    {
      ok: false,
      status: "unsupported",
      enabled: false,
      reason: "presence_disabled",
      present: [],
    },
    {
      ok: false,
      status: "unsupported",
      enabled: false,
      reason: "presence_unsupported",
      present: [],
    },
  ]) {
    const result = await fetchSessionListeners("sess-old-server", {
      fetchPresence: async () => response,
    });
    assert.equal(result.ok, false);
    assert.equal(result.authoritative, false);
    assert.equal(result.presenceStatus, "unsupported");
    assert.deepEqual(result.listeners, []);
    assert.equal(result.listenerEventCount, 0);
  }
});

test("Unit listeners: formatListenerLine renders status, cadence, last-seen", () => {
  const line = formatListenerLine({
    agentId: "api-01-gpt-5.5",
    status: "active",
    cadenceSeconds: 30,
    lastSeenAgoSeconds: 10,
  });
  assert.ok(line.includes("active"));
  assert.ok(line.includes("api-01-gpt-5.5"));
  assert.ok(line.includes("cadence=30s"));
  assert.ok(line.includes("last_seen=10s ago"));
});

test("Unit listeners: formatListenerLine exposes multiple local listener pids", () => {
  const line = formatListenerLine({
    agentId: "codex-01",
    status: "idle",
    cadenceSeconds: 45,
    lastSeenAgoSeconds: 3,
    localProcessCount: 2,
    localProcessPids: [1234, 5678],
  });
  assert.ok(line.includes("codex-01"));
  assert.ok(line.includes("local_pids=1234,5678"));
});
