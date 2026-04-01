import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  appendRunEvent,
  deriveStopClassFromBudget,
  loadRunEvents,
  mapBudgetReasonToStopClass,
  normalizeRunEvent,
  summarizeRunEvents,
} from "../src/telemetry/ledger.js";

test("Unit telemetry: ledger append/load/summarize stays deterministic", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-unit-telemetry-"));
  try {
    await appendRunEvent(
      {
        targetPath: tempRoot,
      },
      {
        sessionId: "session-1",
        runId: "run-1",
        eventType: "run_start",
      }
    );

    await appendRunEvent(
      {
        targetPath: tempRoot,
      },
      {
        sessionId: "session-1",
        runId: "run-1",
        eventType: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
          costUsd: 0.025,
          durationMs: 1500,
          toolCalls: 3,
        },
        metadata: {
          sourceCommand: "unit-test",
        },
      }
    );

    await appendRunEvent(
      {
        targetPath: tempRoot,
      },
      {
        sessionId: "session-1",
        runId: "run-1",
        eventType: "run_stop",
        stop: {
          stopClass: "MAX_COST_EXCEEDED",
          blocking: true,
          reasonCodes: ["MAX_COST_EXCEEDED"],
        },
      }
    );

    const { filePath, events } = await loadRunEvents({
      targetPath: tempRoot,
    });
    assert.equal(events.length, 3);
    assert.match(filePath, /[\\/]observability[\\/]run-events\.jsonl$/);

    const summary = summarizeRunEvents(events);
    assert.equal(summary.eventCount, 3);
    assert.equal(summary.sessionCount, 1);
    assert.equal(summary.runCount, 1);
    assert.equal(summary.eventTypeCounts.run_start, 1);
    assert.equal(summary.eventTypeCounts.usage, 1);
    assert.equal(summary.eventTypeCounts.run_stop, 1);
    assert.equal(summary.stopClassCounts.MAX_COST_EXCEEDED, 1);
    assert.equal(summary.reasonCodeCounts.MAX_COST_EXCEEDED, 1);
    assert.equal(summary.usageTotals.inputTokens, 100);
    assert.equal(summary.usageTotals.outputTokens, 40);
    assert.equal(summary.usageTotals.cacheReadTokens, 5);
    assert.equal(summary.usageTotals.cacheWriteTokens, 2);
    assert.equal(summary.usageTotals.costUsd, 0.025);
    assert.equal(summary.usageTotals.durationMs, 1500);
    assert.equal(summary.usageTotals.toolCalls, 3);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit telemetry: stop-class mapping remains deterministic", () => {
  assert.equal(mapBudgetReasonToStopClass("MAX_COST_EXCEEDED"), "MAX_COST_EXCEEDED");
  assert.equal(
    mapBudgetReasonToStopClass("MAX_OUTPUT_TOKENS_EXCEEDED"),
    "MAX_OUTPUT_TOKENS_EXCEEDED"
  );
  assert.equal(mapBudgetReasonToStopClass("DIMINISHING_RETURNS"), "DIMINISHING_RETURNS");
  assert.equal(mapBudgetReasonToStopClass("unexpected_reason"), "UNKNOWN");

  assert.equal(
    deriveStopClassFromBudget({
      reasons: [{ code: "MAX_COST_EXCEEDED" }],
    }),
    "MAX_COST_EXCEEDED"
  );
  assert.equal(
    deriveStopClassFromBudget({
      reasons: [{ code: "random_failure_code" }],
    }),
    "UNKNOWN"
  );
  assert.equal(deriveStopClassFromBudget({ reasons: [] }), "NONE");
  assert.equal(deriveStopClassFromBudget({}), "NONE");
});

test("Unit telemetry: run-event normalization rejects unsupported contracts", () => {
  assert.throws(
    () =>
      normalizeRunEvent({
        eventType: "unsupported",
      }),
    /Unsupported event type/
  );

  assert.throws(
    () =>
      normalizeRunEvent({
        eventType: "run_stop",
        stop: {
          stopClass: "not_a_stop_class",
        },
      }),
    /Unsupported stop class/
  );

  assert.throws(
    () =>
      normalizeRunEvent({
        eventType: "usage",
        usage: {
          inputTokens: -1,
        },
      }),
    /usage\.inputTokens must be a non-negative number/
  );
});

