import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";

const QUEUE_SCHEMA_VERSION = "1.0.0";
const STATE_SCHEMA_VERSION = "1.0.0";
const DEFAULT_MAX_EVENTS = 200;

const TERMINAL_WORK_ITEM_STATUSES = new Set(["DONE", "SQUASHED"]);

export const WORK_ITEM_STATUSES = Object.freeze([
  "QUEUED",
  "ASSIGNED",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
  "SQUASHED",
]);

const WORK_ITEM_STATUS_SET = new Set(WORK_ITEM_STATUSES);

const SEVERITY_RANK = new Map([
  ["UNKNOWN", 0],
  ["P3", 1],
  ["P2", 2],
  ["P1", 3],
  ["P0", 4],
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

function normalizeNonNegativeInteger(value, fallbackValue = 0) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error("Value must be a non-negative integer.");
  }
  return Math.floor(normalized);
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

function stableTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normalizeSeverity(value) {
  const normalized = normalizeString(value).toUpperCase();
  if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
    return normalized;
  }
  return "UNKNOWN";
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeStackTrace(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function computeStackFingerprint(stackTrace = "") {
  const normalized = normalizeStackTrace(stackTrace);
  if (!normalized) {
    return "none";
  }
  const reduced = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("|");
  if (!reduced) {
    return "none";
  }
  return createHash("sha256").update(reduced).digest("hex");
}

function computeFingerprint(event = {}) {
  const materialized = [
    normalizeString(event.service).toLowerCase(),
    normalizeString(event.endpoint).toLowerCase(),
    normalizeString(event.errorCode).toLowerCase(),
    normalizeString(event.stackFingerprint).toLowerCase(),
    normalizeString(event.commitSha).toLowerCase(),
  ].join("|");
  return createHash("sha256").update(materialized).digest("hex");
}

function chooseHigherSeverity(left, right) {
  const leftNormalized = normalizeSeverity(left);
  const rightNormalized = normalizeSeverity(right);
  const leftRank = SEVERITY_RANK.get(leftNormalized) ?? 0;
  const rightRank = SEVERITY_RANK.get(rightNormalized) ?? 0;
  return rightRank > leftRank ? rightNormalized : leftNormalized;
}

function toSeverityRank(value) {
  return SEVERITY_RANK.get(normalizeSeverity(value)) ?? 0;
}

function createWorkItemId(nowIso = new Date().toISOString()) {
  return `err-${stableTimestampForFile(new Date(nowIso))}-${randomUUID().slice(0, 8)}`;
}

function normalizeWorkItemStatus(value) {
  const normalized = normalizeString(value).toUpperCase();
  if (WORK_ITEM_STATUS_SET.has(normalized)) {
    return normalized;
  }
  return "QUEUED";
}

function isTerminalStatus(status = "") {
  return TERMINAL_WORK_ITEM_STATUSES.has(normalizeWorkItemStatus(status));
}

function normalizeQueueItem(item = {}, fallbackNowIso = new Date().toISOString()) {
  const createdAt = normalizeIsoTimestamp(item.createdAt, fallbackNowIso);
  return {
    workItemId: normalizeString(item.workItemId) || createWorkItemId(createdAt),
    fingerprint: normalizeString(item.fingerprint),
    source: normalizeString(item.source) || "admin_error_log",
    service: normalizeString(item.service) || "unknown-service",
    endpoint: normalizeString(item.endpoint) || "unknown-endpoint",
    errorCode: normalizeString(item.errorCode) || "UNKNOWN_ERROR",
    severity: normalizeSeverity(item.severity),
    status: normalizeWorkItemStatus(item.status),
    message: normalizeString(item.message),
    stackFingerprint: normalizeString(item.stackFingerprint) || "none",
    commitSha: normalizeString(item.commitSha) || null,
    firstSeenAt: normalizeIsoTimestamp(item.firstSeenAt, createdAt),
    lastSeenAt: normalizeIsoTimestamp(item.lastSeenAt, createdAt),
    latestEventId: normalizeString(item.latestEventId) || null,
    occurrenceCount: Math.max(1, normalizeNonNegativeInteger(item.occurrenceCount, 1)),
    createdAt,
    updatedAt: normalizeIsoTimestamp(item.updatedAt, createdAt),
    metadata: normalizeMetadata(item.metadata),
  };
}

function getQueueInitialState(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    items: [],
  };
}

function getWorkerStateInitial(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    lastRunAt: null,
    streamOffset: 0,
    runCount: 0,
    totalProcessedEvents: 0,
    totalQueuedItems: 0,
    totalDedupeHits: 0,
  };
}

async function loadQueueFile(queuePath, nowIso = new Date().toISOString()) {
  try {
    const raw = await fsp.readFile(queuePath, "utf-8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item) => normalizeQueueItem(item, nowIso))
          .filter((item) => normalizeString(item.fingerprint))
      : [];
    return {
      schemaVersion: normalizeString(parsed.schemaVersion) || QUEUE_SCHEMA_VERSION,
      generatedAt: normalizeIsoTimestamp(parsed.generatedAt, nowIso),
      items,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return getQueueInitialState(nowIso);
    }
    throw error;
  }
}

async function writeQueueFile(queuePath, queue = {}, nowIso = new Date().toISOString()) {
  const normalized = {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    items: Array.isArray(queue.items)
      ? queue.items
          .map((item) => normalizeQueueItem(item, nowIso))
          .filter((item) => normalizeString(item.fingerprint))
      : [],
  };
  await fsp.mkdir(path.dirname(queuePath), { recursive: true });
  await fsp.writeFile(queuePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

async function loadWorkerStateFile(statePath, nowIso = new Date().toISOString()) {
  try {
    const raw = await fsp.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      schemaVersion: normalizeString(parsed.schemaVersion) || STATE_SCHEMA_VERSION,
      updatedAt: normalizeIsoTimestamp(parsed.updatedAt, nowIso),
      lastRunAt: parsed.lastRunAt ? normalizeIsoTimestamp(parsed.lastRunAt, nowIso) : null,
      streamOffset: normalizeNonNegativeInteger(parsed.streamOffset, 0),
      runCount: normalizeNonNegativeInteger(parsed.runCount, 0),
      totalProcessedEvents: normalizeNonNegativeInteger(parsed.totalProcessedEvents, 0),
      totalQueuedItems: normalizeNonNegativeInteger(parsed.totalQueuedItems, 0),
      totalDedupeHits: normalizeNonNegativeInteger(parsed.totalDedupeHits, 0),
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return getWorkerStateInitial(nowIso);
    }
    throw error;
  }
}

async function writeWorkerStateFile(statePath, state = {}, nowIso = new Date().toISOString()) {
  const normalized = {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    lastRunAt: state.lastRunAt ? normalizeIsoTimestamp(state.lastRunAt, nowIso) : null,
    streamOffset: normalizeNonNegativeInteger(state.streamOffset, 0),
    runCount: normalizeNonNegativeInteger(state.runCount, 0),
    totalProcessedEvents: normalizeNonNegativeInteger(state.totalProcessedEvents, 0),
    totalQueuedItems: normalizeNonNegativeInteger(state.totalQueuedItems, 0),
    totalDedupeHits: normalizeNonNegativeInteger(state.totalDedupeHits, 0),
  };
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

async function loadStreamLines(streamPath) {
  try {
    const raw = await fsp.readFile(streamPath, "utf-8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function buildWorkItemFromEvent(event, nowIso) {
  return normalizeQueueItem(
    {
      workItemId: createWorkItemId(nowIso),
      fingerprint: event.fingerprint,
      source: event.source,
      service: event.service,
      endpoint: event.endpoint,
      errorCode: event.errorCode,
      severity: event.severity,
      status: "QUEUED",
      message: event.message,
      stackFingerprint: event.stackFingerprint,
      commitSha: event.commitSha,
      firstSeenAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
      latestEventId: event.eventId,
      occurrenceCount: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: {
        ...event.metadata,
        sourceEventId: event.eventId,
      },
    },
    nowIso
  );
}

export function normalizeErrorEvent(event = {}, nowIso = new Date().toISOString()) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const stackTrace = normalizeStackTrace(event.stackTrace || event.stack || "");
  const normalized = {
    eventId: normalizeString(event.eventId) || randomUUID(),
    occurredAt: normalizeIsoTimestamp(event.occurredAt, normalizedNow),
    recordedAt: normalizedNow,
    source: normalizeString(event.source) || "admin_error_log",
    service: normalizeString(event.service) || "unknown-service",
    endpoint: normalizeString(event.endpoint) || "unknown-endpoint",
    errorCode: normalizeString(event.errorCode) || "UNKNOWN_ERROR",
    severity: normalizeSeverity(event.severity),
    message: normalizeString(event.message) || "Unhandled runtime error",
    stackTrace,
    stackFingerprint: computeStackFingerprint(stackTrace),
    commitSha: normalizeString(event.commitSha) || null,
    metadata: normalizeMetadata(event.metadata),
  };
  return {
    ...normalized,
    fingerprint: computeFingerprint(normalized),
  };
}

export async function resolveErrorDaemonStorage({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(String(targetPath || ".")),
    outputDirOverride: outputDir,
    env,
    homeDir,
  });
  const baseDir = path.join(outputRoot, "observability", "error-daemon");
  return {
    outputRoot,
    baseDir,
    streamPath: path.join(baseDir, "admin-error-stream.ndjson"),
    queuePath: path.join(baseDir, "queue.json"),
    statePath: path.join(baseDir, "worker-state.json"),
    intakeDir: path.join(baseDir, "intake"),
    runsDir: path.join(baseDir, "runs"),
  };
}

export async function appendAdminErrorEvent({
  targetPath = ".",
  outputDir = "",
  event = {},
  env,
  homeDir,
} = {}) {
  const nowIso = new Date().toISOString();
  const normalizedEvent = normalizeErrorEvent(event, nowIso);
  const storage = await resolveErrorDaemonStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });

  await fsp.mkdir(storage.baseDir, { recursive: true });
  await fsp.appendFile(storage.streamPath, `${JSON.stringify(normalizedEvent)}\n`, "utf-8");

  await fsp.mkdir(storage.intakeDir, { recursive: true });
  const intakePath = path.join(
    storage.intakeDir,
    `intake-${stableTimestampForFile(new Date(normalizedEvent.recordedAt))}-${normalizedEvent.eventId.slice(0, 8)}.json`
  );
  await fsp.writeFile(
    intakePath,
    `${JSON.stringify(
      {
        schemaVersion: "1.0.0",
        generatedAt: nowIso,
        event: normalizedEvent,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  return {
    outputRoot: storage.outputRoot,
    streamPath: storage.streamPath,
    intakePath,
    event: normalizedEvent,
  };
}

export async function getErrorDaemonState({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const storage = await resolveErrorDaemonStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const state = await loadWorkerStateFile(storage.statePath);
  return {
    ...storage,
    state,
  };
}

export async function runErrorDaemonWorker({
  targetPath = ".",
  outputDir = "",
  maxEvents = DEFAULT_MAX_EVENTS,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedMaxEvents = normalizePositiveInteger(maxEvents, DEFAULT_MAX_EVENTS);
  const storage = await resolveErrorDaemonStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });

  const [lines, queue, state] = await Promise.all([
    loadStreamLines(storage.streamPath),
    loadQueueFile(storage.queuePath, normalizedNow),
    loadWorkerStateFile(storage.statePath, normalizedNow),
  ]);

  const startOffset = Math.max(0, Math.min(state.streamOffset, lines.length));
  const endOffset = Math.min(lines.length, startOffset + normalizedMaxEvents);
  const openItemsByFingerprint = new Map();
  for (const item of queue.items) {
    const fingerprint = normalizeString(item.fingerprint);
    if (!fingerprint || isTerminalStatus(item.status)) {
      continue;
    }
    if (!openItemsByFingerprint.has(fingerprint)) {
      openItemsByFingerprint.set(fingerprint, item);
    }
  }

  let processedCount = 0;
  let queuedCount = 0;
  let dedupedCount = 0;
  let parseErrorCount = 0;
  for (let index = startOffset; index < endOffset; index += 1) {
    const rawLine = lines[index];
    if (!rawLine) {
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      parseErrorCount += 1;
      continue;
    }
    const event = normalizeErrorEvent(parsed, normalizedNow);
    processedCount += 1;
    const existing = openItemsByFingerprint.get(event.fingerprint);
    if (existing) {
      dedupedCount += 1;
      existing.occurrenceCount = Math.max(1, Number(existing.occurrenceCount || 1)) + 1;
      existing.lastSeenAt = event.occurredAt;
      existing.updatedAt = normalizedNow;
      existing.latestEventId = event.eventId;
      existing.severity = chooseHigherSeverity(existing.severity, event.severity);
      if (event.message) {
        existing.message = event.message;
      }
      existing.metadata = {
        ...normalizeMetadata(existing.metadata),
        ...normalizeMetadata(event.metadata),
        sourceEventId: event.eventId,
      };
      continue;
    }

    const queued = buildWorkItemFromEvent(event, normalizedNow);
    queue.items.push(queued);
    openItemsByFingerprint.set(queued.fingerprint, queued);
    queuedCount += 1;
  }

  queue.generatedAt = normalizedNow;
  const savedQueue = await writeQueueFile(storage.queuePath, queue, normalizedNow);

  const savedState = await writeWorkerStateFile(
    storage.statePath,
    {
      ...state,
      updatedAt: normalizedNow,
      lastRunAt: normalizedNow,
      streamOffset: endOffset,
      runCount: state.runCount + 1,
      totalProcessedEvents: state.totalProcessedEvents + processedCount,
      totalQueuedItems: savedQueue.items.length,
      totalDedupeHits: state.totalDedupeHits + dedupedCount,
    },
    normalizedNow
  );

  await fsp.mkdir(storage.runsDir, { recursive: true });
  const runId = `error-daemon-run-${stableTimestampForFile(new Date(normalizedNow))}-${randomUUID().slice(0, 8)}`;
  const runPath = path.join(storage.runsDir, `${runId}.json`);
  await fsp.writeFile(
    runPath,
    `${JSON.stringify(
      {
        schemaVersion: "1.0.0",
        generatedAt: normalizedNow,
        runId,
        streamPath: storage.streamPath,
        queuePath: storage.queuePath,
        statePath: storage.statePath,
        startOffset,
        endOffset,
        streamLength: lines.length,
        maxEvents: normalizedMaxEvents,
        processedCount,
        queuedCount,
        dedupedCount,
        parseErrorCount,
        queueDepth: savedQueue.items.length,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  return {
    ...storage,
    runId,
    runPath,
    maxEvents: normalizedMaxEvents,
    startOffset,
    endOffset,
    streamLength: lines.length,
    processedCount,
    queuedCount,
    dedupedCount,
    parseErrorCount,
    queueDepth: savedQueue.items.length,
    queue: savedQueue,
    state: savedState,
  };
}

function parseStatusFilter(statuses = []) {
  if (!Array.isArray(statuses)) {
    return null;
  }
  const normalized = statuses
    .map((value) => normalizeString(value).toUpperCase())
    .filter(Boolean)
    .filter((value) => WORK_ITEM_STATUS_SET.has(value));
  if (normalized.length === 0) {
    return null;
  }
  return new Set(normalized);
}

export async function listErrorQueue({
  targetPath = ".",
  outputDir = "",
  statuses = [],
  limit = 50,
  env,
  homeDir,
} = {}) {
  const normalizedLimit = normalizePositiveInteger(limit, 50);
  const storage = await resolveErrorDaemonStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const [queue, state] = await Promise.all([
    loadQueueFile(storage.queuePath),
    loadWorkerStateFile(storage.statePath),
  ]);

  const statusFilter = parseStatusFilter(statuses);
  const sorted = [...queue.items].sort((left, right) => {
    const severityDelta = toSeverityRank(right.severity) - toSeverityRank(left.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    const leftTs = Date.parse(String(left.lastSeenAt || left.firstSeenAt || "")) || 0;
    const rightTs = Date.parse(String(right.lastSeenAt || right.firstSeenAt || "")) || 0;
    return rightTs - leftTs;
  });
  const filtered = statusFilter
    ? sorted.filter((item) => statusFilter.has(normalizeWorkItemStatus(item.status)))
    : sorted;

  return {
    ...storage,
    state,
    totalCount: sorted.length,
    filteredCount: filtered.length,
    items: filtered.slice(0, normalizedLimit),
  };
}
