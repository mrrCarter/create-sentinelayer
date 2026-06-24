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

function nonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function roundedMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}

function usageLedgerKey(entry) {
  return [
    entry?.ledgerEntry?.ledgerEntryId,
    entry?.action || entry?.ledgerEntry?.action,
    entry?.agentId || entry?.ledgerEntry?.agentId,
    entry?.ledgerEntry?.idempotencyKey,
    entry?.inputTokens ?? entry?.ledgerEntry?.inputTokens,
    entry?.outputTokens ?? entry?.ledgerEntry?.outputTokens,
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

function ledgerValue(entry, key, fallback = 0) {
  if (entry && Object.prototype.hasOwnProperty.call(entry, key)) {
    return nonNegativeNumber(entry[key], fallback);
  }
  if (entry?.ledgerEntry && Object.prototype.hasOwnProperty.call(entry.ledgerEntry, key)) {
    return nonNegativeNumber(entry.ledgerEntry[key], fallback);
  }
  return fallback;
}

function ledgerString(entry, key) {
  return String(entry?.[key] || entry?.ledgerEntry?.[key] || "").trim();
}

function personaFromAgentId(agentId) {
  const normalized = String(agentId || "").trim();
  if (!normalized.startsWith("investor-dd-")) return "";
  return normalized.slice("investor-dd-".length);
}

function sumFileMetrics(files, fileMetrics = {}) {
  const seen = new Set();
  let filesWithMetrics = 0;
  let locScanned = 0;
  let bytesScanned = 0;
  let truncatedFiles = 0;
  let missingFiles = 0;
  for (const file of files || []) {
    const rel = String(file || "").trim();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const metrics = fileMetrics[rel];
    if (!metrics) continue;
    filesWithMetrics += 1;
    locScanned += nonNegativeNumber(metrics.loc, 0);
    bytesScanned += nonNegativeNumber(metrics.bytes, 0);
    if (metrics.truncated) truncatedFiles += 1;
    if (metrics.missing) missingFiles += 1;
  }
  return {
    filesWithMetrics,
    locScanned,
    bytesScanned,
    truncatedFiles,
    missingFiles,
  };
}

function countToolInvocations(record = {}) {
  return (Array.isArray(record.perFile) ? record.perFile : []).reduce(
    (count, item) => count + (Array.isArray(item.toolInvocations) ? item.toolInvocations.length : 0),
    0,
  );
}

function createUsageRecord({ personaId = "", agentId = "" } = {}) {
  const id = String(personaId || "").trim();
  const agent = String(agentId || (id ? `investor-dd-${id}` : "")).trim();
  return {
    personaId: id || null,
    agentId: agent,
    routedFiles: 0,
    visitedFiles: 0,
    skippedFiles: 0,
    filesWithMetrics: 0,
    locScanned: 0,
    bytesScanned: 0,
    truncatedFiles: 0,
    missingFiles: 0,
    durationMs: 0,
    toolCalls: 0,
    findingCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    providerCostUsd: 0,
    customerCostUsd: null,
    marginUsd: null,
    ledgerEntries: 0,
    actions: [],
  };
}

function buildUsageTelemetry({
  activePersonas = [],
  routing = {},
  byPersona = {},
  fileMetrics = {},
  sessionUsageLedgerEntries = [],
} = {}) {
  const records = new Map();
  const ensure = ({ personaId = "", agentId = "" } = {}) => {
    const key = personaId || agentId;
    if (!records.has(key)) {
      records.set(key, createUsageRecord({ personaId, agentId }));
    }
    return records.get(key);
  };

  for (const personaId of activePersonas) {
    const record = ensure({ personaId });
    const routed = Array.isArray(routing?.[personaId]) ? routing[personaId] : [];
    const personaRecord = byPersona?.[personaId] || {};
    const visited = Array.isArray(personaRecord.visited) ? personaRecord.visited : [];
    const skipped = Array.isArray(personaRecord.skipped) ? personaRecord.skipped : [];
    const filesForMetrics = visited.length > 0 ? visited : routed;
    const metrics = sumFileMetrics(filesForMetrics, fileMetrics);
    record.routedFiles = routed.length;
    record.visitedFiles = visited.length;
    record.skippedFiles = skipped.length;
    record.filesWithMetrics = metrics.filesWithMetrics;
    record.locScanned = metrics.locScanned;
    record.bytesScanned = metrics.bytesScanned;
    record.truncatedFiles = metrics.truncatedFiles;
    record.missingFiles = metrics.missingFiles;
    record.durationMs = Math.max(0, Math.floor(nonNegativeNumber(personaRecord.durationMs, 0)));
    record.toolCalls = countToolInvocations(personaRecord);
    record.findingCount = Array.isArray(personaRecord.findings) ? personaRecord.findings.length : 0;
  }

  for (const entry of sessionUsageLedgerEntries) {
    const agentId = ledgerString(entry, "agentId");
    const personaId = personaFromAgentId(agentId);
    const record = ensure({ personaId, agentId });
    const inputTokens = ledgerValue(entry, "inputTokens", 0);
    const outputTokens = ledgerValue(entry, "outputTokens", 0);
    const totalTokens = ledgerValue(entry, "totalTokens", inputTokens + outputTokens);
    const providerCost = roundedMoney(
      entry?.ledgerEntry?.providerCostUsd ?? entry?.ledgerEntry?.costUsd ?? entry?.providerCostUsd ?? entry?.costUsd,
    );
    const customerCost = roundedMoney(entry?.ledgerEntry?.customerCostUsd ?? entry?.customerCostUsd);
    record.inputTokens += inputTokens;
    record.outputTokens += outputTokens;
    record.totalTokens += totalTokens;
    if (providerCost != null) {
      record.providerCostUsd = roundedMoney(record.providerCostUsd + providerCost);
    }
    if (customerCost != null) {
      record.customerCostUsd = roundedMoney((record.customerCostUsd || 0) + customerCost);
    }
    if (record.customerCostUsd != null && record.providerCostUsd != null) {
      record.marginUsd = roundedMoney(record.customerCostUsd - record.providerCostUsd);
    }
    record.ledgerEntries += 1;
    const action = ledgerString(entry, "action");
    if (action && !record.actions.includes(action)) record.actions.push(action);
  }

  const perAgent = Array.from(records.values()).map((record) => ({
    ...record,
    providerCostUsd: roundedMoney(record.providerCostUsd) || 0,
  }));
  const hasCustomerCost = perAgent.some((record) => record.customerCostUsd != null);
  const totals = perAgent.reduce(
    (acc, record) => {
      acc.routedFiles += record.routedFiles;
      acc.visitedFiles += record.visitedFiles;
      acc.filesWithMetrics += record.filesWithMetrics;
      acc.locScanned += record.locScanned;
      acc.bytesScanned += record.bytesScanned;
      acc.durationMs += record.durationMs;
      acc.toolCalls += record.toolCalls;
      acc.findingCount += record.findingCount;
      acc.inputTokens += record.inputTokens;
      acc.outputTokens += record.outputTokens;
      acc.totalTokens += record.totalTokens;
      acc.providerCostUsd += record.providerCostUsd || 0;
      acc.customerCostUsd += record.customerCostUsd || 0;
      acc.ledgerEntries += record.ledgerEntries;
      return acc;
    },
    {
      routedFiles: 0,
      visitedFiles: 0,
      filesWithMetrics: 0,
      locScanned: 0,
      bytesScanned: 0,
      durationMs: 0,
      toolCalls: 0,
      findingCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerCostUsd: 0,
      customerCostUsd: 0,
      ledgerEntries: 0,
    },
  );
  totals.providerCostUsd = roundedMoney(totals.providerCostUsd) || 0;
  totals.customerCostUsd = hasCustomerCost ? roundedMoney(totals.customerCostUsd) : null;
  totals.marginUsd = totals.customerCostUsd != null ? roundedMoney(totals.customerCostUsd - totals.providerCostUsd) : null;

  return {
    schema: "investor_dd_usage_telemetry_v1",
    totals,
    perAgent,
  };
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
  fileMetrics = {},
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
  const usageTelemetry = buildUsageTelemetry({
    activePersonas,
    routing,
    byPersona,
    fileMetrics,
    sessionUsageLedgerEntries,
  });
  const hasSessionUsageLedger = sessionUsageLedgerEntries.length > 0;
  const hasPerAgentTelemetry = usageTelemetry.perAgent.length > 0;
  const hasLocTelemetry = usageTelemetry.totals.locScanned > 0 || usageTelemetry.totals.filesWithMetrics > 0;
  const hasRuntimeTelemetry = usageTelemetry.totals.durationMs > 0;
  const hasCustomerPricing = usageTelemetry.totals.customerCostUsd != null;
  addCapability(capabilities, {
    id: "usage_margin_telemetry",
    label: "Billing-grade per-agent usage, token, time, LOC, and margin telemetry",
    status: compactBudget || hasSessionUsageLedger || hasPerAgentTelemetry ? "partial" : dryRun ? "deferred" : "not_configured",
    evidence: compactBudget || hasSessionUsageLedger || hasPerAgentTelemetry
      ? [
          `agentUsageTelemetry=${hasPerAgentTelemetry}`,
          `perAgentUsageRecords=${usageTelemetry.perAgent.length}`,
          `locScanned=${usageTelemetry.totals.locScanned}`,
          `durationMs=${usageTelemetry.totals.durationMs}`,
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
      ...(hasSessionUsageLedger
        ? ["only optional DD planner calls are wired to billing-grade session_usage"]
        : ["billing-grade token/customer-cost telemetry is only available when session_usage ledger entries exist"]),
      ...(hasRuntimeTelemetry || dryRun ? [] : ["per-agent runtime is unavailable because no persona execution records were produced"]),
      ...(hasLocTelemetry ? [] : ["per-agent LOC is unavailable because file metrics were not collected"]),
      ...(hasCustomerPricing ? [] : ["customerCostUsd and marginUsd are unavailable until customer pricing is supplied by the session_usage ledger"]),
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
    ? ["file-metrics.json", "plan.json", "stream.ndjson", "summary.json", "report.md", "report.html"]
    : ["file-metrics.json", "plan.json", "stream.ndjson", "summary.json", "report.md", "report.html", "findings.json"];
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
    usageTelemetry,
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
      "wire billing-grade token/customer-price/margin telemetry for every Investor-DD persona",
      "require live reconciliation and report-email proof for sellable DD closeout",
    ],
  };
}
