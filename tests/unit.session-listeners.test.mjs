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

function sessionMessage(sequenceId, message = "busy room chatter") {
  return {
    event: "session_message",
    sequenceId,
    agent: { id: "builder" },
    payload: { message: `${message} ${sequenceId}` },
    ts: "2026-06-14T08:00:20Z",
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

test("Unit listeners: fetchSessionListeners summarizes a poll result", async () => {
  let pollOptions = null;
  const fakePoll = async () => ({
    ok: true,
    events: [heartbeat("api-01", { active: true, activeIntervalSeconds: 30 }, "2026-06-14T08:00:20Z")],
  });
  const recordingPoll = async (sessionId, options) => {
    pollOptions = { sessionId, options };
    return fakePoll();
  };
  const result = await fetchSessionListeners("sess-1", { poll: recordingPoll, nowMs: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(result.listeners.length, 1);
  assert.equal(result.listeners[0].status, "active");
  assert.equal(pollOptions.sessionId, "sess-1");
  assert.equal(pollOptions.options.forceCircuitProbe, true);
});

test("Unit listeners: fetchSessionListeners walks older pages when the tail is noisy", async () => {
  const calls = [];
  const pages = [
    {
      ok: true,
      beforeSequence: 300,
      events: [
        sessionMessage(498),
        sessionMessage(499),
        sessionMessage(500),
      ],
    },
    {
      ok: true,
      beforeSequence: 250,
      events: [
        heartbeat(
          "codex",
          {
            active: false,
            idleIntervalSeconds: 60,
            presenceIntervalSeconds: 60,
            presenceKeepaliveSeconds: 180,
          },
          "2026-06-14T08:00:10Z",
        ),
        sessionMessage(299),
      ],
    },
  ];
  const fakePoll = async (_sessionId, options) => {
    calls.push(options);
    return pages[calls.length - 1];
  };

  const result = await fetchSessionListeners("sess-noisy", {
    poll: fakePoll,
    nowMs: () => NOW,
    limit: 3,
    maxPages: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.pageCount, 2);
  assert.equal(result.scannedEventCount, 5);
  assert.equal(result.listenerEventCount, 1);
  assert.equal(calls[0].beforeSequence, null);
  assert.equal(calls[1].beforeSequence, 300);
  assert.equal(result.listeners.length, 1);
  assert.equal(result.listeners[0].agentId, "codex");
  assert.equal(result.listeners[0].status, "idle");
});

test("Unit listeners: fetchSessionListeners stops after a full page once listeners are found", async () => {
  const calls = [];
  const fakePoll = async (_sessionId, options) => {
    calls.push(options);
    return {
      ok: true,
      beforeSequence: 300,
      events: [
        sessionMessage(498),
        heartbeat("codex", { active: false, idleIntervalSeconds: 60 }, "2026-06-14T08:00:10Z"),
        sessionMessage(500),
      ],
    };
  };

  const result = await fetchSessionListeners("sess-listeners-in-tail", {
    poll: fakePoll,
    nowMs: () => NOW,
    limit: 3,
    maxPages: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.pageCount, 1);
  assert.equal(result.scannedEventCount, 3);
  assert.equal(result.listenerEventCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(result.listeners.length, 1);
});

test("Unit listeners: fetchSessionListeners stops on non-advancing beforeSequence", async () => {
  const calls = [];
  const fakePoll = async (_sessionId, options) => {
    calls.push(options);
    return {
      ok: true,
      beforeSequence: 40,
      events: [
        sessionMessage(98),
        sessionMessage(99),
      ],
    };
  };

  const result = await fetchSessionListeners("sess-cyclic", {
    poll: fakePoll,
    nowMs: () => NOW,
    limit: 2,
    maxPages: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.pageCount, 2);
  assert.equal(result.listenerEventCount, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].beforeSequence, null);
  assert.equal(calls[1].beforeSequence, 40);
});

test("Unit listeners: fetch surfaces a failed poll without throwing", async () => {
  const fakePoll = async () => ({ ok: false, reason: "auth_required" });
  const result = await fetchSessionListeners("sess-1", { poll: fakePoll });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "auth_required");
  assert.deepEqual(result.listeners, []);
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
