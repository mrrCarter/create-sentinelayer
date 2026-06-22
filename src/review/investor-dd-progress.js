import { FULL_DEPTH_PERSONAS } from "./scan-modes.js";

export const INVESTOR_DD_PROGRESS_VERSION = "investor_dd_progress_v1";

export const INVESTOR_DD_EXPECTED_PERSONAS = Object.freeze([...FULL_DEPTH_PERSONAS]);

const REQUIRED_FOR_SELLABLE = Object.freeze([
  "persona_roster",
  "persona_agentic_loops",
  "senti_streaming",
  "usage_margin_telemetry",
  "live_reconciliation",
  "devtestbot_runtime",
  "report_email",
  "artifact_bundle",
]);

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function compactBudgetState(budgetState) {
  if (!budgetState || typeof budgetState !== "object") return null;
  return {
    spentUsd: Number.isFinite(budgetState.spentUsd) ? budgetState.spentUsd : 0,
    maxUsd: Number.isFinite(budgetState.maxUsd) ? budgetState.maxUsd : null,
    toolCalls: Number.isFinite(budgetState.toolCalls) ? budgetState.toolCalls : 0,
    llmCalls: Number.isFinite(budgetState.llmCalls) ? budgetState.llmCalls : 0,
  };
}

function usageLedgerKey(entry) {
  return [
    entry?.ledgerEntry?.ledgerEntryId,
    entry?.action,
    entry?.ledgerEntry?.idempotencyKey,
    entry?.inputTokens,
    entry?.outputTokens,
  ].map((value) => String(value || "")).join(":");
}

function collectSessionUsageLedgerEntries({ budgetState = null, devTestBotPhase = null, usageLedgerEntries = [] }) {
  const candidates = [
    ...(Array.isArray(usageLedgerEntries) ? usageLedgerEntries : []),
    ...(Array.isArray(budgetState?.sessionUsageLedgerEntries) ? budgetState.sessionUsageLedgerEntries : []),
    devTestBotPhase?.plan?.usageLedger,
  ].filter((entry) => entry?.ok);
  const seen = new Set();
  const entries = [];
  for (const entry of candidates) {
    const key = usageLedgerKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function byId(capabilities, id) {
  return capabilities.find((capability) => capability.id === id);
}

function addCapability(capabilities, capability) {
  capabilities.push({
    requiredForSellable: REQUIRED_FOR_SELLABLE.includes(capability.id),
    evidence: [],
    gaps: [],
    ...capability,
  });
}

function countByStatus(capabilities, status) {
  return capabilities.filter((capability) => capability.status === status).length;
}

export function summarizeInvestorDdProgress(capabilities) {
  const required = capabilities.filter((capability) => capability.requiredForSellable);
  const blockingGaps = required
    .filter((capability) => capability.status !== "complete")
    .flatMap((capability) => capability.gaps.map((gap) => ({ capabilityId: capability.id, gap })));

  return {
    total: capabilities.length,
    complete: countByStatus(capabilities, "complete"),
    partial: countByStatus(capabilities, "partial"),
    deferred: countByStatus(capabilities, "deferred"),
    notConfigured: countByStatus(capabilities, "not_configured"),
    requiredTotal: required.length,
    requiredComplete: required.filter((capability) => capability.status === "complete").length,
    blockingGapCount: blockingGaps.length,
    blockingGaps,
  };
}

export function buildInvestorDdProgress({
  runId,
  generatedAt = new Date().toISOString(),
  personas = [],
  dryRun = false,
  routing = {},
  byPersona = {},
  findings = [],
  compliance = null,
  reconciliationAvailable = false,
  liveValidator = null,
  devTestBotPhase = null,
  reportEmailConfigured = false,
  reportEmailResult = null,
  notification = null,
  artifactFiles = [],
  budgetState = null,
  usageLedgerEntries = [],
} = {}) {
  const activePersonas = uniqueStrings(personas);
  const missingPersonas = INVESTOR_DD_EXPECTED_PERSONAS.filter(
    (personaId) => !activePersonas.includes(personaId),
  );
  const extraPersonas = activePersonas.filter(
    (personaId) => !INVESTOR_DD_EXPECTED_PERSONAS.includes(personaId),
  );
  const capabilities = [];

  addCapability(capabilities, {
    id: "persona_roster",
    label: "13-persona DD roster",
    status: missingPersonas.length === 0 ? "complete" : "partial",
    evidence: [
      `activePersonas=${activePersonas.length}`,
      `expectedPersonas=${INVESTOR_DD_EXPECTED_PERSONAS.length}`,
    ],
    gaps: missingPersonas.length
      ? [`missing expected personas: ${missingPersonas.join(", ")}`]
      : [],
    metadata: { activePersonas, expectedPersonas: INVESTOR_DD_EXPECTED_PERSONAS, missingPersonas, extraPersonas },
  });

  const personaRecords = activePersonas.filter((personaId) => byPersona && byPersona[personaId]);
  const allActivePersonasRecorded =
    activePersonas.length > 0 && personaRecords.length === activePersonas.length;
  addCapability(capabilities, {
    id: "persona_agentic_loops",
    label: "Per-persona file loop execution",
    status: dryRun ? "deferred" : allActivePersonasRecorded ? "complete" : "partial",
    evidence: dryRun
      ? ["dryRun=true"]
      : [`personaRecords=${personaRecords.length}/${activePersonas.length}`],
    gaps: dryRun
      ? ["dry-run skips persona execution"]
      : allActivePersonasRecorded
        ? []
        : ["not every active persona produced a persona artifact"],
  });

  const streamPresent = artifactFiles.includes("stream.ndjson");
  addCapability(capabilities, {
    id: "senti_streaming",
    label: "Senti session streaming and progress spine",
    status: streamPresent ? "partial" : "not_configured",
    evidence: streamPresent ? ["stream.ndjson artifact present"] : [],
    gaps: [
      "orchestrator emits local NDJSON but does not record an attached Senti session id",
      "live web/session token counters are not part of the DD summary contract",
    ],
  });

  const compactBudget = compactBudgetState(budgetState);
  const sessionUsageLedgerEntries = collectSessionUsageLedgerEntries({
    budgetState,
    devTestBotPhase,
    usageLedgerEntries,
  });
  const hasSessionUsageLedger = sessionUsageLedgerEntries.length > 0;
  addCapability(capabilities, {
    id: "usage_margin_telemetry",
    label: "Billing-grade per-agent usage, token, time, LOC, and margin telemetry",
    status: compactBudget || hasSessionUsageLedger ? "partial" : dryRun ? "deferred" : "not_configured",
    evidence: compactBudget || hasSessionUsageLedger
      ? [
          ...(compactBudget
            ? [
                `localBudgetSpentUsd=${compactBudget.spentUsd}`,
                `localBudgetToolCalls=${compactBudget.toolCalls}`,
                `localBudgetLlmCalls=${compactBudget.llmCalls}`,
              ]
            : []),
          `sessionUsageLedger=${hasSessionUsageLedger}`,
          ...sessionUsageLedgerEntries.map((entry) =>
            `usageLedgerEntry=${entry.ledgerEntry?.ledgerEntryId || "recorded"}`
          ),
        ]
      : dryRun
        ? ["dryRun=true"]
        : [],
    gaps: [
      hasSessionUsageLedger
        ? "only optional DD planner calls are wired to billing-grade session_usage"
        : "budgetState is a local run governor, not the billing-grade session_usage ledger",
      "summary does not include per-agent token totals",
      "summary does not include per-agent runtime, LOC scanned, customer price, or margin",
    ],
  });

  addCapability(capabilities, {
    id: "compliance_pack",
    label: "Compliance pack dispatch",
    requiredForSellable: false,
    status: compliance ? "complete" : dryRun ? "deferred" : "not_configured",
    evidence: compliance
      ? [`totalCovered=${compliance.totalCovered || 0}`, `totalGaps=${compliance.totalGaps || 0}`]
      : dryRun
        ? ["dryRun=true"]
        : [],
    gaps: compliance ? [] : ["compliance pack did not run for this invocation"],
  });

  addCapability(capabilities, {
    id: "live_reconciliation",
    label: "Live product validation and reconciliation",
    status: reconciliationAvailable ? "complete" : liveValidator ? "partial" : "not_configured",
    evidence: reconciliationAvailable
      ? ["live-observations.json and reconciliation verdicts available"]
      : liveValidator
        ? ["liveValidator config supplied"]
        : [],
    gaps: reconciliationAvailable
      ? []
      : ["findings were not reconciled against live product observations"],
  });

  const devSkipped = Boolean(devTestBotPhase?.skipped);
  addCapability(capabilities, {
    id: "devtestbot_runtime",
    label: "devTestBot/AIdenID runtime phase",
    status: devTestBotPhase
      ? devSkipped
        ? "partial"
        : "complete"
      : dryRun
        ? "deferred"
        : "not_configured",
    evidence: devTestBotPhase
      ? [
          `skipped=${devSkipped}`,
          `findingCount=${devTestBotPhase.findingCount || 0}`,
          `artifactRoot=${devTestBotPhase.artifactRoot || ""}`,
        ]
      : dryRun
        ? ["dryRun=true"]
        : [],
    gaps: devTestBotPhase && !devSkipped
      ? []
      : ["devTestBot runtime evidence is missing or skipped for this run"],
  });

  addCapability(capabilities, {
    id: "report_email",
    label: "Investor report email delivery",
    status: reportEmailResult?.queued
      ? "complete"
      : reportEmailConfigured
        ? "partial"
        : dryRun
          ? "deferred"
          : "not_configured",
    evidence: reportEmailResult
      ? [
          `queued=${Boolean(reportEmailResult.queued)}`,
          `skipped=${Boolean(reportEmailResult.skipped)}`,
          `code=${reportEmailResult.code || ""}`,
        ]
      : dryRun
        ? ["dryRun=true"]
        : [],
    gaps: reportEmailResult?.queued
      ? []
      : ["no queued DD report email is recorded for this run"],
  });

  const artifactRequired = dryRun
    ? ["plan.json", "stream.ndjson", "summary.json", "report.md", "report.html"]
    : ["plan.json", "stream.ndjson", "summary.json", "report.md", "report.html", "findings.json"];
  const missingArtifacts = artifactRequired.filter((file) => !artifactFiles.includes(file));
  addCapability(capabilities, {
    id: "artifact_bundle",
    label: "Portable artifact bundle",
    status: missingArtifacts.length === 0 ? "complete" : "partial",
    evidence: [`artifactFiles=${artifactFiles.length}`, "manifest.json is written after progress.json"],
    gaps: missingArtifacts.map((file) => `missing artifact: ${file}`),
  });

  addCapability(capabilities, {
    id: "notification_delivery",
    label: "Dashboard/email notification delivery",
    requiredForSellable: false,
    status: notification ? "partial" : "not_configured",
    evidence: notification ? ["notification config supplied"] : [],
    gaps: notification
      ? ["notification result is not captured in summary.json/progress.json"]
      : ["notification clients were not configured for this invocation"],
  });

  const progressSummary = summarizeInvestorDdProgress(capabilities);
  const sellableReady = progressSummary.requiredComplete === progressSummary.requiredTotal;

  return {
    version: INVESTOR_DD_PROGRESS_VERSION,
    generatedAt,
    runId: runId || "",
    overallStatus: sellableReady ? "complete" : "partial",
    sellableReady,
    truthfulClaim: sellableReady ? "sellable_ready" : "not_sellable_ready",
    summary: progressSummary,
    requiredCapabilityIds: REQUIRED_FOR_SELLABLE,
    activePersonaCount: activePersonas.length,
    plannedPersonaCount: INVESTOR_DD_EXPECTED_PERSONAS.length,
    missingPersonas,
    capabilities,
    routingSummary: {
      routedPersonas: Object.keys(routing || {}).length,
      routedFiles: Object.values(routing || {}).reduce(
        (count, files) => count + (Array.isArray(files) ? files.length : 0),
        0,
      ),
    },
    findingCount: Array.isArray(findings) ? findings.length : 0,
    nextRecommendedSlices: [
      ...(byId(capabilities, "persona_roster")?.status === "complete"
        ? []
        : missingPersonas.includes("frontend")
          ? ["add the missing frontend/Jules persona to the default Investor-DD roster"]
          : ["run the full 13-persona roster before claiming sellable DD coverage"]),
      "wire Senti session id and live usage counters into Investor-DD runs",
      "add per-agent token/time/LOC/customer-price/margin telemetry",
      "require live reconciliation and report-email proof for sellable DD closeout",
    ],
  };
}
