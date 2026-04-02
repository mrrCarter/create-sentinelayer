import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { WORK_ITEM_STATUSES, resolveErrorDaemonStorage } from "./error-worker.js";

const LEDGER_SCHEMA_VERSION = "1.0.0";
const QUEUE_SCHEMA_VERSION = "1.0.0";
const FILE_LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const FILE_LOCK_RETRY_DELAY_MS = 50;
const FILE_LOCK_STALE_WINDOW_MS = 5 * 60 * 1000;

export const ASSIGNMENT_STATUSES = Object.freeze([
  "QUEUED",
  "CLAIMED",
  "IN_PROGRESS",
  "RELEASED",
  "DONE",
  "BLOCKED",
  "SQUASHED",
]);

const ASSIGNMENT_STATUS_SET = new Set(ASSIGNMENT_STATUSES);
const WORK_ITEM_STATUS_SET = new Set(WORK_ITEM_STATUSES);
const ACTIVE_ASSIGNMENT_STATUSES = new Set(["CLAIMED", "IN_PROGRESS"]);
const RELEASE_TARGET_STATUSES = new Set(["QUEUED", "DONE", "BLOCKED", "SQUASHED"]);

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

function normalizePositiveInteger(value, fallbackValue = 1) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Value must be a positive integer.");
  }
  return Math.floor(normalized);
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeAssignmentStatus(value, fallbackValue = "QUEUED") {
  const normalized = normalizeString(value).toUpperCase();
  if (ASSIGNMENT_STATUS_SET.has(normalized)) {
    return normalized;
  }
  return fallbackValue;
}

function normalizeWorkItemStatus(value, fallbackValue = "QUEUED") {
  const normalized = normalizeString(value).toUpperCase();
  if (WORK_ITEM_STATUS_SET.has(normalized)) {
    return normalized;
  }
  return fallbackValue;
}

function toIsoAfterSeconds(nowIso, seconds) {
  const baseEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString())) || Date.now();
  return new Date(baseEpoch + seconds * 1000).toISOString();
}

function parseStatusList(statuses = []) {
  if (!Array.isArray(statuses)) {
    return null;
  }
  const normalized = statuses
    .map((item) => normalizeString(item).toUpperCase())
    .filter(Boolean)
    .filter((item) => ASSIGNMENT_STATUS_SET.has(item));
  if (normalized.length === 0) {
    return null;
  }
  return new Set(normalized);
}

function createInitialLedger(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    assignments: [],
  };
}

function createInitialQueue(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    items: [],
  };
}

function normalizeAssignmentRecord(record = {}, nowIso = new Date().toISOString()) {
  const updatedAt = normalizeIsoTimestamp(record.updatedAt, nowIso);
  return {
    workItemId: normalizeString(record.workItemId),
    assignedAgentIdentity: normalizeString(record.assignedAgentIdentity) || null,
    leasedAt: record.leasedAt ? normalizeIsoTimestamp(record.leasedAt, updatedAt) : null,
    leaseTtlSeconds: Math.max(1, normalizePositiveInteger(record.leaseTtlSeconds, 1800)),
    leaseExpiresAt: record.leaseExpiresAt ? normalizeIsoTimestamp(record.leaseExpiresAt, updatedAt) : null,
    status: normalizeAssignmentStatus(record.status),
    stage: normalizeString(record.stage) || "triage",
    runId: normalizeString(record.runId) || null,
    jiraIssueKey: normalizeString(record.jiraIssueKey) || null,
    budgetSnapshot: normalizeMetadata(record.budgetSnapshot),
    heartbeatAt: record.heartbeatAt ? normalizeIsoTimestamp(record.heartbeatAt, updatedAt) : null,
    releasedAt: record.releasedAt ? normalizeIsoTimestamp(record.releasedAt, updatedAt) : null,
    releaseReason: normalizeString(record.releaseReason) || null,
    updatedAt,
  };
}

function isAssignmentExpired(record = {}, nowIso = new Date().toISOString()) {
  if (!record || !ACTIVE_ASSIGNMENT_STATUSES.has(normalizeAssignmentStatus(record.status))) {
    return false;
  }
  const expiry = Date.parse(String(record.leaseExpiresAt || ""));
  const now = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  if (!Number.isFinite(expiry) || !Number.isFinite(now)) {
    return false;
  }
  return expiry <= now;
}

function normalizeQueueItem(item = {}, nowIso = new Date().toISOString()) {
  return {
    ...item,
    workItemId: normalizeString(item.workItemId),
    status: normalizeWorkItemStatus(item.status),
    updatedAt: normalizeIsoTimestamp(item.updatedAt, nowIso),
    metadata: normalizeMetadata(item.metadata),
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

async function acquireFileLock(filePath, nowEpochMs = Date.now()) {
  const lockPath = `${filePath}.lock`;
  const deadlineEpoch = nowEpochMs + FILE_LOCK_ACQUIRE_TIMEOUT_MS;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  while (true) {
    try {
      const lockHandle = await fsp.open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), filePath })}\n`,
        "utf-8"
      );
      return {
        lockPath,
        async release() {
          try {
            await lockHandle.close();
          } finally {
            await fsp.rm(lockPath, { force: true });
          }
        },
      };
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) {
        throw error;
      }
      let recoveredStaleLock = false;
      try {
        const rawLock = await fsp.readFile(lockPath, "utf-8");
        const parsedLock = JSON.parse(String(rawLock || "").split(/\r?\n/, 1)[0] || "{}");
        const createdEpoch = Date.parse(String(parsedLock.createdAt || ""));
        if (Number.isFinite(createdEpoch) && Date.now() - createdEpoch >= FILE_LOCK_STALE_WINDOW_MS) {
          await fsp.rm(lockPath, { force: true });
          recoveredStaleLock = true;
        }
      } catch {
        // If lock metadata cannot be read/parsing fails, retain conservative wait behavior.
      }
      if (recoveredStaleLock) {
        continue;
      }
      if (Date.now() >= deadlineEpoch) {
        throw new Error(`Timed out acquiring ledger lock '${lockPath}'.`);
      }
      await sleep(FILE_LOCK_RETRY_DELAY_MS);
    }
  }
}

async function withFileLock(filePath, operation) {
  const lock = await acquireFileLock(filePath);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function writeJsonFile(filePath, payload = {}) {
  return withFileLock(filePath, async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fsp.rename(tempPath, filePath);
  });
}

async function appendEvent(filePath, payload = {}) {
  return withFileLock(filePath, async () => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
}

async function loadLedger(ledgerPath, nowIso = new Date().toISOString()) {
  const parsed = await loadJsonFile(ledgerPath, () => createInitialLedger(nowIso));
  return {
    schemaVersion: normalizeString(parsed.schemaVersion) || LEDGER_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(parsed.generatedAt, nowIso),
    assignments: Array.isArray(parsed.assignments)
      ? parsed.assignments
          .map((record) => normalizeAssignmentRecord(record, nowIso))
          .filter((record) => normalizeString(record.workItemId))
      : [],
  };
}

async function writeLedger(ledgerPath, ledger = {}, nowIso = new Date().toISOString()) {
  const normalized = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    assignments: Array.isArray(ledger.assignments)
      ? ledger.assignments
          .map((record) => normalizeAssignmentRecord(record, nowIso))
          .filter((record) => normalizeString(record.workItemId))
      : [],
  };
  await writeJsonFile(ledgerPath, normalized);
  return normalized;
}

async function loadQueue(queuePath, nowIso = new Date().toISOString()) {
  const parsed = await loadJsonFile(queuePath, () => createInitialQueue(nowIso));
  return {
    schemaVersion: normalizeString(parsed.schemaVersion) || QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(parsed.generatedAt, nowIso),
    items: Array.isArray(parsed.items)
      ? parsed.items.map((item) => normalizeQueueItem(item, nowIso)).filter((item) => item.workItemId)
      : [],
  };
}

async function writeQueue(queuePath, queue = {}, nowIso = new Date().toISOString()) {
  const normalized = {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    items: Array.isArray(queue.items)
      ? queue.items.map((item) => normalizeQueueItem(item, nowIso)).filter((item) => item.workItemId)
      : [],
  };
  await writeJsonFile(queuePath, normalized);
  return normalized;
}

function getAssignmentStoragePaths(baseStorage = {}) {
  return {
    ...baseStorage,
    ledgerPath: path.join(baseStorage.baseDir, "assignment-ledger.json"),
    eventsPath: path.join(baseStorage.baseDir, "assignment-events.ndjson"),
  };
}

async function loadLedgerAndQueue(storage, nowIso) {
  const [ledger, queue] = await Promise.all([
    loadLedger(storage.ledgerPath, nowIso),
    loadQueue(storage.queuePath, nowIso),
  ]);
  return { ledger, queue };
}

function findQueueItem(queue = {}, workItemId = "") {
  return queue.items.find((item) => item.workItemId === workItemId) || null;
}

function updateQueueItem({
  queue,
  workItemId,
  status,
  assignedAgentIdentity = null,
  stage = "",
  runId = null,
  jiraIssueKey = null,
  nowIso,
} = {}) {
  const index = queue.items.findIndex((item) => item.workItemId === workItemId);
  if (index < 0) {
    throw new Error(`Work item '${workItemId}' was not found in daemon queue.`);
  }
  const existing = queue.items[index];
  queue.items[index] = normalizeQueueItem(
    {
      ...existing,
      status: normalizeWorkItemStatus(status, existing.status),
      updatedAt: nowIso,
      metadata: {
        ...normalizeMetadata(existing.metadata),
        assignedAgentIdentity: assignedAgentIdentity || null,
        stage: normalizeString(stage) || null,
        runId: normalizeString(runId) || null,
        jiraIssueKey: normalizeString(jiraIssueKey) || null,
      },
    },
    nowIso
  );
  return queue.items[index];
}

function findAssignmentIndex(ledger = {}, workItemId = "") {
  return ledger.assignments.findIndex((record) => record.workItemId === workItemId);
}

function requireAgentIdentity(value, fieldName = "agentIdentity") {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function normalizeReleaseTargetStatus(value) {
  const normalized = normalizeString(value).toUpperCase();
  if (!RELEASE_TARGET_STATUSES.has(normalized)) {
    throw new Error(
      `status must be one of: ${[...RELEASE_TARGET_STATUSES].join(", ")}.`
    );
  }
  return normalized;
}

export async function resolveAssignmentLedgerStorage({
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
  return getAssignmentStoragePaths(daemonStorage);
}

export async function claimAssignment({
  targetPath = ".",
  outputDir = "",
  workItemId,
  agentIdentity,
  leaseTtlSeconds = 1800,
  stage = "triage",
  runId = "",
  jiraIssueKey = "",
  budgetSnapshot = {},
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedAgentIdentity = requireAgentIdentity(agentIdentity);
  const normalizedTtl = normalizePositiveInteger(leaseTtlSeconds, 1800);
  const storage = await resolveAssignmentLedgerStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const { ledger, queue } = await loadLedgerAndQueue(storage, normalizedNow);

  const queueItem = findQueueItem(queue, normalizedWorkItemId);
  if (!queueItem) {
    throw new Error(`Work item '${normalizedWorkItemId}' was not found in daemon queue.`);
  }

  const assignmentIndex = findAssignmentIndex(ledger, normalizedWorkItemId);
  const existingAssignment = assignmentIndex >= 0 ? ledger.assignments[assignmentIndex] : null;
  if (
    existingAssignment &&
    ACTIVE_ASSIGNMENT_STATUSES.has(existingAssignment.status) &&
    !isAssignmentExpired(existingAssignment, normalizedNow) &&
    existingAssignment.assignedAgentIdentity !== normalizedAgentIdentity
  ) {
    throw new Error(
      `Work item '${normalizedWorkItemId}' is currently leased by '${existingAssignment.assignedAgentIdentity}'.`
    );
  }

  const leaseExpiresAt = toIsoAfterSeconds(normalizedNow, normalizedTtl);
  const nextRecord = normalizeAssignmentRecord(
    {
      workItemId: normalizedWorkItemId,
      assignedAgentIdentity: normalizedAgentIdentity,
      leasedAt: normalizedNow,
      leaseTtlSeconds: normalizedTtl,
      leaseExpiresAt,
      status: "CLAIMED",
      stage,
      runId,
      jiraIssueKey,
      budgetSnapshot: normalizeMetadata(budgetSnapshot),
      heartbeatAt: null,
      releasedAt: null,
      releaseReason: null,
      updatedAt: normalizedNow,
    },
    normalizedNow
  );

  if (assignmentIndex >= 0) {
    ledger.assignments[assignmentIndex] = nextRecord;
  } else {
    ledger.assignments.push(nextRecord);
  }
  updateQueueItem({
    queue,
    workItemId: normalizedWorkItemId,
    status: "ASSIGNED",
    assignedAgentIdentity: normalizedAgentIdentity,
    stage,
    runId,
    jiraIssueKey,
    nowIso: normalizedNow,
  });

  const [savedLedger, savedQueue] = await Promise.all([
    writeLedger(storage.ledgerPath, ledger, normalizedNow),
    writeQueue(storage.queuePath, queue, normalizedNow),
  ]);

  await appendEvent(storage.eventsPath, {
    timestamp: normalizedNow,
    eventType: "claim",
    workItemId: normalizedWorkItemId,
    agentIdentity: normalizedAgentIdentity,
    leaseTtlSeconds: normalizedTtl,
    leaseExpiresAt,
    stage: normalizeString(stage) || "triage",
    runId: normalizeString(runId) || null,
    jiraIssueKey: normalizeString(jiraIssueKey) || null,
  });

  return {
    ...storage,
    ledger: savedLedger,
    queue: savedQueue,
    assignment: nextRecord,
  };
}

export async function heartbeatAssignment({
  targetPath = ".",
  outputDir = "",
  workItemId,
  agentIdentity,
  leaseTtlSeconds = 1800,
  stage = "",
  runId = "",
  jiraIssueKey = "",
  budgetSnapshot = {},
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedAgentIdentity = requireAgentIdentity(agentIdentity);
  const normalizedTtl = normalizePositiveInteger(leaseTtlSeconds, 1800);
  const storage = await resolveAssignmentLedgerStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const { ledger, queue } = await loadLedgerAndQueue(storage, normalizedNow);

  const assignmentIndex = findAssignmentIndex(ledger, normalizedWorkItemId);
  if (assignmentIndex < 0) {
    throw new Error(`No assignment exists for work item '${normalizedWorkItemId}'.`);
  }
  const existing = ledger.assignments[assignmentIndex];
  if (existing.assignedAgentIdentity !== normalizedAgentIdentity) {
    throw new Error(
      `Work item '${normalizedWorkItemId}' is assigned to '${existing.assignedAgentIdentity}', not '${normalizedAgentIdentity}'.`
    );
  }

  const leaseExpiresAt = toIsoAfterSeconds(normalizedNow, normalizedTtl);
  const next = normalizeAssignmentRecord(
    {
      ...existing,
      status: "IN_PROGRESS",
      leaseTtlSeconds: normalizedTtl,
      leaseExpiresAt,
      heartbeatAt: normalizedNow,
      stage: normalizeString(stage) || existing.stage,
      runId: normalizeString(runId) || existing.runId,
      jiraIssueKey: normalizeString(jiraIssueKey) || existing.jiraIssueKey,
      budgetSnapshot:
        Object.keys(normalizeMetadata(budgetSnapshot)).length > 0
          ? normalizeMetadata(budgetSnapshot)
          : existing.budgetSnapshot,
      updatedAt: normalizedNow,
    },
    normalizedNow
  );
  ledger.assignments[assignmentIndex] = next;
  updateQueueItem({
    queue,
    workItemId: normalizedWorkItemId,
    status: "IN_PROGRESS",
    assignedAgentIdentity: normalizedAgentIdentity,
    stage: next.stage,
    runId: next.runId,
    jiraIssueKey: next.jiraIssueKey,
    nowIso: normalizedNow,
  });

  const [savedLedger, savedQueue] = await Promise.all([
    writeLedger(storage.ledgerPath, ledger, normalizedNow),
    writeQueue(storage.queuePath, queue, normalizedNow),
  ]);

  await appendEvent(storage.eventsPath, {
    timestamp: normalizedNow,
    eventType: "heartbeat",
    workItemId: normalizedWorkItemId,
    agentIdentity: normalizedAgentIdentity,
    stage: next.stage,
    leaseExpiresAt,
  });

  return {
    ...storage,
    ledger: savedLedger,
    queue: savedQueue,
    assignment: next,
  };
}

export async function releaseAssignment({
  targetPath = ".",
  outputDir = "",
  workItemId,
  agentIdentity = "",
  status = "QUEUED",
  stage = "",
  runId = "",
  jiraIssueKey = "",
  reason = "",
  budgetSnapshot = {},
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedStatus = normalizeReleaseTargetStatus(status);
  const normalizedAgentIdentity = normalizeString(agentIdentity) || null;
  const storage = await resolveAssignmentLedgerStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const { ledger, queue } = await loadLedgerAndQueue(storage, normalizedNow);

  const assignmentIndex = findAssignmentIndex(ledger, normalizedWorkItemId);
  if (assignmentIndex < 0) {
    throw new Error(`No assignment exists for work item '${normalizedWorkItemId}'.`);
  }
  const existing = ledger.assignments[assignmentIndex];
  if (
    normalizedAgentIdentity &&
    normalizeString(existing.assignedAgentIdentity) &&
    existing.assignedAgentIdentity !== normalizedAgentIdentity
  ) {
    throw new Error(
      `Work item '${normalizedWorkItemId}' is assigned to '${existing.assignedAgentIdentity}', not '${normalizedAgentIdentity}'.`
    );
  }

  const next = normalizeAssignmentRecord(
    {
      ...existing,
      status: normalizedStatus,
      stage: normalizeString(stage) || existing.stage,
      runId: normalizeString(runId) || existing.runId,
      jiraIssueKey: normalizeString(jiraIssueKey) || existing.jiraIssueKey,
      budgetSnapshot:
        Object.keys(normalizeMetadata(budgetSnapshot)).length > 0
          ? normalizeMetadata(budgetSnapshot)
          : existing.budgetSnapshot,
      releasedAt: normalizedNow,
      releaseReason: normalizeString(reason) || null,
      updatedAt: normalizedNow,
    },
    normalizedNow
  );
  ledger.assignments[assignmentIndex] = next;
  updateQueueItem({
    queue,
    workItemId: normalizedWorkItemId,
    status: normalizedStatus,
    assignedAgentIdentity: next.assignedAgentIdentity,
    stage: next.stage,
    runId: next.runId,
    jiraIssueKey: next.jiraIssueKey,
    nowIso: normalizedNow,
  });

  const [savedLedger, savedQueue] = await Promise.all([
    writeLedger(storage.ledgerPath, ledger, normalizedNow),
    writeQueue(storage.queuePath, queue, normalizedNow),
  ]);

  await appendEvent(storage.eventsPath, {
    timestamp: normalizedNow,
    eventType: "release",
    workItemId: normalizedWorkItemId,
    agentIdentity: next.assignedAgentIdentity,
    status: normalizedStatus,
    reason: next.releaseReason,
  });

  return {
    ...storage,
    ledger: savedLedger,
    queue: savedQueue,
    assignment: next,
  };
}

export async function reassignAssignment({
  targetPath = ".",
  outputDir = "",
  workItemId,
  fromAgentIdentity = "",
  toAgentIdentity,
  leaseTtlSeconds = 1800,
  stage = "triage",
  runId = "",
  jiraIssueKey = "",
  budgetSnapshot = {},
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedToAgent = requireAgentIdentity(toAgentIdentity, "toAgentIdentity");
  const normalizedFromAgent = normalizeString(fromAgentIdentity) || null;
  const normalizedTtl = normalizePositiveInteger(leaseTtlSeconds, 1800);
  const storage = await resolveAssignmentLedgerStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const { ledger, queue } = await loadLedgerAndQueue(storage, normalizedNow);

  const assignmentIndex = findAssignmentIndex(ledger, normalizedWorkItemId);
  if (assignmentIndex < 0) {
    throw new Error(`No assignment exists for work item '${normalizedWorkItemId}'.`);
  }
  const existing = ledger.assignments[assignmentIndex];
  if (
    normalizedFromAgent &&
    normalizeString(existing.assignedAgentIdentity) &&
    existing.assignedAgentIdentity !== normalizedFromAgent
  ) {
    throw new Error(
      `Work item '${normalizedWorkItemId}' is assigned to '${existing.assignedAgentIdentity}', not '${normalizedFromAgent}'.`
    );
  }

  const leaseExpiresAt = toIsoAfterSeconds(normalizedNow, normalizedTtl);
  const next = normalizeAssignmentRecord(
    {
      ...existing,
      assignedAgentIdentity: normalizedToAgent,
      leasedAt: normalizedNow,
      leaseTtlSeconds: normalizedTtl,
      leaseExpiresAt,
      status: "CLAIMED",
      stage: normalizeString(stage) || existing.stage,
      runId: normalizeString(runId) || existing.runId,
      jiraIssueKey: normalizeString(jiraIssueKey) || existing.jiraIssueKey,
      budgetSnapshot:
        Object.keys(normalizeMetadata(budgetSnapshot)).length > 0
          ? normalizeMetadata(budgetSnapshot)
          : existing.budgetSnapshot,
      heartbeatAt: null,
      releasedAt: null,
      releaseReason: null,
      updatedAt: normalizedNow,
    },
    normalizedNow
  );
  ledger.assignments[assignmentIndex] = next;
  updateQueueItem({
    queue,
    workItemId: normalizedWorkItemId,
    status: "ASSIGNED",
    assignedAgentIdentity: normalizedToAgent,
    stage: next.stage,
    runId: next.runId,
    jiraIssueKey: next.jiraIssueKey,
    nowIso: normalizedNow,
  });

  const [savedLedger, savedQueue] = await Promise.all([
    writeLedger(storage.ledgerPath, ledger, normalizedNow),
    writeQueue(storage.queuePath, queue, normalizedNow),
  ]);

  await appendEvent(storage.eventsPath, {
    timestamp: normalizedNow,
    eventType: "reassign",
    workItemId: normalizedWorkItemId,
    fromAgentIdentity: existing.assignedAgentIdentity,
    toAgentIdentity: normalizedToAgent,
    leaseTtlSeconds: normalizedTtl,
    leaseExpiresAt,
    stage: next.stage,
  });

  return {
    ...storage,
    ledger: savedLedger,
    queue: savedQueue,
    assignment: next,
  };
}

export async function listAssignments({
  targetPath = ".",
  outputDir = "",
  statuses = [],
  agentIdentity = "",
  includeExpired = true,
  limit = 50,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedLimit = normalizePositiveInteger(limit, 50);
  const normalizedAgent = normalizeString(agentIdentity);
  const statusFilter = parseStatusList(statuses);
  const storage = await resolveAssignmentLedgerStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const ledger = await loadLedger(storage.ledgerPath, normalizedNow);
  const records = ledger.assignments
    .map((record) => {
      const expired = isAssignmentExpired(record, normalizedNow);
      return {
        ...record,
        expired,
      };
    })
    .filter((record) => {
      if (statusFilter && !statusFilter.has(record.status)) {
        return false;
      }
      if (normalizedAgent && record.assignedAgentIdentity !== normalizedAgent) {
        return false;
      }
      if (!includeExpired && record.expired) {
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
    totalCount: ledger.assignments.length,
    visibleCount: records.length,
    assignments: records.slice(0, normalizedLimit),
  };
}
