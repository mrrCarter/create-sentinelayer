import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAssignmentLedgerStorage } from "./assignment-ledger.js";
import { resolveErrorDaemonStorage } from "./error-worker.js";

const LIFECYCLE_SCHEMA_VERSION = "1.0.0";
const QUEUE_SCHEMA_VERSION = "1.0.0";

export const JIRA_STATUSES = Object.freeze([
  "OPEN",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
  "CANCELLED",
]);

const JIRA_STATUS_SET = new Set(JIRA_STATUSES);

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

function normalizeStatus(value, fallbackValue = "OPEN") {
  const normalized = normalizeString(value).toUpperCase();
  if (JIRA_STATUS_SET.has(normalized)) {
    return normalized;
  }
  return fallbackValue;
}

function normalizeLabels(labels = []) {
  if (!Array.isArray(labels)) {
    return [];
  }
  const deduped = new Set();
  for (const label of labels) {
    const normalized = normalizeString(label);
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return [...deduped];
}

function normalizeComment(comment = {}, nowIso = new Date().toISOString()) {
  return {
    at: normalizeIsoTimestamp(comment.at, nowIso),
    actor: normalizeString(comment.actor) || "omar-daemon",
    type: normalizeString(comment.type) || "note",
    message: normalizeString(comment.message),
  };
}

function normalizeTransition(transition = {}, nowIso = new Date().toISOString()) {
  return {
    at: normalizeIsoTimestamp(transition.at, nowIso),
    actor: normalizeString(transition.actor) || "omar-daemon",
    from: normalizeStatus(transition.from, "OPEN"),
    to: normalizeStatus(transition.to, "OPEN"),
    reason: normalizeString(transition.reason) || null,
  };
}

function normalizeIssue(issue = {}, nowIso = new Date().toISOString()) {
  const createdAt = normalizeIsoTimestamp(issue.createdAt, nowIso);
  return {
    workItemId: normalizeString(issue.workItemId),
    issueKey: normalizeString(issue.issueKey),
    summary: normalizeString(issue.summary) || "Daemon work item remediation",
    description: normalizeString(issue.description),
    status: normalizeStatus(issue.status, "OPEN"),
    labels: normalizeLabels(issue.labels),
    assignee: normalizeString(issue.assignee) || null,
    createdAt,
    updatedAt: normalizeIsoTimestamp(issue.updatedAt, createdAt),
    latestCommentAt: issue.latestCommentAt ? normalizeIsoTimestamp(issue.latestCommentAt, createdAt) : null,
    comments: Array.isArray(issue.comments)
      ? issue.comments.map((comment) => normalizeComment(comment, createdAt)).filter((comment) => comment.message)
      : [],
    transitions: Array.isArray(issue.transitions)
      ? issue.transitions
          .map((transition) => normalizeTransition(transition, createdAt))
          .filter((transition) => transition.to)
      : [],
  };
}

function createInitialLifecycle(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    issueCounter: 0,
    issues: [],
  };
}

function normalizeIssueKeyPrefix(value) {
  const cleaned = normalizeString(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  if (!cleaned) {
    return "SLD";
  }
  return cleaned.slice(0, 12);
}

function parseCsv(rawValue) {
  if (!rawValue) {
    return [];
  }
  return String(rawValue)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    items: [],
  }));
  return {
    schemaVersion: normalizeString(parsed.schemaVersion) || QUEUE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(parsed.generatedAt, nowIso),
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

async function loadLifecycle(lifecyclePath, nowIso = new Date().toISOString()) {
  const parsed = await loadJsonFile(lifecyclePath, () => createInitialLifecycle(nowIso));
  return {
    schemaVersion: normalizeString(parsed.schemaVersion) || LIFECYCLE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(parsed.generatedAt, nowIso),
    issueCounter: Number(parsed.issueCounter || 0),
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.map((issue) => normalizeIssue(issue, nowIso)).filter((issue) => issue.workItemId && issue.issueKey)
      : [],
  };
}

async function writeLifecycle(lifecyclePath, lifecycle = {}, nowIso = new Date().toISOString()) {
  const normalized = {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    issueCounter: Math.max(0, Number(lifecycle.issueCounter || 0)),
    issues: Array.isArray(lifecycle.issues)
      ? lifecycle.issues
          .map((issue) => normalizeIssue(issue, nowIso))
          .filter((issue) => issue.workItemId && issue.issueKey)
      : [],
  };
  await writeJsonFile(lifecyclePath, normalized);
  return normalized;
}

function findIssueIndex(lifecycle = {}, { workItemId = "", issueKey = "" } = {}) {
  const normalizedWorkItemId = normalizeString(workItemId);
  const normalizedIssueKey = normalizeString(issueKey);
  return lifecycle.issues.findIndex((issue) => {
    if (normalizedIssueKey && issue.issueKey === normalizedIssueKey) {
      return true;
    }
    if (normalizedWorkItemId && issue.workItemId === normalizedWorkItemId) {
      return true;
    }
    return false;
  });
}

function buildDefaultSummary(queueItem = {}, workItemId = "") {
  const service = normalizeString(queueItem.service) || "unknown-service";
  const endpoint = normalizeString(queueItem.endpoint) || "unknown-endpoint";
  const errorCode = normalizeString(queueItem.errorCode) || "UNKNOWN_ERROR";
  return `[${workItemId}] ${service} ${endpoint} ${errorCode}`.trim();
}

function buildDefaultDescription(queueItem = {}) {
  const lines = [
    `service: ${normalizeString(queueItem.service) || "unknown-service"}`,
    `endpoint: ${normalizeString(queueItem.endpoint) || "unknown-endpoint"}`,
    `error_code: ${normalizeString(queueItem.errorCode) || "UNKNOWN_ERROR"}`,
    `severity: ${normalizeString(queueItem.severity) || "UNKNOWN"}`,
    `message: ${normalizeString(queueItem.message) || "n/a"}`,
    `fingerprint: ${normalizeString(queueItem.fingerprint) || "n/a"}`,
  ];
  return lines.join("\n");
}

async function syncIssueKeyToAssignment({
  targetPath,
  outputDir,
  workItemId,
  issueKey,
  nowIso,
  env,
  homeDir,
} = {}) {
  const assignmentStorage = await resolveAssignmentLedgerStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const rawLedger = await loadJsonFile(assignmentStorage.ledgerPath, () => null);
  if (!rawLedger || !Array.isArray(rawLedger.assignments)) {
    return;
  }
  const assignments = rawLedger.assignments.map((record) => ({
    ...record,
    workItemId: normalizeString(record.workItemId),
  }));
  const index = assignments.findIndex((record) => record.workItemId === workItemId);
  if (index < 0) {
    return;
  }
  assignments[index] = {
    ...assignments[index],
    jiraIssueKey: issueKey,
    updatedAt: nowIso,
  };
  await writeJsonFile(assignmentStorage.ledgerPath, {
    ...rawLedger,
    generatedAt: nowIso,
    assignments,
  });
}

export async function resolveJiraLifecycleStorage({
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
    lifecyclePath: path.join(daemonStorage.baseDir, "jira-lifecycle.json"),
    eventsPath: path.join(daemonStorage.baseDir, "jira-events.ndjson"),
  };
}

export async function openJiraIssue({
  targetPath = ".",
  outputDir = "",
  workItemId,
  summary = "",
  description = "",
  labels = [],
  assignee = "",
  issueKey = "",
  issueKeyPrefix = "SLD",
  actor = "omar-daemon",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const storage = await resolveJiraLifecycleStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const [queue, lifecycle] = await Promise.all([
    loadQueue(storage.queuePath, normalizedNow),
    loadLifecycle(storage.lifecyclePath, normalizedNow),
  ]);
  const queueItem = queue.items.find((item) => normalizeString(item.workItemId) === normalizedWorkItemId);
  if (!queueItem) {
    throw new Error(`Work item '${normalizedWorkItemId}' was not found in daemon queue.`);
  }

  const existingIndex = findIssueIndex(lifecycle, { workItemId: normalizedWorkItemId });
  if (existingIndex >= 0) {
    const existing = lifecycle.issues[existingIndex];
    await syncIssueKeyToAssignment({
      targetPath,
      outputDir,
      workItemId: normalizedWorkItemId,
      issueKey: existing.issueKey,
      nowIso: normalizedNow,
      env,
      homeDir,
    });
    return {
      ...storage,
      issue: existing,
      created: false,
    };
  }

  let normalizedIssueKey = normalizeString(issueKey);
  if (!normalizedIssueKey) {
    const prefix = normalizeIssueKeyPrefix(issueKeyPrefix);
    lifecycle.issueCounter = Math.max(0, Number(lifecycle.issueCounter || 0)) + 1;
    normalizedIssueKey = `${prefix}-${lifecycle.issueCounter}`;
  }
  const duplicateIssueKey = lifecycle.issues.some((issue) => issue.issueKey === normalizedIssueKey);
  if (duplicateIssueKey) {
    throw new Error(`issueKey '${normalizedIssueKey}' already exists in jira lifecycle registry.`);
  }

  const issue = normalizeIssue(
    {
      workItemId: normalizedWorkItemId,
      issueKey: normalizedIssueKey,
      summary: normalizeString(summary) || buildDefaultSummary(queueItem, normalizedWorkItemId),
      description: normalizeString(description) || buildDefaultDescription(queueItem),
      status: "OPEN",
      labels: normalizeLabels([
        "sentinelayer",
        "omar-daemon",
        `severity-${normalizeString(queueItem.severity || "unknown").toLowerCase()}`,
        ...labels,
      ]),
      assignee: normalizeString(assignee) || null,
      createdAt: normalizedNow,
      updatedAt: normalizedNow,
      latestCommentAt: null,
      comments: [],
      transitions: [],
    },
    normalizedNow
  );
  lifecycle.issues.push(issue);
  const savedLifecycle = await writeLifecycle(storage.lifecyclePath, lifecycle, normalizedNow);
  await appendEvent(storage.eventsPath, {
    timestamp: normalizedNow,
    eventType: "create_issue",
    actor: normalizeString(actor) || "omar-daemon",
    workItemId: normalizedWorkItemId,
    issueKey: normalizedIssueKey,
    status: "OPEN",
  });
  await syncIssueKeyToAssignment({
    targetPath,
    outputDir,
    workItemId: normalizedWorkItemId,
    issueKey: normalizedIssueKey,
    nowIso: normalizedNow,
    env,
    homeDir,
  });
  return {
    ...storage,
    lifecycle: savedLifecycle,
    issue,
    created: true,
  };
}

export async function commentJiraIssue({
  targetPath = ".",
  outputDir = "",
  workItemId = "",
  issueKey = "",
  actor = "omar-daemon",
  type = "note",
  message,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedMessage = normalizeString(message);
  if (!normalizedMessage) {
    throw new Error("message is required.");
  }
  const storage = await resolveJiraLifecycleStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const lifecycle = await loadLifecycle(storage.lifecyclePath, normalizedNow);
  const issueIndex = findIssueIndex(lifecycle, { workItemId, issueKey });
  if (issueIndex < 0) {
    throw new Error("No jira lifecycle issue found for the provided workItemId/issueKey.");
  }
  const existing = lifecycle.issues[issueIndex];
  const comment = normalizeComment(
    {
      at: normalizedNow,
      actor,
      type,
      message: normalizedMessage,
    },
    normalizedNow
  );
  existing.comments = [...existing.comments, comment];
  existing.latestCommentAt = normalizedNow;
  existing.updatedAt = normalizedNow;
  lifecycle.issues[issueIndex] = normalizeIssue(existing, normalizedNow);
  const savedLifecycle = await writeLifecycle(storage.lifecyclePath, lifecycle, normalizedNow);
  await appendEvent(storage.eventsPath, {
    timestamp: normalizedNow,
    eventType: "comment",
    actor: normalizeString(actor) || "omar-daemon",
    workItemId: existing.workItemId,
    issueKey: existing.issueKey,
    type: comment.type,
    message: comment.message,
  });
  return {
    ...storage,
    lifecycle: savedLifecycle,
    issue: lifecycle.issues[issueIndex],
    comment,
  };
}

export async function transitionJiraIssue({
  targetPath = ".",
  outputDir = "",
  workItemId = "",
  issueKey = "",
  toStatus,
  actor = "omar-daemon",
  reason = "",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const nextStatus = normalizeStatus(toStatus, "");
  if (!nextStatus) {
    throw new Error(`toStatus must be one of: ${JIRA_STATUSES.join(", ")}.`);
  }
  const storage = await resolveJiraLifecycleStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const lifecycle = await loadLifecycle(storage.lifecyclePath, normalizedNow);
  const issueIndex = findIssueIndex(lifecycle, { workItemId, issueKey });
  if (issueIndex < 0) {
    throw new Error("No jira lifecycle issue found for the provided workItemId/issueKey.");
  }
  const existing = lifecycle.issues[issueIndex];
  const transition = normalizeTransition(
    {
      at: normalizedNow,
      actor,
      from: existing.status,
      to: nextStatus,
      reason,
    },
    normalizedNow
  );
  existing.status = nextStatus;
  existing.transitions = [...existing.transitions, transition];
  existing.updatedAt = normalizedNow;
  lifecycle.issues[issueIndex] = normalizeIssue(existing, normalizedNow);
  const savedLifecycle = await writeLifecycle(storage.lifecyclePath, lifecycle, normalizedNow);
  await appendEvent(storage.eventsPath, {
    timestamp: normalizedNow,
    eventType: "transition",
    actor: normalizeString(actor) || "omar-daemon",
    workItemId: existing.workItemId,
    issueKey: existing.issueKey,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
  });
  return {
    ...storage,
    lifecycle: savedLifecycle,
    issue: lifecycle.issues[issueIndex],
    transition,
  };
}

export async function startJiraLifecycle({
  targetPath = ".",
  outputDir = "",
  workItemId,
  actor = "omar-daemon",
  assignee = "",
  summary = "",
  description = "",
  labels = [],
  planMessage,
  issueKey = "",
  issueKeyPrefix = "SLD",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const opened = await openJiraIssue({
    targetPath,
    outputDir,
    workItemId,
    actor,
    assignee,
    summary,
    description,
    labels,
    issueKey,
    issueKeyPrefix,
    env,
    homeDir,
    nowIso,
  });
  const normalizedPlanMessage = normalizeString(planMessage);
  let comment = null;
  if (normalizedPlanMessage) {
    const commented = await commentJiraIssue({
      targetPath,
      outputDir,
      workItemId,
      issueKey: opened.issue.issueKey,
      actor,
      type: "plan",
      message: normalizedPlanMessage,
      env,
      homeDir,
      nowIso,
    });
    comment = commented.comment;
  }
  const transitioned = await transitionJiraIssue({
    targetPath,
    outputDir,
    workItemId,
    issueKey: opened.issue.issueKey,
    toStatus: "IN_PROGRESS",
    actor,
    reason: "Agent accepted work item and started remediation plan.",
    env,
    homeDir,
    nowIso,
  });
  return {
    ...transitioned,
    created: opened.created,
    comment,
  };
}

export async function listJiraIssues({
  targetPath = ".",
  outputDir = "",
  workItemId = "",
  issueKey = "",
  statuses = [],
  limit = 50,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedLimit = Math.max(1, Math.floor(Number(limit || 50)));
  const normalizedWorkItemId = normalizeString(workItemId);
  const normalizedIssueKey = normalizeString(issueKey);
  const statusFilter = new Set(parseCsv(statuses).map((status) => normalizeStatus(status, "")).filter(Boolean));
  const storage = await resolveJiraLifecycleStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const lifecycle = await loadLifecycle(storage.lifecyclePath, normalizedNow);
  const filtered = lifecycle.issues.filter((issue) => {
    if (normalizedWorkItemId && issue.workItemId !== normalizedWorkItemId) {
      return false;
    }
    if (normalizedIssueKey && issue.issueKey !== normalizedIssueKey) {
      return false;
    }
    if (statusFilter.size > 0 && !statusFilter.has(issue.status)) {
      return false;
    }
    return true;
  });
  const sorted = [...filtered].sort((left, right) => {
    const leftEpoch = Date.parse(String(left.updatedAt || "")) || 0;
    const rightEpoch = Date.parse(String(right.updatedAt || "")) || 0;
    return rightEpoch - leftEpoch;
  });
  return {
    ...storage,
    totalCount: lifecycle.issues.length,
    visibleCount: sorted.length,
    issues: sorted.slice(0, normalizedLimit),
  };
}
