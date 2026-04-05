import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectStuckState,
  determineRecoveryAction,
  routeErrorToPersona,
  buildAlertPayload,
  buildHealthSummary,
  STUCK_THRESHOLDS,
} from "../src/agents/jules/pulse.js";

describe("detectStuckState", () => {
  it("detects no tool calls for 90+ seconds", () => {
    const result = detectStuckState({
      lastToolCallAt: Date.now() - 100000,
      sameFileReadCount: 0,
      budgetConsumedPct: 0,
      findingCount: 0,
    });
    assert.equal(result.stuck, true);
    assert.equal(result.reason, "no_tool_calls");
    assert.ok(result.idleSeconds >= 90);
  });

  it("detects loop from repeated file reads", () => {
    const result = detectStuckState({
      lastToolCallAt: Date.now(),
      sameFileReadCount: 3,
      lastFileRead: "src/App.tsx",
      budgetConsumedPct: 0,
      findingCount: 0,
    });
    assert.equal(result.stuck, true);
    assert.equal(result.reason, "loop_detected");
    assert.equal(result.file, "src/App.tsx");
  });

  it("detects inefficient budget usage", () => {
    const result = detectStuckState({
      lastToolCallAt: Date.now(),
      sameFileReadCount: 0,
      budgetConsumedPct: 60,
      findingCount: 0,
    });
    assert.equal(result.stuck, true);
    assert.equal(result.reason, "inefficient");
  });

  it("returns not stuck for healthy agent", () => {
    const result = detectStuckState({
      lastToolCallAt: Date.now(),
      sameFileReadCount: 1,
      budgetConsumedPct: 30,
      findingCount: 5,
    });
    assert.equal(result.stuck, false);
  });
});

describe("determineRecoveryAction", () => {
  it("returns hint for short idle", () => {
    assert.equal(determineRecoveryAction(60), "hint");
  });
  it("returns escalate for medium idle", () => {
    assert.equal(determineRecoveryAction(350), "escalate");
  });
  it("returns kill for long idle", () => {
    assert.equal(determineRecoveryAction(700), "kill");
  });
});

describe("routeErrorToPersona", () => {
  it("routes .tsx stack traces to frontend", () => {
    assert.equal(routeErrorToPersona({ stackTrace: "Error at src/App.tsx:42" }), "frontend");
  });
  it("routes React errors to frontend", () => {
    assert.equal(routeErrorToPersona({ stackTrace: "React hydration mismatch" }), "frontend");
  });
  it("routes .py stack traces to backend", () => {
    assert.equal(routeErrorToPersona({ stackTrace: "File main.py:10" }), "backend");
  });
  it("routes auth endpoints to security", () => {
    assert.equal(routeErrorToPersona({ endpoint: "/api/v1/auth/login" }), "security");
  });
  it("routes API endpoints to backend", () => {
    assert.equal(routeErrorToPersona({ endpoint: "/api/v1/users" }), "backend");
  });
  it("routes HYDRATION error codes to frontend", () => {
    assert.equal(routeErrorToPersona({ errorCode: "HYDRATION_MISMATCH" }), "frontend");
  });
  it("routes TIMEOUT to infrastructure", () => {
    assert.equal(routeErrorToPersona({ errorCode: "ECONNREFUSED" }), "infrastructure");
  });
  it("defaults to backend", () => {
    assert.equal(routeErrorToPersona({}), "backend");
  });
});

describe("buildAlertPayload", () => {
  it("builds alert with persona identity", () => {
    const alert = buildAlertPayload({
      agentId: "frontend",
      event: "agent_stuck",
      state: { durationMs: 45000, budgetPct: 73, findingCount: 3, lastAction: "FileRead src/App.tsx" },
      workItemId: "err-123",
      jiraIssueKey: "SLD-456",
    });
    assert.ok(alert.headline.includes("Jules Tanaka"));
    assert.ok(alert.headline.includes("Stuck"));
    assert.ok(alert.body.includes("err-123"));
    assert.ok(alert.body.includes("SLD-456"));
    assert.ok(alert.body.includes("73%"));
    assert.equal(alert.severity, "warning");
  });

  it("marks merge events as success severity", () => {
    const alert = buildAlertPayload({ agentId: "frontend", event: "pr_merged", state: {} });
    assert.equal(alert.severity, "success");
  });
});

describe("buildHealthSummary", () => {
  it("returns null for empty states", () => {
    assert.equal(buildHealthSummary([]), null);
    assert.equal(buildHealthSummary(null), null);
  });

  it("builds summary with active agents", () => {
    const summary = buildHealthSummary([
      { agentId: "frontend", status: "active", findingCount: 3, costUsd: 1.5 },
      { agentId: "security", status: "active", findingCount: 1, costUsd: 0.8 },
    ]);
    assert.ok(summary);
    assert.ok(summary.headline.includes("2 active"));
    assert.ok(summary.body.includes("Jules"));
    assert.ok(summary.body.includes("Nina"));
  });

  it("highlights stuck agents", () => {
    const summary = buildHealthSummary([
      { agentId: "frontend", status: "active", stuck: true, reason: "no_tool_calls", idleSeconds: 120 },
    ]);
    assert.ok(summary.body.includes("Stuck"));
    assert.ok(summary.body.includes("no_tool_calls"));
  });
});

describe("STUCK_THRESHOLDS", () => {
  it("has all expected thresholds", () => {
    assert.ok(STUCK_THRESHOLDS.noToolCallSeconds > 0);
    assert.ok(STUCK_THRESHOLDS.sameFileReadCount > 0);
    assert.ok(STUCK_THRESHOLDS.maxIdleBeforeKill > STUCK_THRESHOLDS.maxIdleBeforeEscalate);
  });
});
