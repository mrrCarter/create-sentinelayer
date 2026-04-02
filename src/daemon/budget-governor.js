import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAssignmentLedgerStorage } from "./assignment-ledger.js";
import { resolveErrorDaemonStorage } from "./error-worker.js";

const BUDGET_STATE_SCHEMA_VERSION = "1.0.0";
const QUEUE_SCHEMA_VERSION = "1.0.0";

export const DAEMON_BUDGET_LIFECYCLE_STATES = Object.freeze([
  "WITHIN_BUDGET",
  "WARNING_THRESHOLD",
  "HARD_LIMIT_QUARANTINED",
  "HARD_LIMIT_SQUASHED",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeIsoTimestamp(value, fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallbackIso;
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    return fallbackIso;
  }
  return new Date(epoch).toISOString();
}

function normalizeNonNegativeNumber(value, fieldName) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }
  return normalized;
}

function normalizePositiveInteger(value, fieldName, fallbackValue) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return Math.floor(normalized);
}

function normalizeWarningThresholdPercent(value, fallbackValue = 80) {
  const normalized = Number(value ?? fallbackValue);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error("warningThresholdPercent must be between 0 and 100.");
  }
  return normalized;
}

function normalizeBudgetEnvelope(envelope = {}) {
  return {
    maxTokens: normalizeNonNegativeNumber(envelope.maxTokens ?? 0, "maxTokens"),
    maxCostUsd: normalizeNonNegativeNumber(envelope.maxCostUsd ?? 0, "maxCostUsd"),
    maxRuntimeMs: normalizeNonNegativeNumber(envelope.maxRuntimeMs ?? 0, "maxRuntimeMs"),
    maxToolCalls: normalizeNonNegativeNumber(envelope.maxToolCalls ?? 0, "maxToolCalls"),
    maxPathViolations: normalizePositiveInteger(
      envelope.maxPathViolations ?? 1,
      "maxPathViolations",
      1
    ),
    maxNetworkViolations: normalizePositiveInteger(
      envelope.maxNetworkViolations ?? 1,
      "maxNetworkViolations",
      1
    ),
    warningThresholdPercent: normalizeWarningThresholdPercent(
      envelope.warningThresholdPercent,
      80
    ),
    quarantineGraceSeconds: normalizePositiveInteger(
      envelope.quarantineGraceSeconds ?? 30,
      "quarantineGraceSeconds",
      30
    ),
  };
}

function normalizeUsageSnapshot(usage = {}) {
  return {
    tokensUsed: normalizeNonNegativeNumber(usage.tokensUsed ?? 0, "tokensUsed"),
    costUsd: normalizeNonNegativeNumber(usage.costUsd ?? 0, "costUsd"),
    runtimeMs: normalizeNonNegativeNumber(usage.runtimeMs ?? 0, "runtimeMs"),
    toolCalls: normalizeNonNegativeNumber(usage.toolCalls ?? 0, "toolCalls"),
    pathOutOfScopeHits: normalizeNonNegativeNumber(
      usage.pathOutOfScopeHits ?? 0,
      "pathOutOfScopeHits"
    ),
    networkDomainViolations: normalizeNonNegativeNumber(
      usage.networkDomainViolations ?? 0,
      "networkDomainViolations"
    ),
  };
}

function evaluateThreshold({
  usageValue,
  maxValue,
  warningThresholdPercent,
  stopCode,
  warningCode,
  stopMessage,
  warningMessage,
  warnings,
  stopReasons,
} = {}) {
  const usage = Number(usageValue || 0);
  const limit = Number(maxValue || 0);
  if (!Number.isFinite(limit) || limit <= 0) {
    return;
  }
  if (usage > limit) {
    stopReasons.push({
      code: stopCode,
      message: stopMessage(usage, limit),
    });
    return;
  }
  if (warningThresholdPercent <= 0) {
    return;
  }
  const threshold = (warningThresholdPercent / 100) * limit;
  if (usage >= threshold) {
    warnings.push({
      code: warningCode,
      message: warningMessage(usage, limit, warningThresholdPercent),
    });
  }
}

function addSeconds(isoTimestamp, seconds) {
  const baseEpoch = Date.parse(isoTimestamp) || Date.now();
  return new Date(baseEpoch + seconds * 1000).toISOString();
}

function createInitialBudgetState(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: BUDGET_STATE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    records: [],
  };
}

function normalizeBudgetRecord(record = {}, nowIso = new Date().toISOString()) {
  return {
    workItemId: normalizeString(record.workItemId),
    lifecycleState: normalizeString(record.lifecycleState) || "WITHIN_BUDGET",
    lastAction: normalizeString(record.lastAction) || "NONE",
    updatedAt: normalizeIsoTimestamp(record.updatedAt, nowIso),
    quarantineStartedAt: record.quarantineStartedAt
      ? normalizeIsoTimestamp(record.quarantineStartedAt, nowIso)
      : null,
    quarantineUntil: record.quarantineUntil ? normalizeIsoTimestamp(record.quarantineUntil, nowIso) : null,
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
    stopReasons: Array.isArray(record.stopReasons) ? record.stopReasons : [],
    budget: record.budget && typeof record.budget === "object" ? record.budget : {},
    usage: record.usage && typeof record.usage === "object" ? record.usage : {},
  };
}

async function loadJsonFile(filePath, defaultFactory) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return defaultFactory();
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function appendEvent(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

async function loadQueue(queuePath, nowIso = new Date().toISOString()) {
  const parsed = await loadJsonFile(queuePath, () => ({
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt: nowIso,
    items: [],
  }));
  return {
    schemaVersion: normalizeString(parsed.schemaVersion) || QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(parsed.generatedAt, nowIso),
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

async function writeQueue(queuePath, queue = {}, nowIso = new Date().toISOString()) {
  await writeJsonFile(queuePath, {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    items: Array.isArray(queue.items) ? queue.items : [],
  });
}

async function loadAssignmentLedger(ledgerPath, nowIso = new Date().toISOString()) {
  return loadJsonFile(ledgerPath, () => ({
    schemaVersion: "1.0.0",
    generatedAt: nowIso,
    assignments: [],
  }));
}

async function writeAssignmentLedger(ledgerPath, ledger = {}, nowIso = new Date().toISOString()) {
  await writeJsonFile(ledgerPath, {
    ...ledger,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    assignments: Array.isArray(ledger.assignments) ? ledger.assignments : [],
  });
}

export function evaluateDaemonBudget({
  budget = {},
  usage = {},
  previousRecord = null,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedBudget = normalizeBudgetEnvelope(budget);
  const normalizedUsage = normalizeUsageSnapshot(usage);

  const warnings = [];
  const stopReasons = [];
  evaluateThreshold({
    usageValue: normalizedUsage.tokensUsed,
    maxValue: normalizedBudget.maxTokens,
    warningThresholdPercent: normalizedBudget.warningThresholdPercent,
    stopCode: "MAX_TOKENS_EXCEEDED",
    warningCode: "TOKENS_NEAR_LIMIT",
    stopMessage: (used, limit) => `Token budget exceeded (${used} > ${limit}).`,
    warningMessage: (used, limit, threshold) =>
      `Token usage near limit (${used}/${limit} at ${threshold}%).`,
    warnings,
    stopReasons,
  });
  evaluateThreshold({
    usageValue: normalizedUsage.costUsd,
    maxValue: normalizedBudget.maxCostUsd,
    warningThresholdPercent: normalizedBudget.warningThresholdPercent,
    stopCode: "MAX_COST_USD_EXCEEDED",
    warningCode: "COST_NEAR_LIMIT",
    stopMessage: (used, limit) => `Cost budget exceeded (${used.toFixed(6)} > ${limit.toFixed(6)}).`,
    warningMessage: (used, limit, threshold) =>
      `Cost usage near limit (${used.toFixed(6)}/${limit.toFixed(6)} at ${threshold}%).`,
    warnings,
    stopReasons,
  });
  evaluateThreshold({
    usageValue: normalizedUsage.runtimeMs,
    maxValue: normalizedBudget.maxRuntimeMs,
    warningThresholdPercent: normalizedBudget.warningThresholdPercent,
    stopCode: "MAX_RUNTIME_MS_EXCEEDED",
    warningCode: "RUNTIME_MS_NEAR_LIMIT",
    stopMessage: (used, limit) => `Runtime budget exceeded (${Math.round(used)} > ${Math.round(limit)}).`,
    warningMessage: (used, limit, threshold) =>
      `Runtime usage near limit (${Math.round(used)}/${Math.round(limit)} at ${threshold}%).`,
    warnings,
    stopReasons,
  });
  evaluateThreshold({
    usageValue: normalizedUsage.toolCalls,
    maxValue: normalizedBudget.maxToolCalls,
    warningThresholdPercent: normalizedBudget.warningThresholdPercent,
    stopCode: "MAX_TOOL_CALLS_EXCEEDED",
    warningCode: "TOOL_CALLS_NEAR_LIMIT",
    stopMessage: (used, limit) => `Tool-call budget exceeded (${Math.round(used)} > ${Math.round(limit)}).`,
    warningMessage: (used, limit, threshold) =>
      `Tool-call usage near limit (${Math.round(used)}/${Math.round(limit)} at ${threshold}%).`,
    warnings,
    stopReasons,
  });
  evaluateThreshold({
    usageValue: normalizedUsage.pathOutOfScopeHits,
    maxValue: normalizedBudget.maxPathViolations,
    warningThresholdPercent: normalizedBudget.warningThresholdPercent,
    stopCode: "MAX_PATH_VIOLATIONS_EXCEEDED",
    warningCode: "PATH_VIOLATIONS_NEAR_LIMIT",
    stopMessage: (used, limit) =>
      `Path-scope violation budget exceeded (${Math.round(used)} > ${Math.round(limit)}).`,
    warningMessage: (used, limit, threshold) =>
      `Path-scope violations near limit (${Math.round(used)}/${Math.round(limit)} at ${threshold}%).`,
    warnings,
    stopReasons,
  });
  evaluateThreshold({
    usageValue: normalizedUsage.networkDomainViolations,
    maxValue: normalizedBudget.maxNetworkViolations,
    warningThresholdPercent: normalizedBudget.warningThresholdPercent,
    stopCode: "MAX_NETWORK_VIOLATIONS_EXCEEDED",
    warningCode: "NETWORK_VIOLATIONS_NEAR_LIMIT",
    stopMessage: (used, limit) =>
      `Network-domain violation budget exceeded (${Math.round(used)} > ${Math.round(limit)}).`,
    warningMessage: (used, limit, threshold) =>
      `Network-domain violations near limit (${Math.round(used)}/${Math.round(limit)} at ${threshold}%).`,
    warnings,
    stopReasons,
  });

  let lifecycleState = "WITHIN_BUDGET";
  let action = "NONE";
  let quarantineStartedAt = previousRecord?.quarantineStartedAt || null;
  let quarantineUntil = previousRecord?.quarantineUntil || null;

  if (stopReasons.length > 0) {
    lifecycleState = "HARD_LIMIT_QUARANTINED";
    if (!quarantineStartedAt || !quarantineUntil) {
      quarantineStartedAt = normalizedNow;
      quarantineUntil = addSeconds(normalizedNow, normalizedBudget.quarantineGraceSeconds);
      action = "QUARANTINE";
    } else {
      const nowEpoch = Date.parse(normalizedNow);
      const quarantineUntilEpoch = Date.parse(quarantineUntil);
      if (Number.isFinite(quarantineUntilEpoch) && nowEpoch >= quarantineUntilEpoch) {
        lifecycleState = "HARD_LIMIT_SQUASHED";
        action = "KILL";
      } else {
        action = "QUARANTINE";
      }
    }
  } else if (warnings.length > 0) {
    lifecycleState = "WARNING_THRESHOLD";
    action = "NONE";
    quarantineStartedAt = null;
    quarantineUntil = null;
  } else {
    lifecycleState = "WITHIN_BUDGET";
    action = "NONE";
    quarantineStartedAt = null;
    quarantineUntil = null;
  }

  return {
    lifecycleState,
    action,
    updatedAt: normalizedNow,
    quarantineStartedAt,
    quarantineUntil,
    warnings,
    stopReasons,
    budget: normalizedBudget,
    usage: normalizedUsage,
  };
}

export async function resolveBudgetGovernorStorage({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const daemonStorage = await resolveErrorDaemonStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  return {
    ...daemonStorage,
    budgetStatePath: path.join(daemonStorage.baseDir, "budget-state.json"),
    budgetEventsPath: path.join(daemonStorage.baseDir, "budget-events.ndjson"),
    budgetRunsDir: path.join(daemonStorage.baseDir, "budget-runs"),
  };
}

async function loadBudgetState(filePath, nowIso = new Date().toISOString()) {
  const parsed = await loadJsonFile(filePath, () => createInitialBudgetState(nowIso));
  return {
    schemaVersion: normalizeString(parsed.schemaVersion) || BUDGET_STATE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(parsed.generatedAt, nowIso),
    records: Array.isArray(parsed.records)
      ? parsed.records
          .map((record) => normalizeBudgetRecord(record, nowIso))
          .filter((record) => record.workItemId)
      : [],
  };
}

async function writeBudgetState(filePath, state = {}, nowIso = new Date().toISOString()) {
  const normalized = {
    schemaVersion: BUDGET_STATE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    records: Array.isArray(state.records)
      ? state.records
          .map((record) => normalizeBudgetRecord(record, nowIso))
          .filter((record) => record.workItemId)
      : [],
  };
  await writeJsonFile(filePath, normalized);
  return normalized;
}

function applyQueueAndAssignmentStatus({
  queue,
  assignmentLedger,
  workItemId,
  status,
  reason,
  nowIso,
} = {}) {
  const queueIndex = queue.items.findIndex((item) => normalizeString(item.workItemId) === workItemId);
  if (queueIndex >= 0) {
    queue.items[queueIndex] = {
      ...queue.items[queueIndex],
      status,
      updatedAt: nowIso,
      metadata: {
        ...(queue.items[queueIndex].metadata && typeof queue.items[queueIndex].metadata === "object"
          ? queue.items[queueIndex].metadata
          : {}),
        budgetGovernorStatus: status,
        budgetGovernorReason: reason || null,
      },
    };
  }

  if (assignmentLedger && Array.isArray(assignmentLedger.assignments)) {
    const assignmentIndex = assignmentLedger.assignments.findIndex(
      (assignment) => normalizeString(assignment.workItemId) === workItemId
    );
    if (assignmentIndex >= 0) {
      assignmentLedger.assignments[assignmentIndex] = {
        ...assignmentLedger.assignments[assignmentIndex],
        status,
        releasedAt: nowIso,
        releaseReason: reason || assignmentLedger.assignments[assignmentIndex].releaseReason || null,
        updatedAt: nowIso,
      };
    }
  }
}

export async function applyDaemonBudgetCheck({
  targetPath = ".",
  outputDir = "",
  workItemId,
  budget = {},
  usage = {},
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const storage = await resolveBudgetGovernorStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const assignmentStorage = await resolveAssignmentLedgerStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const [budgetState, queue, assignmentLedger] = await Promise.all([
    loadBudgetState(storage.budgetStatePath, normalizedNow),
    loadQueue(storage.queuePath, normalizedNow),
    loadAssignmentLedger(assignmentStorage.ledgerPath, normalizedNow),
  ]);

  const queueItem = queue.items.find((item) => normalizeString(item.workItemId) === normalizedWorkItemId);
  if (!queueItem) {
    throw new Error(`Work item '${normalizedWorkItemId}' was not found in daemon queue.`);
  }

  const recordIndex = budgetState.records.findIndex((record) => record.workItemId === normalizedWorkItemId);
  const previousRecord = recordIndex >= 0 ? budgetState.records[recordIndex] : null;
  const evaluation = evaluateDaemonBudget({
    budget,
    usage,
    previousRecord,
    nowIso: normalizedNow,
  });
  const nextRecord = normalizeBudgetRecord(
    {
      workItemId: normalizedWorkItemId,
      ...evaluation,
      lastAction: evaluation.action,
      updatedAt: normalizedNow,
    },
    normalizedNow
  );
  if (recordIndex >= 0) {
    budgetState.records[recordIndex] = nextRecord;
  } else {
    budgetState.records.push(nextRecord);
  }

  if (evaluation.action === "QUARANTINE") {
    applyQueueAndAssignmentStatus({
      queue,
      assignmentLedger,
      workItemId: normalizedWorkItemId,
      status: "BLOCKED",
      reason: "Budget hard limit reached; work item quarantined pending grace window.",
      nowIso: normalizedNow,
    });
  }
  if (evaluation.action === "KILL") {
    applyQueueAndAssignmentStatus({
      queue,
      assignmentLedger,
      workItemId: normalizedWorkItemId,
      status: "SQUASHED",
      reason: "Budget hard limit persisted past grace window; deterministic squash triggered.",
      nowIso: normalizedNow,
    });
  }

  const [savedState] = await Promise.all([
    writeBudgetState(storage.budgetStatePath, budgetState, normalizedNow),
    writeQueue(storage.queuePath, queue, normalizedNow),
    writeAssignmentLedger(assignmentStorage.ledgerPath, assignmentLedger, normalizedNow),
  ]);

  await appendEvent(storage.budgetEventsPath, {
    timestamp: normalizedNow,
    eventType: "budget_check",
    workItemId: normalizedWorkItemId,
    lifecycleState: evaluation.lifecycleState,
    action: evaluation.action,
    warningCodes: evaluation.warnings.map((item) => item.code),
    stopCodes: evaluation.stopReasons.map((item) => item.code),
    quarantineUntil: evaluation.quarantineUntil,
  });

  await fsp.mkdir(storage.budgetRunsDir, { recursive: true });
  const runId = `budget-check-${normalizedNow.replace(/[:.]/g, "-")}-${String(
    budgetState.records.length
  ).padStart(4, "0")}`;
  const runPath = path.join(storage.budgetRunsDir, `${runId}.json`);
  await writeJsonFile(runPath, {
    generatedAt: normalizedNow,
    runId,
    workItemId: normalizedWorkItemId,
    lifecycleState: evaluation.lifecycleState,
    action: evaluation.action,
    warnings: evaluation.warnings,
    stopReasons: evaluation.stopReasons,
    budget: evaluation.budget,
    usage: evaluation.usage,
    quarantineStartedAt: evaluation.quarantineStartedAt,
    quarantineUntil: evaluation.quarantineUntil,
  });

  return {
    ...storage,
    runId,
    runPath,
    record: nextRecord,
    lifecycleState: evaluation.lifecycleState,
    action: evaluation.action,
    warnings: evaluation.warnings,
    stopReasons: evaluation.stopReasons,
    budget: evaluation.budget,
    usage: evaluation.usage,
    quarantineStartedAt: evaluation.quarantineStartedAt,
    quarantineUntil: evaluation.quarantineUntil,
    state: savedState,
  };
}

export async function listBudgetStates({
  targetPath = ".",
  outputDir = "",
  workItemId = "",
  lifecycleStates = [],
  limit = 50,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedLimit = Math.max(1, Math.floor(Number(limit || 50)));
  const normalizedWorkItemId = normalizeString(workItemId);
  const normalizedLifecycleStates = new Set(
    (Array.isArray(lifecycleStates) ? lifecycleStates : [])
      .map((item) => normalizeString(item).toUpperCase())
      .filter((item) => DAEMON_BUDGET_LIFECYCLE_STATES.includes(item))
  );
  const storage = await resolveBudgetGovernorStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const state = await loadBudgetState(storage.budgetStatePath, normalizedNow);
  const records = state.records
    .filter((record) => {
      if (normalizedWorkItemId && record.workItemId !== normalizedWorkItemId) {
        return false;
      }
      if (
        normalizedLifecycleStates.size > 0 &&
        !normalizedLifecycleStates.has(normalizeString(record.lifecycleState).toUpperCase())
      ) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const leftEpoch = Date.parse(String(left.updatedAt || "")) || 0;
      const rightEpoch = Date.parse(String(right.updatedAt || "")) || 0;
      return rightEpoch - leftEpoch;
    });
  return {
    ...storage,
    totalCount: state.records.length,
    visibleCount: records.length,
    records: records.slice(0, normalizedLimit),
  };
}
