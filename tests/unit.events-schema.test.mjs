import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_EVENT_STREAM,
  AGENT_EVENT_TYPES,
  createAgentEvent,
  normalizeAgentEvent,
  validateAgentEvent,
} from "../src/events/schema.js";

describe("createAgentEvent", () => {
  it("returns canonical envelope with required fields", () => {
    const evt = createAgentEvent({
      event: "progress",
      agentId: "omar-orchestrator",
      payload: { phase: "dispatch", message: "running" },
      usage: { costUsd: 0.12, outputTokens: 90, toolCalls: 2, durationMs: 450 },
    });

    assert.equal(evt.stream, AGENT_EVENT_STREAM);
    assert.equal(evt.event, "progress");
    assert.equal(evt.agent.id, "omar-orchestrator");
    assert.equal(evt.payload.phase, "dispatch");
    assert.ok(evt.ts);
    assert.equal(evt.timestamp, evt.ts);
  });

  it("preserves extended agent identity fields", () => {
    const evt = createAgentEvent({
      event: "finding",
      agent: {
        id: "frontend",
        persona: "Jules Tanaka",
        color: "cyan",
        avatar: "J",
      },
      payload: { severity: "P2" },
    });

    assert.equal(evt.agent.id, "frontend");
    assert.equal(evt.agent.persona, "Jules Tanaka");
    assert.equal(evt.agent.color, "cyan");
    assert.equal(evt.agent.avatar, "J");
  });

  it("throws when required fields are missing", () => {
    assert.throws(() => createAgentEvent({}), /requires event, agentId, and payload/);
    assert.throws(
      () => createAgentEvent({ event: "progress", agentId: "omar-orchestrator" }),
      /requires event, agentId, and payload/
    );
    assert.throws(
      () =>
        createAgentEvent({
          event: "progress",
          agentId: "omar-orchestrator",
          payload: null,
        }),
      /requires event, agentId, and payload/
    );
  });

  it("round-trips correlation ids", () => {
    const evt = createAgentEvent({
      event: "heartbeat",
      agentId: "omar-orchestrator",
      payload: { status: "ok" },
      sessionId: "sess-123",
      runId: "run-456",
      workItemId: "wi-789",
      requestId: "req-999",
    });

    assert.equal(evt.sessionId, "sess-123");
    assert.equal(evt.runId, "run-456");
    assert.equal(evt.workItemId, "wi-789");
    assert.equal(evt.requestId, "req-999");
  });
});

describe("validateAgentEvent", () => {
  it("accepts canonical events and rejects malformed events", () => {
    const good = createAgentEvent({
      event: "tool_call",
      agentId: "frontend",
      payload: { tool: "FileRead" },
    });
    assert.equal(validateAgentEvent(good), true);

    assert.equal(validateAgentEvent(null), false);
    assert.equal(validateAgentEvent({ stream: "other_stream", event: "x" }), false);
    assert.equal(
      validateAgentEvent({
        stream: AGENT_EVENT_STREAM,
        event: "progress",
        payload: { ok: true },
      }),
      false
    );
  });

  it("accepts legacy shapes through compatibility shim", () => {
    const legacy = {
      stream: AGENT_EVENT_STREAM,
      event: "progress",
      agentId: "legacy-agent",
      payload: { message: "legacy payload" },
      timestamp: "2026-04-16T12:30:00Z",
    };
    assert.equal(validateAgentEvent(legacy), true);

    const normalized = normalizeAgentEvent(legacy);
    assert.ok(normalized);
    assert.equal(normalized.agent.id, "legacy-agent");
    assert.equal(normalized.payload.message, "legacy payload");
    assert.equal(normalized.ts, "2026-04-16T12:30:00.000Z");
  });

  it("normalizes non-stream legacy daemon alerts when allowed", () => {
    const legacyDaemonAlert = {
      type: "daemon_alert",
      alert: "agent_stuck",
      target: "frontend",
      message: "No progress in 90s",
    };
    assert.equal(validateAgentEvent(legacyDaemonAlert), true);
    assert.equal(validateAgentEvent(legacyDaemonAlert, { allowLegacy: false }), false);
  });
});

describe("AGENT_EVENT_TYPES", () => {
  it("includes typed audit orchestrator lifecycle events", () => {
    for (const eventType of [
      "orchestrator_start",
      "phase_start",
      "phase_complete",
      "dispatch",
      "reconcile_start",
      "reconcile_complete",
      "orchestrator_complete",
    ]) {
      assert.equal(AGENT_EVENT_TYPES.includes(eventType), true, `${eventType} should be listed`);
    }
  });
});
