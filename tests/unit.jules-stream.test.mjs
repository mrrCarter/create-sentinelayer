import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildStreamEvent,
  createStreamEmitter,
  formatTerminalLine,
  EVENT_TYPES,
} from "../src/agents/jules/stream.js";

describe("buildStreamEvent", () => {
  it("builds envelope with all required fields", () => {
    const evt = buildStreamEvent(
      "finding",
      { id: "frontend", persona: "Jules Tanaka" },
      { severity: "P1", file: "src/App.tsx", line: 42, title: "XSS sink" },
      { costUsd: 0.5, toolCalls: 3 },
      "run-123",
    );
    assert.equal(evt.stream, "sl_event");
    assert.equal(evt.version, 1);
    assert.equal(evt.event, "finding");
    assert.equal(evt.agent.id, "frontend");
    assert.equal(evt.agent.persona, "Jules Tanaka");
    assert.equal(evt.agent.color, "cyan");
    assert.ok(evt.agent.avatar);
    assert.equal(evt.payload.severity, "P1");
    assert.equal(evt.usage.costUsd, 0.5);
    assert.equal(evt.runId, "run-123");
    assert.ok(evt.timestamp);
  });

  it("resolves visual identity from persona registry", () => {
    const evt = buildStreamEvent("agent_start", { id: "security" }, {});
    assert.equal(evt.agent.color, "red");
    assert.equal(evt.agent.persona, "Nina Patel");
  });

  it("handles unknown agent gracefully", () => {
    const evt = buildStreamEvent("progress", { id: "unknown-agent" }, {});
    assert.equal(evt.agent.id, "unknown-agent");
    assert.equal(evt.agent.color, "white");
  });
});

describe("createStreamEmitter", () => {
  it("emits events with accumulated usage", () => {
    const events = [];
    const emitter = createStreamEmitter({
      agentIdentity: { id: "frontend", persona: "Jules Tanaka" },
      runId: "test-run",
      onEvent: (e) => events.push(e),
    });

    emitter.emit("agent_start", { mode: "primary" });
    emitter.updateUsage({ costUsd: 0.5, toolCalls: 3 });
    emitter.emit("finding", { severity: "P1" });

    assert.equal(events.length, 2);
    assert.equal(events[0].event, "agent_start");
    assert.equal(events[1].usage.costUsd, 0.5);
    assert.equal(events[1].usage.toolCalls, 3);
  });

  it("stops emitting after close", () => {
    const events = [];
    const emitter = createStreamEmitter({
      agentIdentity: { id: "frontend" },
      runId: "test",
      onEvent: (e) => events.push(e),
    });

    emitter.emit("agent_start", {});
    emitter.close();
    emitter.emit("finding", {}); // should be ignored

    assert.equal(events.length, 1);
  });

  it("getUsage returns current snapshot", () => {
    const emitter = createStreamEmitter({
      agentIdentity: { id: "frontend" },
      runId: "test",
    });
    emitter.updateUsage({ costUsd: 1.23, toolCalls: 5, durationMs: 3000 });
    const usage = emitter.getUsage();
    assert.equal(usage.costUsd, 1.23);
    assert.equal(usage.toolCalls, 5);
    assert.equal(usage.durationMs, 3000);
  });
});

describe("formatTerminalLine", () => {
  it("formats finding with severity", () => {
    const line = formatTerminalLine({
      event: "finding",
      agent: { avatar: "\u{1F3AF}", persona: "Jules Tanaka" },
      payload: { severity: "P1", file: "src/App.tsx", line: 42, title: "XSS sink" },
    });
    assert.ok(line.includes("P1"));
    assert.ok(line.includes("src/App.tsx"));
    assert.ok(line.includes("42"));
    assert.ok(line.includes("XSS sink"));
  });

  it("formats heartbeat with budget", () => {
    const line = formatTerminalLine({
      event: "heartbeat",
      agent: { avatar: "\u{1F3AF}", persona: "Jules" },
      payload: { turnsCompleted: 5, turnsMax: 25, budgetRemaining: { pct: 73 }, findingsSoFar: 3 },
    });
    assert.ok(line.includes("5/25"));
    assert.ok(line.includes("73%"));
    assert.ok(line.includes("3 findings"));
  });

  it("formats tool_call with file path", () => {
    const line = formatTerminalLine({
      event: "tool_call",
      agent: { avatar: "\u{1F3AF}", persona: "Jules" },
      payload: { tool: "FileRead", input: { file_path: "src/auth/service.js" } },
    });
    assert.ok(line.includes("FileRead"));
    assert.ok(line.includes("src/auth/service.js"));
  });

  it("formats agent_complete with summary", () => {
    const line = formatTerminalLine({
      event: "agent_complete",
      agent: { avatar: "\u{1F3AF}", persona: "Jules Tanaka" },
      payload: { total: 7, P0: 0, P1: 2, P2: 5, costUsd: 1.8, durationMs: 45000 },
    });
    assert.ok(line.includes("7 findings"));
    assert.ok(line.includes("P0=0"));
    assert.ok(line.includes("P1=2"));
    assert.ok(line.includes("$1.80"));
  });

  it("formats all event types without throwing", () => {
    for (const eventType of EVENT_TYPES) {
      const line = formatTerminalLine({
        event: eventType,
        agent: { avatar: "", persona: "Test" },
        payload: {},
      });
      assert.ok(typeof line === "string");
    }
  });
});

describe("EVENT_TYPES", () => {
  it("contains all expected types", () => {
    assert.ok(EVENT_TYPES.includes("agent_start"));
    assert.ok(EVENT_TYPES.includes("finding"));
    assert.ok(EVENT_TYPES.includes("heartbeat"));
    assert.ok(EVENT_TYPES.includes("tool_call"));
    assert.ok(EVENT_TYPES.includes("budget_stop"));
    assert.ok(EVENT_TYPES.includes("swarm_complete"));
    assert.ok(EVENT_TYPES.length >= 16);
  });
});
