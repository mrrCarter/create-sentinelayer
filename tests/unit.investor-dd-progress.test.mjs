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
          ledgerEntry: { ledgerEntryId: "bill_file" },
        },
      ],
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
});
