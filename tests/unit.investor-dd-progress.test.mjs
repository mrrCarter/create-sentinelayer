import test from "node:test";
import assert from "node:assert/strict";

import { buildInvestorDdProgress } from "../src/review/investor-dd-progress.js";

test("buildInvestorDdProgress includes file-loop session usage ledger evidence", () => {
  const progress = buildInvestorDdProgress({
    runId: "investor-dd-test",
    generatedAt: "2026-05-24T00:00:00.000Z",
    personas: ["security"],
    routing: { security: ["src/app.js"] },
    byPersona: {
      security: {
        visited: ["src/app.js"],
        findings: [],
      },
    },
    artifactFiles: ["stream.ndjson"],
    budgetState: {
      spentUsd: 0,
      maxUsd: 10,
      toolCalls: 0,
      llmCalls: 1,
      sessionUsageLedgerEntries: [
        {
          ok: true,
          action: "investor_dd_file_planner",
          inputTokens: 25,
          outputTokens: 7,
          ledgerEntry: {
            ledgerEntryId: "bill_file",
            agentId: "investor-dd-security",
            action: "investor_dd_file_planner",
            totalTokens: 32,
            providerCostUsd: 0.001,
            customerCostUsd: 0.005,
          },
        },
      ],
    },
    fileMetrics: {
      "src/app.js": { bytes: 120, loc: 10 },
    },
  });

  const usageCapability = progress.capabilities.find(
    (capability) => capability.id === "usage_margin_telemetry",
  );
  assert.equal(usageCapability.status, "partial");
  assert.equal(usageCapability.evidence.includes("sessionUsageLedger=true"), true);
  assert.equal(usageCapability.evidence.includes("usageLedgerEntry=bill_file"), true);
  assert.equal(
    usageCapability.gaps.includes("budgetState is a local run governor, not the billing-grade session_usage ledger"),
    false,
  );
  assert.equal(usageCapability.evidence.includes("agentUsageTelemetry=true"), true);
  assert.equal(usageCapability.evidence.includes("perAgentUsageRecords=1"), true);
  assert.equal(usageCapability.evidence.includes("locScanned=10"), true);
  assert.equal(
    usageCapability.gaps.includes("customerCostUsd and marginUsd are unavailable until customer pricing is supplied by the session_usage ledger"),
    false,
  );

  assert.equal(progress.usageTelemetry.schema, "investor_dd_usage_telemetry_v1");
  assert.equal(progress.usageTelemetry.totals.locScanned, 10);
  assert.equal(progress.usageTelemetry.totals.bytesScanned, 120);
  assert.equal(progress.usageTelemetry.totals.inputTokens, 25);
  assert.equal(progress.usageTelemetry.totals.outputTokens, 7);
  assert.equal(progress.usageTelemetry.totals.totalTokens, 32);
  assert.equal(progress.usageTelemetry.totals.providerCostUsd, 0.001);
  assert.equal(progress.usageTelemetry.totals.customerCostUsd, 0.005);
  assert.equal(progress.usageTelemetry.totals.marginUsd, 0.004);

  const security = progress.usageTelemetry.perAgent.find((entry) => entry.personaId === "security");
  assert.ok(security);
  assert.equal(security.agentId, "investor-dd-security");
  assert.equal(security.routedFiles, 1);
  assert.equal(security.visitedFiles, 1);
  assert.equal(security.filesWithMetrics, 1);
  assert.equal(security.locScanned, 10);
  assert.equal(security.inputTokens, 25);
  assert.equal(security.ledgerEntries, 1);
  assert.deepEqual(security.actions, ["investor_dd_file_planner"]);
});

test("buildInvestorDdProgress exposes deterministic dry-run file metrics without estimating tokens", () => {
  const progress = buildInvestorDdProgress({
    runId: "investor-dd-dry-run",
    generatedAt: "2026-05-24T00:00:00.000Z",
    dryRun: true,
    personas: ["security"],
    routing: { security: ["src/app.js"] },
    byPersona: {},
    artifactFiles: ["file-metrics.json", "plan.json", "stream.ndjson", "summary.json", "report.md", "report.html"],
    fileMetrics: {
      "src/app.js": { bytes: 42, loc: 3 },
    },
  });

  const usageCapability = progress.capabilities.find(
    (capability) => capability.id === "usage_margin_telemetry",
  );
  assert.equal(usageCapability.status, "partial");
  assert.equal(usageCapability.evidence.includes("agentUsageTelemetry=true"), true);
  assert.equal(usageCapability.evidence.includes("sessionUsageLedger=false"), true);
  assert.equal(
    usageCapability.gaps.includes("billing-grade token/customer-cost telemetry is only available when session_usage ledger entries exist"),
    true,
  );
  assert.equal(
    usageCapability.gaps.includes("per-agent runtime is unavailable because no persona execution records were produced"),
    false,
  );

  assert.equal(progress.usageTelemetry.totals.locScanned, 3);
  assert.equal(progress.usageTelemetry.totals.totalTokens, 0);
  assert.equal(progress.usageTelemetry.totals.providerCostUsd, 0);
  assert.equal(progress.usageTelemetry.totals.customerCostUsd, null);
  const security = progress.usageTelemetry.perAgent.find((entry) => entry.personaId === "security");
  assert.ok(security);
  assert.equal(security.routedFiles, 1);
  assert.equal(security.visitedFiles, 0);
  assert.equal(security.locScanned, 3);
  assert.equal(security.ledgerEntries, 0);
});
