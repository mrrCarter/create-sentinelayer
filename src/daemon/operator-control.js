import fsp from "node:fs/promises";
import path from "node:path";

import { ASSIGNMENT_STATUSES, resolveAssignmentLedgerStorage, listAssignments } from "./assignment-ledger.js";
import { DAEMON_BUDGET_LIFECYCLE_STATES, listBudgetStates } from "./budget-governor.js";
import { WORK_ITEM_STATUSES, listErrorQueue, resolveErrorDaemonStorage } from "./error-worker.js";
import { commentJiraIssue, listJiraIssues } from "./jira-lifecycle.js";

const OPERATOR_CONTROL_SCHEMA_VERSION = "1.0.0";
const QUEUE_SCHEMA_VERSION = "1.0.0";
const LEDGER_SCHEMA_VERSION = "1.0.0";

const WORK_ITEM_STATUS_SET = new Set(WORK_ITEM_STATUSES);
const ASSIGNMENT_STATUS_SET = new Set(ASSIGNMENT_STATUSES);

const ACTIVE_ASSIGNMENT_STATUSES = new Set(["CLAIMED", "IN_PROGRESS", "BLOCKED"]);

export const OPERATOR_STOP_MODES = Object.freeze(["QUARANTINE", "SQUASH"]);
export const BUDGET_HEALTH_COLORS = Object.freeze(["GREEN", "YELLOW", "RED"]);

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

function normalizeStatus(value, statusSet, fallbackStatus) {
  const normalized = normalizeString(value).toUpperCase();
  if (statusSet.has(normalized)) {
    return normalized;
  }
  return fallbackStatus;
}

function normalizeObject(value, fallbackValue = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallbackValue;
  }
  return { ...value };
}

function normalizeStatusList(statuses = [], statusSet = new Set()) {
  if (!Array.isArray(statuses)) {
    return [];
  }
  return statuses
    .map((status) => normalizeString(status).toUpperCase())
    .filter(Boolean)
    .filter((status) => statusSet.has(status));
}

function loadJsonFile(filePath, defaultFactory) {
  return fsp
    .readFile(filePath, "utf-8")
    .then((raw) => JSON.parse(raw))
    .catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return defaultFactory();
      }
      throw error;
    });
}

async function writeJsonFile(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function appendJsonLine(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

function resolveBudgetHealthColor(budgetLifecycleState = "") {
  const normalized = normalizeString(budgetLifecycleState).toUpperCase();
  if (normalized === "HARD_LIMIT_QUARANTINED" || normalized === "HARD_LIMIT_SQUASHED") {
    return "RED";
  }
  if (normalized === "WARNING_THRESHOLD") {
    return "YELLOW";
  }
  return "GREEN";
}

function deriveTimer(sessionStartedAt, sessionLastSeenAt, nowIso) {
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  const startEpoch = Date.parse(String(sessionStartedAt || ""));
  const lastSeenEpoch = Date.parse(String(sessionLastSeenAt || ""));
  return {
    sessionElapsedSeconds:
      Number.isFinite(nowEpoch) && Number.isFinite(startEpoch)
        ? Math.max(0, Math.floor((nowEpoch - startEpoch) / 1000))
        : null,
    sessionIdleSeconds:
      Number.isFinite(nowEpoch) && Number.isFinite(lastSeenEpoch)
        ? Math.max(0, Math.floor((nowEpoch - lastSeenEpoch) / 1000))
        : null,
  };
}

function createInitialControlState(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: OPERATOR_CONTROL_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    snapshotCount: 0,
    lastSnapshotAt: null,
    lastSnapshotRunId: null,
    lastSummary: {},
  };
}

function normalizeControlState(state = {}, nowIso = new Date().toISOString()) {
  return {
    schemaVersion: OPERATOR_CONTROL_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(state.generatedAt, nowIso),
    snapshotCount: Math.max(0, Math.floor(Number(state.snapshotCount || 0))),
    lastSnapshotAt: state.lastSnapshotAt ? normalizeIsoTimestamp(state.lastSnapshotAt, nowIso) : null,
    lastSnapshotRunId: normalizeString(state.lastSnapshotRunId) || null,
    lastSummary: normalizeObject(state.lastSummary),
  };
}

function createRunId(nowIso, counter) {
  const timestamp = nowIso.replace(/[:.]/g, "-");
  return `operator-snapshot-${timestamp}-${String(counter).padStart(4, "0")}`;
}

function normalizeQueue(queue = {}, nowIso = new Date().toISOString()) {
  return {
    schemaVersion: normalizeString(queue.schemaVersion) || QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(queue.generatedAt, nowIso),
    items: Array.isArray(queue.items)
      ? queue.items
          .map((item) => ({
            ...item,
            workItemId: normalizeString(item.workItemId),
            status: normalizeStatus(item.status, WORK_ITEM_STATUS_SET, "QUEUED"),
            updatedAt: normalizeIsoTimestamp(item.updatedAt, nowIso),
            metadata: normalizeObject(item.metadata),
          }))
          .filter((item) => item.workItemId)
      : [],
  };
}

function normalizeLedger(ledger = {}, nowIso = new Date().toISOString()) {
  return {
    schemaVersion: normalizeString(ledger.schemaVersion) || LEDGER_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(ledger.generatedAt, nowIso),
    assignments: Array.isArray(ledger.assignments)
      ? ledger.assignments
          .map((assignment) => ({
            ...assignment,
            workItemId: normalizeString(assignment.workItemId),
            assignedAgentIdentity: normalizeString(assignment.assignedAgentIdentity) || null,
            status: normalizeStatus(assignment.status, ASSIGNMENT_STATUS_SET, "QUEUED"),
            leasedAt: assignment.leasedAt ? normalizeIsoTimestamp(assignment.leasedAt, nowIso) : null,
            heartbeatAt: assignment.heartbeatAt
              ? normalizeIsoTimestamp(assignment.heartbeatAt, nowIso)
              : null,
            releasedAt: assignment.releasedAt ? normalizeIsoTimestamp(assignment.releasedAt, nowIso) : null,
            updatedAt: normalizeIsoTimestamp(assignment.updatedAt, nowIso),
            releaseReason: normalizeString(assignment.releaseReason) || null,
          }))
          .filter((assignment) => assignment.workItemId)
      : [],
  };
}

function buildStatusSummary(rows = []) {
  const statusCounts = {};
  const healthCounts = {
    GREEN: 0,
    YELLOW: 0,
    RED: 0,
  };
  for (const row of rows) {
    statusCounts[row.workItemStatus] = (statusCounts[row.workItemStatus] || 0) + 1;
    healthCounts[row.budgetHealthColor] = (healthCounts[row.budgetHealthColor] || 0) + 1;
  }
  return {
    statusCounts,
    healthCounts,
  };
}

function buildAgentRoster(rows = []) {
  const byAgent = new Map();
  for (const row of rows) {
    const agentIdentity = normalizeString(row.assignedAgentIdentity) || "unassigned";
    if (!byAgent.has(agentIdentity)) {
      byAgent.set(agentIdentity, {
        agentIdentity,
        workItemCount: 0,
        activeWorkItemCount: 0,
        blockedCount: 0,
        squashedCount: 0,
        budgetHealthCounts: {
          GREEN: 0,
          YELLOW: 0,
          RED: 0,
        },
        maxSessionElapsedSeconds: 0,
        latestSessionSeenAt: null,
      });
    }
    const aggregate = byAgent.get(agentIdentity);
    aggregate.workItemCount += 1;
    if (ACTIVE_ASSIGNMENT_STATUSES.has(normalizeString(row.assignmentStatus).toUpperCase())) {
      aggregate.activeWorkItemCount += 1;
    }
    if (row.workItemStatus === "BLOCKED") {
      aggregate.blockedCount += 1;
    }
    if (row.workItemStatus === "SQUASHED") {
      aggregate.squashedCount += 1;
    }
    aggregate.budgetHealthCounts[row.budgetHealthColor] =
      (aggregate.budgetHealthCounts[row.budgetHealthColor] || 0) + 1;
    const elapsed = Number(row.sessionElapsedSeconds || 0);
    if (elapsed > aggregate.maxSessionElapsedSeconds) {
      aggregate.maxSessionElapsedSeconds = elapsed;
    }
    const seenEpoch = Date.parse(String(row.sessionLastSeenAt || "")) || 0;
    const currentSeenEpoch = Date.parse(String(aggregate.latestSessionSeenAt || "")) || 0;
    if (seenEpoch > currentSeenEpoch) {
      aggregate.latestSessionSeenAt = row.sessionLastSeenAt || null;
    }
  }
  return [...byAgent.values()].sort((left, right) => {
    if (right.activeWorkItemCount !== left.activeWorkItemCount) {
      return right.activeWorkItemCount - left.activeWorkItemCount;
    }
    if (right.workItemCount !== left.workItemCount) {
      return right.workItemCount - left.workItemCount;
    }
    return left.agentIdentity.localeCompare(right.agentIdentity);
  });
}

export async function resolveOperatorControlStorage({
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
    operatorStatePath: path.join(daemonStorage.baseDir, "operator-control-state.json"),
    operatorEventsPath: path.join(daemonStorage.baseDir, "operator-events.ndjson"),
    operatorSnapshotsDir: path.join(daemonStorage.baseDir, "operator-snapshots"),
  };
}

export async function buildOperatorControlSnapshot({
  targetPath = ".",
  outputDir = "",
  statuses = [],
  agentIdentity = "",
  limit = 50,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedLimit = normalizePositiveInteger(limit, "limit", 50);
  const normalizedStatuses = normalizeStatusList(statuses, WORK_ITEM_STATUS_SET);
  const normalizedAgentIdentity = normalizeString(agentIdentity);
  const storage = await resolveOperatorControlStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const internalLimit = Math.max(200, normalizedLimit * 4);
  const [queue, assignments, jiraIssues, budgets, controlState] = await Promise.all([
    listErrorQueue({
      targetPath,
      outputDir,
      statuses: normalizedStatuses,
      limit: internalLimit,
      env,
      homeDir,
    }),
    listAssignments({
      targetPath,
      outputDir,
      includeExpired: true,
      limit: internalLimit,
      env,
      homeDir,
      nowIso: normalizedNow,
    }),
    listJiraIssues({
      targetPath,
      outputDir,
      limit: internalLimit,
      env,
      homeDir,
      nowIso: normalizedNow,
    }),
    listBudgetStates({
      targetPath,
      outputDir,
      limit: internalLimit,
      env,
      homeDir,
      nowIso: normalizedNow,
    }),
    loadJsonFile(storage.operatorStatePath, () => createInitialControlState(normalizedNow)).then((state) =>
      normalizeControlState(state, normalizedNow)
    ),
  ]);

  const assignmentByWorkItem = new Map();
  for (const assignment of assignments.assignments) {
    if (!assignmentByWorkItem.has(assignment.workItemId)) {
      assignmentByWorkItem.set(assignment.workItemId, assignment);
    }
  }
  const jiraByWorkItem = new Map();
  for (const issue of jiraIssues.issues) {
    if (!jiraByWorkItem.has(issue.workItemId)) {
      jiraByWorkItem.set(issue.workItemId, issue);
    }
  }
  const budgetByWorkItem = new Map();
  for (const record of budgets.records) {
    if (!budgetByWorkItem.has(record.workItemId)) {
      budgetByWorkItem.set(record.workItemId, record);
    }
  }

  const rows = [];
  for (const queueItem of queue.items) {
    const assignment = assignmentByWorkItem.get(queueItem.workItemId) || null;
    if (
      normalizedAgentIdentity &&
      normalizeString(assignment?.assignedAgentIdentity) !== normalizedAgentIdentity
    ) {
      continue;
    }
    const issue = jiraByWorkItem.get(queueItem.workItemId) || null;
    const budget = budgetByWorkItem.get(queueItem.workItemId) || null;
    const budgetHealthColor = resolveBudgetHealthColor(budget?.lifecycleState);
    const sessionStartedAt =
      assignment?.leasedAt ||
      assignment?.updatedAt ||
      queueItem.updatedAt ||
      queueItem.lastSeenAt ||
      queueItem.firstSeenAt;
    const sessionLastSeenAt =
      assignment?.heartbeatAt ||
      assignment?.updatedAt ||
      queueItem.updatedAt ||
      queueItem.lastSeenAt ||
      sessionStartedAt;
    const timer = deriveTimer(sessionStartedAt, sessionLastSeenAt, normalizedNow);
    rows.push({
      workItemId: queueItem.workItemId,
      severity: queueItem.severity,
      service: queueItem.service,
      endpoint: queueItem.endpoint,
      errorCode: queueItem.errorCode,
      workItemStatus: queueItem.status,
      assignedAgentIdentity: assignment?.assignedAgentIdentity || null,
      assignmentStatus: assignment?.status || "QUEUED",
      jiraIssueKey: issue?.issueKey || null,
      jiraStatus: issue?.status || null,
      budgetLifecycleState: budget?.lifecycleState || "WITHIN_BUDGET",
      budgetHealthColor,
      budgetWarnings: Array.isArray(budget?.warnings) ? budget.warnings : [],
      budgetStopReasons: Array.isArray(budget?.stopReasons) ? budget.stopReasons : [],
      sessionStartedAt: sessionStartedAt || null,
      sessionLastSeenAt: sessionLastSeenAt || null,
      sessionElapsedSeconds: timer.sessionElapsedSeconds,
      sessionIdleSeconds: timer.sessionIdleSeconds,
      updatedAt: queueItem.updatedAt,
    });
    if (rows.length >= normalizedLimit) {
      break;
    }
  }

  const statusSummary = buildStatusSummary(rows);
  const agentRoster = buildAgentRoster(rows);
  const nextSnapshotCount = controlState.snapshotCount + 1;
  const runId = createRunId(normalizedNow, nextSnapshotCount);
  const runPath = path.join(storage.operatorSnapshotsDir, `${runId}.json`);
  const snapshot = {
    schemaVersion: OPERATOR_CONTROL_SCHEMA_VERSION,
    generatedAt: normalizedNow,
    runId,
    summary: {
      totalQueueItems: queue.totalCount,
      visibleWorkItems: rows.length,
      activeAgents: agentRoster.filter((agent) => agent.activeWorkItemCount > 0).length,
      ...statusSummary,
    },
    workItems: rows,
    agentRoster,
  };
  await fsp.mkdir(storage.operatorSnapshotsDir, { recursive: true });
  await writeJsonFile(runPath, snapshot);

  const nextControlState = normalizeControlState(
    {
      ...controlState,
      generatedAt: normalizedNow,
      snapshotCount: nextSnapshotCount,
      lastSnapshotAt: normalizedNow,
      lastSnapshotRunId: runId,
      lastSummary: snapshot.summary,
    },
    normalizedNow
  );
  await Promise.all([
    writeJsonFile(storage.operatorStatePath, nextControlState),
    appendJsonLine(storage.operatorEventsPath, {
      timestamp: normalizedNow,
      eventType: "operator_snapshot",
      runId,
      totalQueueItems: queue.totalCount,
      visibleWorkItems: rows.length,
      activeAgents: snapshot.summary.activeAgents,
      statusCounts: statusSummary.statusCounts,
      healthCounts: statusSummary.healthCounts,
    }),
  ]);

  return {
    ...storage,
    runId,
    runPath,
    state: nextControlState,
    totalQueueItems: queue.totalCount,
    visibleWorkItems: rows.length,
    statusCounts: statusSummary.statusCounts,
    healthCounts: statusSummary.healthCounts,
    workItems: rows,
    agentRoster,
  };
}

export async function applyOperatorStopControl({
  targetPath = ".",
  outputDir = "",
  workItemId,
  mode = "QUARANTINE",
  reason = "",
  actor = "omar-operator",
  confirm = false,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  if (!confirm) {
    throw new Error("Operator stop requires --confirm.");
  }
  const normalizedMode = normalizeString(mode).toUpperCase();
  if (!OPERATOR_STOP_MODES.includes(normalizedMode)) {
    throw new Error(`mode must be one of: ${OPERATOR_STOP_MODES.join(", ")}.`);
  }

  const normalizedActor = normalizeString(actor) || "omar-operator";
  const normalizedReason =
    normalizeString(reason) ||
    (normalizedMode === "SQUASH"
      ? "Manual operator squash requested."
      : "Manual operator quarantine requested.");
  const targetStatus = normalizedMode === "SQUASH" ? "SQUASHED" : "BLOCKED";
  const assignmentStatus = targetStatus === "SQUASHED" ? "SQUASHED" : "BLOCKED";

  const storage = await resolveOperatorControlStorage({
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

  const [queueRaw, ledgerRaw] = await Promise.all([
    loadJsonFile(storage.queuePath, () => ({
      schemaVersion: QUEUE_SCHEMA_VERSION,
      generatedAt: normalizedNow,
      items: [],
    })),
    loadJsonFile(assignmentStorage.ledgerPath, () => ({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      generatedAt: normalizedNow,
      assignments: [],
    })),
  ]);
  const queue = normalizeQueue(queueRaw, normalizedNow);
  const ledger = normalizeLedger(ledgerRaw, normalizedNow);

  const queueIndex = queue.items.findIndex((item) => item.workItemId === normalizedWorkItemId);
  if (queueIndex < 0) {
    throw new Error(`Work item '${normalizedWorkItemId}' was not found in daemon queue.`);
  }

  const queueItem = queue.items[queueIndex];
  const operatorMetadata = {
    mode: normalizedMode,
    reason: normalizedReason,
    actor: normalizedActor,
    confirmed: true,
    appliedAt: normalizedNow,
  };
  queue.items[queueIndex] = {
    ...queueItem,
    status: targetStatus,
    updatedAt: normalizedNow,
    metadata: {
      ...normalizeObject(queueItem.metadata),
      operatorControl: operatorMetadata,
    },
  };
  queue.generatedAt = normalizedNow;

  const assignmentIndex = ledger.assignments.findIndex(
    (assignment) => assignment.workItemId === normalizedWorkItemId
  );
  let assignment = null;
  if (assignmentIndex >= 0) {
    const existing = ledger.assignments[assignmentIndex];
    assignment = {
      ...existing,
      status: assignmentStatus,
      releasedAt: normalizedNow,
      releaseReason: normalizedReason,
      updatedAt: normalizedNow,
    };
    ledger.assignments[assignmentIndex] = assignment;
  }
  ledger.generatedAt = normalizedNow;

  let jiraIssueKey = null;
  let jiraCommented = false;
  let jiraCommentWarning = null;
  try {
    const listed = await listJiraIssues({
      targetPath,
      outputDir,
      workItemId: normalizedWorkItemId,
      limit: 1,
      env,
      homeDir,
      nowIso: normalizedNow,
    });
    if (listed.issues.length > 0) {
      jiraIssueKey = listed.issues[0].issueKey;
      await commentJiraIssue({
        targetPath,
        outputDir,
        workItemId: normalizedWorkItemId,
        issueKey: jiraIssueKey,
        type: "operator_stop",
        message: `[operator-control] mode=${normalizedMode}, status=${targetStatus}, reason=${normalizedReason}`,
        actor: normalizedActor,
        env,
        homeDir,
        nowIso: normalizedNow,
      });
      jiraCommented = true;
    }
  } catch (error) {
    jiraCommentWarning = error instanceof Error ? error.message : String(error);
  }

  await Promise.all([
    writeJsonFile(storage.queuePath, queue),
    writeJsonFile(assignmentStorage.ledgerPath, ledger),
    appendJsonLine(storage.operatorEventsPath, {
      timestamp: normalizedNow,
      eventType: "operator_stop",
      workItemId: normalizedWorkItemId,
      mode: normalizedMode,
      targetStatus,
      actor: normalizedActor,
      reason: normalizedReason,
      jiraIssueKey,
      jiraCommented,
    }),
  ]);

  return {
    ...storage,
    workItemId: normalizedWorkItemId,
    mode: normalizedMode,
    targetStatus,
    actor: normalizedActor,
    reason: normalizedReason,
    queueItem: queue.items[queueIndex],
    assignment,
    jiraIssueKey,
    jiraCommented,
    jiraCommentWarning,
  };
}

export function getBudgetHealthColor(lifecycleState = "") {
  return resolveBudgetHealthColor(lifecycleState);
}

export function normalizeOperatorStopMode(mode = "") {
  const normalized = normalizeString(mode).toUpperCase();
  if (OPERATOR_STOP_MODES.includes(normalized)) {
    return normalized;
  }
  return "QUARANTINE";
}

export function normalizeBudgetLifecycleState(value = "") {
  const normalized = normalizeString(value).toUpperCase();
  if (DAEMON_BUDGET_LIFECYCLE_STATES.includes(normalized)) {
    return normalized;
  }
  return "WITHIN_BUDGET";
}
