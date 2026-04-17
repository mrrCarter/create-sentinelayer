import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";
import { createAgentEvent } from "../events/schema.js";
import { appendToStream } from "../session/stream.js";

const QUEUE_SCHEMA_VERSION = "1.0.0";
const STATE_SCHEMA_VERSION = "1.0.0";
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_DAEMON_POLL_MS = 5000;
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ERROR_DAEMON_AGENT_ID = "error-daemon";
const ACTIVE_DAEMONS = new Map();

const TERMINAL_WORK_ITEM_STATUSES = new Set(["DONE", "SQUASHED"]);

export const DEDUP_KEY_FIELDS = Object.freeze([
  "service",
  "endpoint",
  "error_code",
  "stack_fingerprint",
  "commit_sha",
]);

export const WAKE_MODES = Object.freeze({
  REALTIME: "realtime",
  SCHEDULED: "scheduled",
});

const WAKE_MODE_SET = new Set(Object.values(WAKE_MODES));

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

function normalizeWakeMode(value, fallbackValue = WAKE_MODES.REALTIME) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return fallbackValue;
  }
  if (!WAKE_MODE_SET.has(normalized)) {
    throw new Error(`wakeMode must be one of: ${Object.values(WAKE_MODES).join(", ")}.`);
  }
  return normalized;
}

function normalizeRequestIds(values) {
  const input = Array.isArray(values) ? values : [];
  const deduped = [];
  const seen = new Set();
  for (const value of input) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function mergeRequestIds(existing = [], next = []) {
  return normalizeRequestIds([...normalizeRequestIds(existing), ...normalizeRequestIds(next)]);
}

function buildDedupKey(event = {}) {
  const materialized = [
    normalizeString(event.service).toLowerCase(),
    normalizeString(event.endpoint).toLowerCase(),
    normalizeString(event.errorCode || event.error_code).toLowerCase(),
    normalizeString(event.stackFingerprint || event.stack_fingerprint).toLowerCase(),
    normalizeString(event.commitSha || event.commit_sha).toLowerCase() || "none",
  ].join("|");
  return materialized;
}

function buildDayKey(isoTimestamp = new Date().toISOString()) {
  return normalizeIsoTimestamp(isoTimestamp, new Date().toISOString()).slice(0, 10);
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
  return createHash("sha256").update(buildDedupKey(event)).digest("hex");
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
  const service = normalizeString(item.service) || "unknown-service";
  const endpoint = normalizeString(item.endpoint) || "unknown-endpoint";
  const errorCode = normalizeString(item.errorCode || item.error_code) || "UNKNOWN_ERROR";
  const stackFingerprint =
    normalizeString(item.stackFingerprint || item.stack_fingerprint) || "none";
  const commitSha = normalizeString(item.commitSha || item.commit_sha) || null;
  const requestIds = normalizeRequestIds(item.requestIds || item.request_ids);
  const dedupKey =
    normalizeString(item.dedupKey || item.dedup_key) ||
    buildDedupKey({
      service,
      endpoint,
      errorCode,
      stackFingerprint,
      commitSha,
    });
  return {
    workItemId: normalizeString(item.workItemId) || createWorkItemId(createdAt),
    fingerprint: normalizeString(item.fingerprint),
    source: normalizeString(item.source) || "admin_error_log",
    service,
    endpoint,
    errorCode,
    severity: normalizeSeverity(item.severity),
    status: normalizeWorkItemStatus(item.status),
    message: normalizeString(item.message),
    stackFingerprint,
    commitSha,
    dedupKey,
    firstSeenAt: normalizeIsoTimestamp(item.firstSeenAt, createdAt),
    lastSeenAt: normalizeIsoTimestamp(item.lastSeenAt, createdAt),
    latestEventId: normalizeString(item.latestEventId) || null,
    occurrenceCount: Math.max(1, normalizeNonNegativeInteger(item.occurrenceCount, 1)),
    requestIds,
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
      dedupKey: event.dedupKey,
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
      requestIds: event.requestId ? [event.requestId] : [],
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: {
        ...event.metadata,
        sourceEventId: event.eventId,
        requestId: event.requestId || null,
      },
    },
    nowIso
  );
}

export function normalizeErrorEvent(event = {}, nowIso = new Date().toISOString()) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const stackTrace = normalizeStackTrace(event.stackTrace || event.stack || "");
  const requestId =
    normalizeString(event.requestId || event.request_id) ||
    normalizeString(event?.metadata?.requestId || event?.metadata?.request_id) ||
    null;
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
    commitSha: normalizeString(event.commitSha || event.commit_sha) || null,
    requestId,
    metadata: normalizeMetadata(event.metadata),
  };
  const dedupKey = buildDedupKey(normalized);
  return {
    ...normalized,
    dedupKey,
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
  const observabilityRoot = path.join(outputRoot, "observability");
  const baseDir = path.join(observabilityRoot, "error-daemon");
  return {
    outputRoot,
    observabilityRoot,
    baseDir,
    streamPath: path.join(baseDir, "admin-error-stream.ndjson"),
    queuePath: path.join(baseDir, "queue.json"),
    statePath: path.join(baseDir, "worker-state.json"),
    intakeDir: path.join(baseDir, "intake"),
    runsDir: path.join(baseDir, "runs"),
    sweepsDir: path.join(baseDir, "sweeps"),
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

function resolveWorkItemIntakePath(storage, queueItem, nowIso = new Date().toISOString()) {
  const dayKey = buildDayKey(queueItem.firstSeenAt || nowIso);
  return path.join(storage.observabilityRoot, dayKey, queueItem.workItemId, "intake_event.json");
}

async function writeWorkItemIntakeArtifact(
  storage,
  queueItem,
  {
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const intakePath = resolveWorkItemIntakePath(storage, queueItem, normalizedNow);
  await fsp.mkdir(path.dirname(intakePath), { recursive: true });
  const normalizedRequestIds = normalizeRequestIds(queueItem.requestIds || []);
  const payload = {
    schemaVersion: "1.0.0",
    generated_at: normalizedNow,
    work_item_id: queueItem.workItemId,
    service: queueItem.service,
    endpoint: queueItem.endpoint,
    error_code: queueItem.errorCode,
    stack_fingerprint: queueItem.stackFingerprint,
    commit_sha: queueItem.commitSha,
    first_seen_at: queueItem.firstSeenAt,
    occurrence_count: Math.max(1, Number(queueItem.occurrenceCount || 1)),
    last_seen_at: queueItem.lastSeenAt,
    dedup_key:
      normalizeString(queueItem.dedupKey) ||
      buildDedupKey({
        service: queueItem.service,
        endpoint: queueItem.endpoint,
        errorCode: queueItem.errorCode,
        stackFingerprint: queueItem.stackFingerprint,
        commitSha: queueItem.commitSha,
      }),
    request_ids: normalizedRequestIds,
    fingerprint: queueItem.fingerprint,
    severity: queueItem.severity,
    status: queueItem.status,
    message: queueItem.message,
  };
  await fsp.writeFile(intakePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return {
    intakePath,
    payload,
  };
}

async function emitDaemonSessionEvent(
  sessionId,
  payload = {},
  {
    event = "agent_intake",
    targetPath = ".",
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const envelope = createAgentEvent({
    event: normalizeString(event) || "agent_intake",
    agentId: ERROR_DAEMON_AGENT_ID,
    sessionId: normalizedSessionId,
    ts: normalizedNow,
    workItemId: normalizedPayload.workItemId || normalizedPayload.work_item_id || undefined,
    payload: normalizedPayload,
  });
  await appendToStream(normalizedSessionId, envelope, {
    targetPath: path.resolve(String(targetPath || ".")),
  });
  return envelope;
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
  sessionId = "",
  wakeMode = WAKE_MODES.REALTIME,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedMaxEvents = normalizePositiveInteger(maxEvents, DEFAULT_MAX_EVENTS);
  const normalizedWakeMode = normalizeWakeMode(wakeMode, WAKE_MODES.REALTIME);
  const normalizedSessionId = normalizeString(sessionId);
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const storage = await resolveErrorDaemonStorage({
    targetPath: resolvedTargetPath,
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
  const intakeMutations = [];
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
      existing.dedupKey =
        normalizeString(existing.dedupKey) ||
        normalizeString(event.dedupKey) ||
        buildDedupKey(event);
      existing.requestIds = mergeRequestIds(existing.requestIds, event.requestId ? [event.requestId] : []);
      if (event.message) {
        existing.message = event.message;
      }
      existing.metadata = {
        ...normalizeMetadata(existing.metadata),
        ...normalizeMetadata(event.metadata),
        sourceEventId: event.eventId,
        requestId: event.requestId || null,
      };
      intakeMutations.push({
        action: "dedup",
        queueItem: existing,
        sourceEvent: event,
      });
      continue;
    }

    const queued = buildWorkItemFromEvent(event, normalizedNow);
    queue.items.push(queued);
    openItemsByFingerprint.set(queued.fingerprint, queued);
    queuedCount += 1;
    intakeMutations.push({
      action: "new",
      queueItem: queued,
      sourceEvent: event,
    });
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

  const intakeArtifacts = [];
  const emittedEvents = [];
  for (const mutation of intakeMutations) {
    const written = await writeWorkItemIntakeArtifact(storage, mutation.queueItem, {
      nowIso: normalizedNow,
    });
    intakeArtifacts.push({
      action: mutation.action,
      workItemId: mutation.queueItem.workItemId,
      intakePath: written.intakePath,
      dedupKey: written.payload.dedup_key,
      occurrenceCount: written.payload.occurrence_count,
    });
    if (normalizedSessionId) {
      const emitted = await emitDaemonSessionEvent(
        normalizedSessionId,
        {
          action: mutation.action,
          wakeMode: normalizedWakeMode,
          source: mutation.sourceEvent.source,
          eventId: mutation.sourceEvent.eventId,
          workItemId: mutation.queueItem.workItemId,
          service: mutation.queueItem.service,
          endpoint: mutation.queueItem.endpoint,
          errorCode: mutation.queueItem.errorCode,
          severity: mutation.queueItem.severity,
          stackFingerprint: mutation.queueItem.stackFingerprint,
          commitSha: mutation.queueItem.commitSha,
          dedupKey:
            normalizeString(mutation.queueItem.dedupKey) ||
            buildDedupKey(mutation.queueItem),
          occurrenceCount: Math.max(1, Number(mutation.queueItem.occurrenceCount || 1)),
          requestId: mutation.sourceEvent.requestId || null,
        },
        {
          event: "agent_intake",
          targetPath: resolvedTargetPath,
          nowIso: normalizedNow,
        }
      );
      if (emitted) {
        emittedEvents.push(emitted);
      }
    }
  }

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
        wakeMode: normalizedWakeMode,
        sessionId: normalizedSessionId || null,
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
        intakeArtifactCount: intakeArtifacts.length,
        emittedEventCount: emittedEvents.length,
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
    wakeMode: normalizedWakeMode,
    sessionId: normalizedSessionId || null,
    maxEvents: normalizedMaxEvents,
    startOffset,
    endOffset,
    streamLength: lines.length,
    processedCount,
    queuedCount,
    dedupedCount,
    parseErrorCount,
    queueDepth: savedQueue.items.length,
    intakeArtifacts,
    emittedEvents,
    queue: savedQueue,
    state: savedState,
  };
}

function buildDaemonInstanceKey({
  targetPath = ".",
  sessionId = "",
  wakeMode = WAKE_MODES.REALTIME,
} = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedSessionId = normalizeString(sessionId) || "no-session";
  const normalizedWakeMode = normalizeWakeMode(wakeMode, WAKE_MODES.REALTIME);
  return `${resolvedTargetPath}::${normalizedSessionId}::${normalizedWakeMode}`;
}

function buildSeverityCounts(items = []) {
  const counts = {
    UNKNOWN: 0,
    P3: 0,
    P2: 0,
    P1: 0,
    P0: 0,
  };
  for (const item of items) {
    const normalizedSeverity = normalizeSeverity(item?.severity);
    counts[normalizedSeverity] = (counts[normalizedSeverity] || 0) + 1;
  }
  return counts;
}

export async function scheduledErrorSweep({
  targetPath = ".",
  outputDir = "",
  sessionId = "",
  region = "global",
  tz = "UTC",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedRegion = normalizeString(region) || "global";
  const normalizedTz = normalizeString(tz) || "UTC";
  const storage = await resolveErrorDaemonStorage({
    targetPath: resolvedTargetPath,
    outputDir,
    env,
    homeDir,
  });
  const queue = await loadQueueFile(storage.queuePath, normalizedNow);
  const activeItems = queue.items.filter((item) => !isTerminalStatus(item.status));
  const severityCounts = buildSeverityCounts(activeItems);
  const totalOccurrences = activeItems.reduce(
    (sum, item) => sum + Math.max(1, Number(item.occurrenceCount || 1)),
    0
  );
  const runId = `error-daemon-sweep-${stableTimestampForFile(new Date(normalizedNow))}-${randomUUID().slice(0, 8)}`;

  const digest = {
    schemaVersion: "1.0.0",
    generatedAt: normalizedNow,
    runId,
    wakeMode: WAKE_MODES.SCHEDULED,
    region: normalizedRegion,
    tz: normalizedTz,
    queueDepth: activeItems.length,
    totalOccurrences,
    severityCounts,
    workItems: activeItems.map((item) => ({
      workItemId: item.workItemId,
      service: item.service,
      endpoint: item.endpoint,
      errorCode: item.errorCode,
      severity: item.severity,
      status: item.status,
      occurrenceCount: item.occurrenceCount,
      dedupKey: item.dedupKey,
      lastSeenAt: item.lastSeenAt,
    })),
  };

  await fsp.mkdir(storage.sweepsDir, { recursive: true });
  const sweepPath = path.join(storage.sweepsDir, `${runId}.json`);
  await fsp.writeFile(sweepPath, `${JSON.stringify(digest, null, 2)}\n`, "utf-8");

  let sweepEvent = null;
  if (normalizedSessionId) {
    sweepEvent = await emitDaemonSessionEvent(
      normalizedSessionId,
      {
        action: "scheduled_rollup",
        wakeMode: WAKE_MODES.SCHEDULED,
        region: normalizedRegion,
        tz: normalizedTz,
        queueDepth: activeItems.length,
        totalOccurrences,
        severityCounts,
        runId,
      },
      {
        event: "agent_intake",
        targetPath: resolvedTargetPath,
        nowIso: normalizedNow,
      }
    );
  }

  return {
    ...storage,
    runId,
    sweepPath,
    wakeMode: WAKE_MODES.SCHEDULED,
    region: normalizedRegion,
    tz: normalizedTz,
    queueDepth: activeItems.length,
    totalOccurrences,
    severityCounts,
    digest,
    event: sweepEvent,
  };
}

export async function startErrorEventDaemon({
  sessionId = "",
  wakeMode = WAKE_MODES.REALTIME,
  targetPath = ".",
  outputDir = "",
  pollMs = DEFAULT_DAEMON_POLL_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
  autoStart = true,
  region = "global",
  tz = "UTC",
  env,
  homeDir,
} = {}) {
  const normalizedWakeMode = normalizeWakeMode(wakeMode, WAKE_MODES.REALTIME);
  const normalizedSessionId = normalizeString(sessionId);
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const daemonKey = buildDaemonInstanceKey({
    targetPath: resolvedTargetPath,
    sessionId: normalizedSessionId,
    wakeMode: normalizedWakeMode,
  });
  const existing = ACTIVE_DAEMONS.get(daemonKey);
  if (existing) {
    return existing.handle;
  }

  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const normalizedPollMs = normalizePositiveInteger(pollMs, DEFAULT_DAEMON_POLL_MS);
  const normalizedSweepIntervalMs = normalizePositiveInteger(
    sweepIntervalMs,
    DEFAULT_SWEEP_INTERVAL_MS
  );

  const daemonState = {
    daemonKey,
    sessionId: normalizedSessionId || null,
    wakeMode: normalizedWakeMode,
    targetPath: resolvedTargetPath,
    startedAt,
    running: true,
    timer: null,
    inFlight: false,
    lastTickAt: null,
    lastTickResult: null,
    stopReason: null,
  };

  const runTick = async () => {
    if (!daemonState.running || controller.signal.aborted || daemonState.inFlight) {
      return daemonState.lastTickResult;
    }
    daemonState.inFlight = true;
    try {
      const result =
        normalizedWakeMode === WAKE_MODES.SCHEDULED
          ? await scheduledErrorSweep({
              targetPath: resolvedTargetPath,
              outputDir,
              sessionId: normalizedSessionId,
              region,
              tz,
              env,
              homeDir,
            })
          : await runErrorDaemonWorker({
              targetPath: resolvedTargetPath,
              outputDir,
              sessionId: normalizedSessionId,
              wakeMode: normalizedWakeMode,
              maxEvents,
              env,
              homeDir,
            });
      daemonState.lastTickAt = new Date().toISOString();
      daemonState.lastTickResult = result;
      return result;
    } finally {
      daemonState.inFlight = false;
    }
  };

  const stop = async (reason = "manual") => {
    if (!daemonState.running) {
      return {
        stopped: false,
        daemonKey,
        reason: daemonState.stopReason || normalizeString(reason) || "manual",
      };
    }
    daemonState.running = false;
    daemonState.stopReason = normalizeString(reason) || "manual";
    controller.abort();
    if (daemonState.timer) {
      clearInterval(daemonState.timer);
      daemonState.timer = null;
    }
    ACTIVE_DAEMONS.delete(daemonKey);
    let event = null;
    if (normalizedSessionId) {
      event = await emitDaemonSessionEvent(
        normalizedSessionId,
        {
          target: ERROR_DAEMON_AGENT_ID,
          reason: daemonState.stopReason,
          wakeMode: normalizedWakeMode,
        },
        {
          event: "agent_killed",
          targetPath: resolvedTargetPath,
          nowIso: new Date().toISOString(),
        }
      );
    }
    return {
      stopped: true,
      daemonKey,
      sessionId: normalizedSessionId || null,
      wakeMode: normalizedWakeMode,
      stoppedAt: new Date().toISOString(),
      reason: daemonState.stopReason,
      event,
    };
  };

  const handle = {
    daemonKey,
    sessionId: normalizedSessionId || null,
    wakeMode: normalizedWakeMode,
    targetPath: resolvedTargetPath,
    startedAt,
    signal: controller.signal,
    runTick,
    stop,
    isRunning: () => daemonState.running,
    getState: () => ({
      daemonKey,
      sessionId: normalizedSessionId || null,
      wakeMode: normalizedWakeMode,
      targetPath: resolvedTargetPath,
      startedAt,
      running: daemonState.running,
      lastTickAt: daemonState.lastTickAt,
      stopReason: daemonState.stopReason,
    }),
  };
  ACTIVE_DAEMONS.set(daemonKey, {
    ...daemonState,
    handle,
  });

  if (autoStart) {
    await runTick();
    const intervalMs =
      normalizedWakeMode === WAKE_MODES.SCHEDULED ? normalizedSweepIntervalMs : normalizedPollMs;
    daemonState.timer = setInterval(() => {
      void runTick().catch(() => {});
    }, intervalMs);
    if (typeof daemonState.timer.unref === "function") {
      daemonState.timer.unref();
    }
  }

  return handle;
}

export async function stopErrorEventDaemon({
  targetPath = ".",
  sessionId = "",
  wakeMode = "",
  reason = "manual",
} = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedReason = normalizeString(reason) || "manual";
  const normalizedWakeMode = normalizeString(wakeMode)
    ? normalizeWakeMode(wakeMode, WAKE_MODES.REALTIME)
    : "";

  const matching = [];
  for (const [key, value] of ACTIVE_DAEMONS.entries()) {
    const sameTargetPath = value.targetPath === resolvedTargetPath;
    const sameSession =
      !normalizedSessionId || normalizeString(value.sessionId) === normalizedSessionId;
    const sameWakeMode = !normalizedWakeMode || value.wakeMode === normalizedWakeMode;
    if (sameTargetPath && sameSession && sameWakeMode) {
      matching.push({ key, value });
    }
  }

  if (matching.length === 0) {
    return {
      stopped: false,
      count: 0,
      targetPath: resolvedTargetPath,
      sessionId: normalizedSessionId || null,
      wakeMode: normalizedWakeMode || null,
    };
  }

  const stopped = [];
  for (const match of matching) {
    const result = await match.value.handle.stop(normalizedReason);
    stopped.push(result);
  }

  return {
    stopped: true,
    count: stopped.length,
    targetPath: resolvedTargetPath,
    sessionId: normalizedSessionId || null,
    wakeMode: normalizedWakeMode || null,
    daemons: stopped,
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
