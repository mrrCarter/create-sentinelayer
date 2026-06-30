import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionUsageReport,
  buildSessionUsageReportFromLedgerPayload,
  renderSessionUsageMarkdown,
  renderSessionUsageSummary,
} from "../src/session/usage-report.js";

test("session usage report preserves totals without leaking raw prompt, response, or idempotency secrets", () => {
  const secretIdempotencyKey = "sk-test-secret-idempotency-key-that-must-not-render";
  const rawPrompt = "PROMPT_SECRET_SHOULD_NOT_RENDER";
  const rawResponse = "RESPONSE_SECRET_SHOULD_NOT_RENDER";
  const report = buildSessionUsageReport({
    sessionId: "usage-report-session",
    events: [
      {
        event: "session_usage",
        agent: { id: "codex", model: "gpt-5" },
        payload: {
          schema: "session_usage/local-v1",
          idempotencyKey: secretIdempotencyKey,
          ledgerEntryId: "bill_safe_ledger_id",
          agentId: "codex",
          action: "session_recap",
          model: "gpt-5",
          prompt: { text: rawPrompt, tokens: 100 },
          response: { text: rawResponse, tokens: 40 },
          usage: {
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            costUsd: 0.00123,
            customerCostUsd: 0.00456,
            priceBookVersion: "pb-test",
          },
        },
        sequenceId: 10,
        timestamp: "2026-06-30T01:00:00.000Z",
      },
    ],
  });

  assert.equal(report.totals.acceptedEntries, 1);
  assert.equal(report.totals.totalTokens, 140);
  assert.equal(report.totals.providerCostUsd, 0.00123);
  assert.equal(report.totals.customerCostUsd, 0.00456);
  assert.match(report.recentEntries[0].idempotencyKeyHash, /^sha256:[0-9a-f]{16}$/);

  const rendered = [
    JSON.stringify(report),
    renderSessionUsageMarkdown(report),
    renderSessionUsageSummary(report),
  ].join("\n");
  assert.doesNotMatch(rendered, new RegExp(secretIdempotencyKey));
  assert.doesNotMatch(rendered, new RegExp(rawPrompt));
  assert.doesNotMatch(rendered, new RegExp(rawResponse));
  assert.match(rendered, /bill_safe_ledger_id/);
  assert.match(rendered, /140/);
});

test("session usage report tolerates malformed rows, dedupes retries, and bounds recent entries", () => {
  const report = buildSessionUsageReport({
    sessionId: "usage-report-malformed",
    recentLimit: 0,
    events: [
      null,
      { event: "session_usage", payload: "not-an-object" },
      {
        event: "session_usage",
        payload: {
          schema: "billing/v2",
          usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998, costUsd: 99 },
        },
      },
      {
        event: "session_usage",
        payload: {
          schema: "billing/v1",
          idempotencyKey: "retry-key",
          ledgerEntryId: "bill_retry_key",
          agentId: "codex",
          action: "session_recap",
          model: "gpt-5",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
        },
        sequenceId: 1,
        timestamp: "not-a-date",
      },
      {
        event: "session_usage",
        payload: {
          schema: "billing/v1",
          idempotencyKey: "retry-key",
          ledgerEntryId: "bill_retry_key",
          agentId: "codex",
          action: "session_recap",
          model: "gpt-5",
          usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998, costUsd: 99 },
        },
        sequenceId: 2,
      },
    ],
  });

  assert.equal(report.totals.acceptedEntries, 1);
  assert.equal(report.totals.duplicatesSkipped, 1);
  assert.equal(report.totals.totalTokens, 15);
  assert.equal(report.recentEntries.length, 0);
  assert.doesNotThrow(() => renderSessionUsageMarkdown(report));
  assert.doesNotThrow(() => renderSessionUsageSummary(report));
});

test("session usage report normalizes hosted ledger payloads without raw idempotency keys", () => {
  const rawIdempotencyKey = "sk-hosted-usage-idempotency-secret";
  const report = buildSessionUsageReportFromLedgerPayload({
    sessionId: "fallback-session",
    recentLimit: 10,
    payload: {
      sessionId: "hosted-session",
      usageLedger: {
        totals: {
          entries: 1,
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
          providerCostUsd: 0.001,
          customerCostUsd: 0.002,
          hasCustomerCost: true,
          unpriced: 0,
        },
        priceBooks: ["2026-05-19"],
        duplicatesSkipped: 2,
        agents: [
          {
            label: "codex",
            entries: 1,
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            providerCostUsd: 0.001,
            customerCostUsd: 0.002,
            hasCustomerCost: true,
          },
        ],
        actions: [
          {
            label: "session_recap",
            entries: 1,
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            providerCostUsd: 0.001,
          },
        ],
        entries: [
          {
            timestamp: "2026-06-30T01:00:00.000Z",
            sequence: 7,
            ledgerEntryId: "bill_hosted_safe",
            idempotencyKey: rawIdempotencyKey,
            schema: "billing/v1",
            agentId: "codex",
            action: "session_recap",
            model: "gpt-5",
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            providerCostUsd: 0.001,
            customerCostUsd: 0.002,
          },
        ],
      },
    },
  });

  assert.equal(report.sessionId, "hosted-session");
  assert.equal(report.totals.acceptedEntries, 1);
  assert.equal(report.totals.duplicatesSkipped, 2);
  assert.equal(report.totals.totalTokens, 15);
  assert.equal(report.perAgent[0].label, "codex");
  assert.equal(report.perAction[0].label, "session_recap");
  assert.equal(report.recentEntries[0].ledgerEntryId, "bill_hosted_safe");
  assert.match(report.recentEntries[0].idempotencyKeyHash, /^sha256:[0-9a-f]{16}$/);

  const rendered = JSON.stringify(report);
  assert.doesNotMatch(rendered, new RegExp(rawIdempotencyKey));
});

test("session usage report accepts hosted byAgent and byAction rollup aliases", () => {
  const report = buildSessionUsageReportFromLedgerPayload({
    sessionId: "hosted-by-rollup-session",
    payload: {
      sessionId: "hosted-by-rollup-session",
      totals: {
        entries: 2,
        inputTokens: 300,
        outputTokens: 125,
        totalTokens: 425,
        providerCostUsd: 0.00425,
      },
      byAgent: [
        {
          agentId: "omargate-testing",
          count: 1,
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
          providerCostUsd: 0.00125,
        },
        {
          agentId: "omargate-backend",
          count: 1,
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          providerCostUsd: 0.003,
        },
      ],
      byAction: [
        {
          action: "omargate_deep",
          count: 2,
          inputTokens: 300,
          outputTokens: 125,
          totalTokens: 425,
          providerCostUsd: 0.00425,
        },
      ],
      entries: [
        {
          timestamp: "2026-06-30T07:00:00.000Z",
          ledgerEntryId: "bill_remote_alias",
          idempotencyKey: "remote-alias-key",
          agentId: "omargate-backend",
          action: "omargate_deep",
          model: "gpt-5.3-codex",
          priceBookVersion: "2026-05-19",
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          providerCostUsd: 0.003,
        },
      ],
    },
  });

  assert.equal(report.totals.acceptedEntries, 2);
  assert.deepEqual(report.totals.priceBookVersions, ["2026-05-19"]);
  assert.deepEqual(
    report.perAgent.map((entry) => entry.label),
    ["omargate-backend", "omargate-testing"],
  );
  assert.equal(report.perAgent[0].totalTokens, 300);
  assert.equal(report.perAction[0].label, "omargate_deep");
  assert.equal(report.perAction[0].entries, 2);
  assert.match(renderSessionUsageSummary(report), /Per agent:/);
});
