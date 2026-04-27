import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { evaluateBudget } from "../src/cost/budget.js";
import {
  appendCostEntry,
  loadCostHistory,
  summarizeCostHistory,
} from "../src/cost/history.js";

test("Unit cost history: appends entries and summarizes per-session totals", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cost-"));
  try {
    const initial = await loadCostHistory({ targetPath: tempRoot });
    assert.equal(initial.history.entries.length, 0);

    await appendCostEntry(
      { targetPath: tempRoot },
      {
        sessionId: "session-a",
        provider: "openai",
        model: "gpt-5.3-codex",
        inputTokens: 1200,
        outputTokens: 800,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        durationMs: 1200,
        toolCalls: 2,
        costUsd: 0.012,
        progressScore: 1,
      }
    );
    await appendCostEntry(
      { targetPath: tempRoot },
      {
        sessionId: "session-a",
        provider: "openai",
        model: "gpt-5.3-codex",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 300,
        toolCalls: 1,
        costUsd: 0.002,
        progressScore: 0,
      }
    );
    await appendCostEntry(
      { targetPath: tempRoot },
      {
        sessionId: "session-b",
        provider: "anthropic",
        model: "claude-sonnet-4",
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 700,
        toolCalls: 4,
        costUsd: 0.01,
        progressScore: 0,
      }
    );

    const loaded = await loadCostHistory({ targetPath: tempRoot });
    const summary = summarizeCostHistory(loaded.history);

    assert.equal(summary.sessionCount, 2);
    assert.equal(summary.invocationCount, 3);
    assert.equal(summary.inputTokens, 1700);
    assert.equal(summary.outputTokens, 1050);
    assert.equal(summary.durationMs, 2200);
    assert.equal(summary.toolCalls, 7);
    assert.equal(summary.costUsd, 0.024);

    const sessionA = summary.sessions.find((session) => session.sessionId === "session-a");
    assert.equal(sessionA.invocationCount, 2);
    assert.equal(sessionA.costUsd, 0.014);
    assert.equal(sessionA.durationMs, 1500);
    assert.equal(sessionA.toolCalls, 3);
    assert.equal(sessionA.noProgressStreak, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit cost history: concurrent appends preserve valid JSON and all entries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cost-concurrent-"));
  try {
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        appendCostEntry(
          { targetPath: tempRoot },
          {
            sessionId: `session-${index}`,
            provider: "openai",
            model: "gpt-5.3-codex",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            durationMs: 1,
            toolCalls: 1,
            costUsd: 0.001,
            progressScore: 1,
          }
        )
      )
    );

    const loaded = await loadCostHistory({ targetPath: tempRoot });
    assert.equal(loaded.history.entries.length, 24);
    assert.equal(summarizeCostHistory(loaded.history).invocationCount, 24);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit cost budget: triggers deterministic reasons and warning thresholds", () => {
  const result = evaluateBudget({
    sessionSummary: {
      costUsd: 1.2,
      outputTokens: 2500,
      durationMs: 6100,
      toolCalls: 61,
      noProgressStreak: 3,
    },
    maxCostUsd: 1.0,
    maxOutputTokens: 2000,
    maxRuntimeMs: 6000,
    maxToolCalls: 60,
    maxNoProgress: 3,
    warningThresholdPercent: 80,
  });

  assert.equal(result.blocking, true);
  assert.equal(result.reasons.some((reason) => reason.code === "MAX_COST_EXCEEDED"), true);
  assert.equal(
    result.reasons.some((reason) => reason.code === "MAX_OUTPUT_TOKENS_EXCEEDED"),
    true
  );
  assert.equal(
    result.reasons.some((reason) => reason.code === "MAX_RUNTIME_MS_EXCEEDED"),
    true
  );
  assert.equal(
    result.reasons.some((reason) => reason.code === "MAX_TOOL_CALLS_EXCEEDED"),
    true
  );
  assert.equal(result.reasons.some((reason) => reason.code === "DIMINISHING_RETURNS"), true);
});

test("Unit cost budget: emits warnings when usage reaches threshold without hard stop", () => {
  const result = evaluateBudget({
    sessionSummary: {
      costUsd: 0.85,
      outputTokens: 850,
      durationMs: 8500,
      toolCalls: 17,
      noProgressStreak: 0,
    },
    maxCostUsd: 1.0,
    maxOutputTokens: 1000,
    maxRuntimeMs: 10000,
    maxToolCalls: 20,
    maxNoProgress: 3,
    warningThresholdPercent: 80,
  });

  assert.equal(result.blocking, false);
  assert.equal(result.warnings.some((warning) => warning.code === "COST_BUDGET_NEAR_LIMIT"), true);
  assert.equal(
    result.warnings.some((warning) => warning.code === "OUTPUT_TOKENS_NEAR_LIMIT"),
    true
  );
  assert.equal(result.warnings.some((warning) => warning.code === "RUNTIME_MS_NEAR_LIMIT"), true);
  assert.equal(result.warnings.some((warning) => warning.code === "TOOL_CALLS_NEAR_LIMIT"), true);
});

