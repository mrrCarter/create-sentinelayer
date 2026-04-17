import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { listAssignments, resolveAssignmentLedgerStorage } from "./assignment-ledger.js";
import { getBudgetHealthColor, resolveOperatorControlStorage } from "./operator-control.js";
import { listBudgetStates, resolveBudgetGovernorStorage } from "./budget-governor.js";
import { listErrorQueue, resolveErrorDaemonStorage, WORK_ITEM_STATUSES } from "./error-worker.js";
import { listJiraIssues, resolveJiraLifecycleStorage } from "./jira-lifecycle.js";
import { resolveSessionPaths } from "../session/paths.js";

const LINEAGE_SCHEMA_VERSION = "1.0.0";
const WORK_ITEM_STATUS_SET = new Set(WORK_ITEM_STATUSES);

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

function toPosixPath(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function toRelativePosix(baseDir, absolutePath) {
  const relative = path.relative(baseDir, absolutePath);
  return toPosixPath(relative);
}

function normalizeDateKey(value = "", fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }
  return normalizeIsoTimestamp(normalized, fallbackIso).slice(0, 10);
}

function buildDayKey(nowIso = new Date().toISOString()) {
  return normalizeDateKey(nowIso, nowIso);
}

function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value))
        .filter(Boolean)
    )
  );
}

async function readFileBufferOptional(filePath) {
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function hashFileSha256(filePath) {
  const payload = await fsp.readFile(filePath);
  return createHash("sha256").update(payload).digest("hex");
}

function resolveWorkItemArtifactDir(storage, workItemId, date) {
  return path.join(
    storage.observabilityRoot,
    normalizeDateKey(date, new Date().toISOString()),
    normalizeString(workItemId)
  );
}

function canonicalizeArtifactRecords(artifactFiles = []) {
  return artifactFiles
    .map((artifact) => ({
      name: normalizeString(artifact.name),
      path: toPosixPath(normalizeString(artifact.path)),
      sha256: normalizeString(artifact.sha256).toLowerCase(),
      sizeBytes: Number(artifact.sizeBytes || 0),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildCloseoutAnchorPayload({
  workItemId,
  sessionId,
  date,
  artifacts = [],
  sessionStream = null,
  cosignAttestationRef = "",
  sbomRef = "",
  evidenceLinks = [],
} = {}) {
  return {
    workItemId: normalizeString(workItemId),
    sessionId: normalizeString(sessionId) || null,
    date: normalizeDateKey(date, new Date().toISOString()),
    artifacts: canonicalizeArtifactRecords(artifacts),
    sessionStream: sessionStream
      ? {
          path: toPosixPath(normalizeString(sessionStream.path)),
          sha256: normalizeString(sessionStream.sha256).toLowerCase(),
          sizeBytes: Number(sessionStream.sizeBytes || 0),
        }
      : null,
    cosignAttestationRef: normalizeString(cosignAttestationRef) || null,
    sbomRef: normalizeString(sbomRef) || null,
    evidenceLinks: normalizeStringArray(evidenceLinks).sort((left, right) =>
      left.localeCompare(right)
    ),
  };
}

function computeAnchorSha256(payload = {}) {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function resolveArtifactAbsolutePath(storage, artifactPath = "") {
  const normalized = normalizeString(artifactPath);
  if (!normalized) {
    return "";
  }
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.join(storage.outputRoot, normalized);
}

async function resolveSessionStreamDigest(sessionId, { targetPath = "." } = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const sessionPaths = resolveSessionPaths(normalizedSessionId, { targetPath });
  const [rotatedBuffer, streamBuffer] = await Promise.all([
    readFileBufferOptional(sessionPaths.rotatedStreamPath),
    readFileBufferOptional(sessionPaths.streamPath),
  ]);
  if (!rotatedBuffer && !streamBuffer) {
    return null;
  }

  const hash = createHash("sha256");
  let totalBytes = 0;
  if (rotatedBuffer) {
    hash.update(rotatedBuffer);
    totalBytes += rotatedBuffer.length;
  }
  if (streamBuffer) {
    hash.update(streamBuffer);
    totalBytes += streamBuffer.length;
  }
  return {
    path: toPosixPath(path.relative(path.resolve(String(targetPath || ".")), sessionPaths.streamPath)),
    sha256: hash.digest("hex"),
    sizeBytes: totalBytes,
  };
}

export async function writeCloseoutArtifact({
  workItemId,
  sessionId = "",
  date = "",
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
  cosignAttestationRef = "",
  sbomRef = "",
  evidenceLinks = [],
  chainVerified = true,
} = {}) {
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const storage = await resolveArtifactLineageStorage({
    targetPath: normalizedTargetPath,
    outputDir,
    env,
    homeDir,
  });
  const dateKey = normalizeDateKey(date, normalizedNow);
  const artifactDir = resolveWorkItemArtifactDir(storage, normalizedWorkItemId, dateKey);
  await fsp.mkdir(artifactDir, { recursive: true });
  const closeoutPath = path.join(artifactDir, "closeout.json");

  const entries = await fsp.readdir(artifactDir, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const artifactFiles = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower === "closeout.json") {
      continue;
    }
    const absolutePath = path.join(artifactDir, entry.name);
    const stat = await fsp.stat(absolutePath);
    artifactFiles.push({
      name: entry.name,
      path: toRelativePosix(storage.outputRoot, absolutePath),
      sha256: await hashFileSha256(absolutePath),
      sizeBytes: Number(stat.size || 0),
    });
  }
  const sessionStream = await resolveSessionStreamDigest(normalizeString(sessionId), {
    targetPath: normalizedTargetPath,
  });
  const anchorPayload = buildCloseoutAnchorPayload({
    workItemId: normalizedWorkItemId,
    sessionId,
    date: dateKey,
    artifacts: artifactFiles,
    sessionStream,
    cosignAttestationRef,
    sbomRef,
    evidenceLinks,
  });
  const anchorSha256 = computeAnchorSha256(anchorPayload);
  const payload = {
    schemaVersion: "1.0.0",
    generatedAt: normalizedNow,
    chainVerified: Boolean(chainVerified),
    workItemId: normalizedWorkItemId,
    sessionId: normalizeString(sessionId) || null,
    date: dateKey,
    artifactDir: toRelativePosix(storage.outputRoot, artifactDir),
    artifacts: canonicalizeArtifactRecords(artifactFiles),
    sessionStream,
    cosignAttestationRef: normalizeString(cosignAttestationRef) || null,
    sbomRef: normalizeString(sbomRef) || null,
    evidenceLinks: normalizeStringArray(evidenceLinks).sort((left, right) =>
      left.localeCompare(right)
    ),
    anchorSha256,
  };
  await writeJsonFile(closeoutPath, payload);
  return {
    closeoutPath,
    payload,
    anchorSha256,
    artifactCount: payload.artifacts.length,
  };
}

export async function verifyArtifactChain({
  workItemId,
  date = "",
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const storage = await resolveArtifactLineageStorage({
    targetPath: normalizedTargetPath,
    outputDir,
    env,
    homeDir,
  });
  const dateKey = normalizeDateKey(date, new Date().toISOString());
  const artifactDir = resolveWorkItemArtifactDir(storage, normalizedWorkItemId, dateKey);
  const closeoutPath = path.join(artifactDir, "closeout.json");
  const closeout = await readJsonFile(closeoutPath, null);
  if (!closeout || typeof closeout !== "object") {
    throw new Error(`closeout.json was not found for work item '${normalizedWorkItemId}' on '${dateKey}'.`);
  }

  const mismatches = [];
  const artifacts = Array.isArray(closeout.artifacts) ? closeout.artifacts : [];
  for (const artifact of artifacts) {
    const expectedPath = normalizeString(artifact.path);
    const absolutePath = resolveArtifactAbsolutePath(storage, expectedPath);
    if (!absolutePath) {
      mismatches.push({
        type: "artifact_path_missing",
        path: expectedPath,
      });
      continue;
    }
    const buffer = await readFileBufferOptional(absolutePath);
    if (!buffer) {
      mismatches.push({
        type: "artifact_missing",
        path: expectedPath,
      });
      continue;
    }
    const actualSha256 = createHash("sha256").update(buffer).digest("hex");
    if (normalizeString(artifact.sha256).toLowerCase() !== actualSha256) {
      mismatches.push({
        type: "artifact_sha_mismatch",
        path: expectedPath,
        expected: normalizeString(artifact.sha256).toLowerCase(),
        actual: actualSha256,
      });
    }
  }

  let sessionStream = null;
  const sessionId = normalizeString(closeout.sessionId);
  if (sessionId) {
    sessionStream = await resolveSessionStreamDigest(sessionId, {
      targetPath: normalizedTargetPath,
    });
    if (closeout.sessionStream && sessionStream) {
      const expectedStreamSha = normalizeString(closeout.sessionStream.sha256).toLowerCase();
      if (expectedStreamSha !== normalizeString(sessionStream.sha256).toLowerCase()) {
        mismatches.push({
          type: "session_stream_sha_mismatch",
          path: normalizeString(closeout.sessionStream.path),
          expected: expectedStreamSha,
          actual: normalizeString(sessionStream.sha256).toLowerCase(),
        });
      }
    }
  }

  const recomputedAnchorPayload = buildCloseoutAnchorPayload({
    workItemId: normalizedWorkItemId,
    sessionId,
    date: closeout.date,
    artifacts,
    sessionStream: sessionStream || closeout.sessionStream || null,
    cosignAttestationRef: closeout.cosignAttestationRef,
    sbomRef: closeout.sbomRef,
    evidenceLinks: closeout.evidenceLinks,
  });
  const recomputedAnchorSha256 = computeAnchorSha256(recomputedAnchorPayload);
  if (normalizeString(closeout.anchorSha256).toLowerCase() !== recomputedAnchorSha256) {
    mismatches.push({
      type: "anchor_sha_mismatch",
      expected: normalizeString(closeout.anchorSha256).toLowerCase(),
      actual: recomputedAnchorSha256,
    });
  }

  return {
    valid: mismatches.length === 0,
    closeoutPath,
    workItemId: normalizedWorkItemId,
    date: normalizeDateKey(closeout.date, dateKey),
    mismatches,
    artifactCount: artifacts.length,
    anchorSha256: normalizeString(closeout.anchorSha256).toLowerCase(),
    recomputedAnchorSha256,
  };
}

async function writeJsonFile(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function appendJsonLine(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function readJsonFileOptional(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function readJsonFilesInDirectory(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(dirPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
    const parsed = await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        payload: await readJsonFileOptional(filePath),
      }))
    );
    return parsed.filter((entry) => entry.payload && typeof entry.payload === "object");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function createInitialLineageIndex(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    lineageRunId: null,
    summary: {
      totalQueueItems: 0,
      totalWorkItemsIndexed: 0,
      statusCounts: {},
      activeAgentCount: 0,
      jiraLinkedCount: 0,
      budgetGuardedCount: 0,
      operatorCoveredCount: 0,
    },
    daemonArtifacts: {
      queuePath: null,
      statePath: null,
      streamPath: null,
      assignmentLedgerPath: null,
      assignmentEventsPath: null,
      jiraLifecyclePath: null,
      jiraEventsPath: null,
      budgetStatePath: null,
      budgetEventsPath: null,
      operatorStatePath: null,
      operatorEventsPath: null,
    },
    runs: {
      errorDaemonRuns: [],
      budgetChecks: [],
      operatorSnapshots: [],
    },
    workItems: [],
  };
}

function normalizeStatusList(statuses = []) {
  if (!Array.isArray(statuses)) {
    return [];
  }
  return statuses
    .map((status) => normalizeString(status).toUpperCase())
    .filter(Boolean)
    .filter((status) => WORK_ITEM_STATUS_SET.has(status));
}

function createLineageRunId(nowIso) {
  return `lineage-${nowIso.replace(/[:.]/g, "-")}`;
}

function summarizeStatusCounts(workItems = []) {
  const statusCounts = {};
  for (const item of workItems) {
    const status = normalizeString(item.workItemStatus).toUpperCase() || "UNKNOWN";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  return statusCounts;
}

export async function resolveArtifactLineageStorage({
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
  const lineageDir = path.join(daemonStorage.baseDir, "lineage");
  return {
    ...daemonStorage,
    lineageDir,
    lineageIndexPath: path.join(lineageDir, "lineage-index.json"),
    lineageEventsPath: path.join(lineageDir, "lineage-events.ndjson"),
  };
}

export async function buildArtifactLineageIndex({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const storage = await resolveArtifactLineageStorage({
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
  const jiraStorage = await resolveJiraLifecycleStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const budgetStorage = await resolveBudgetGovernorStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const operatorStorage = await resolveOperatorControlStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });

  const [queue, assignments, issues, budgets, errorRuns, budgetRuns, operatorSnapshots] =
    await Promise.all([
      listErrorQueue({
        targetPath,
        outputDir,
        limit: 5000,
        env,
        homeDir,
      }),
      listAssignments({
        targetPath,
        outputDir,
        includeExpired: true,
        limit: 5000,
        env,
        homeDir,
        nowIso: normalizedNow,
      }),
      listJiraIssues({
        targetPath,
        outputDir,
        limit: 5000,
        env,
        homeDir,
        nowIso: normalizedNow,
      }),
      listBudgetStates({
        targetPath,
        outputDir,
        limit: 5000,
        env,
        homeDir,
        nowIso: normalizedNow,
      }),
      readJsonFilesInDirectory(storage.runsDir),
      readJsonFilesInDirectory(budgetStorage.budgetRunsDir),
      readJsonFilesInDirectory(operatorStorage.operatorSnapshotsDir),
    ]);

  const assignmentByWorkItem = new Map();
  for (const assignment of assignments.assignments) {
    if (!assignmentByWorkItem.has(assignment.workItemId)) {
      assignmentByWorkItem.set(assignment.workItemId, assignment);
    }
  }
  const issueByWorkItem = new Map();
  for (const issue of issues.issues) {
    if (!issueByWorkItem.has(issue.workItemId)) {
      issueByWorkItem.set(issue.workItemId, issue);
    }
  }
  const budgetByWorkItem = new Map();
  for (const record of budgets.records) {
    if (!budgetByWorkItem.has(record.workItemId)) {
      budgetByWorkItem.set(record.workItemId, record);
    }
  }

  const budgetRunsByWorkItem = new Map();
  for (const run of budgetRuns) {
    const workItemId = normalizeString(run.payload.workItemId);
    if (!workItemId) {
      continue;
    }
    if (!budgetRunsByWorkItem.has(workItemId)) {
      budgetRunsByWorkItem.set(workItemId, []);
    }
    budgetRunsByWorkItem.get(workItemId).push({
      runId: normalizeString(run.payload.runId) || path.basename(run.filePath, ".json"),
      generatedAt: normalizeIsoTimestamp(run.payload.generatedAt, normalizedNow),
      lifecycleState: normalizeString(run.payload.lifecycleState) || "WITHIN_BUDGET",
      action: normalizeString(run.payload.action) || "NONE",
      path: toRelativePosix(storage.outputRoot, run.filePath),
    });
  }

  const operatorSnapshotsByWorkItem = new Map();
  const operatorSnapshotSummaries = [];
  for (const snapshot of operatorSnapshots) {
    const runId = normalizeString(snapshot.payload.runId) || path.basename(snapshot.filePath, ".json");
    const generatedAt = normalizeIsoTimestamp(snapshot.payload.generatedAt, normalizedNow);
    const workItems = Array.isArray(snapshot.payload.workItems) ? snapshot.payload.workItems : [];
    operatorSnapshotSummaries.push({
      runId,
      generatedAt,
      path: toRelativePosix(storage.outputRoot, snapshot.filePath),
      visibleWorkItems: workItems.length,
    });
    for (const workItem of workItems) {
      const workItemId = normalizeString(workItem.workItemId);
      if (!workItemId) {
        continue;
      }
      if (!operatorSnapshotsByWorkItem.has(workItemId)) {
        operatorSnapshotsByWorkItem.set(workItemId, []);
      }
      operatorSnapshotsByWorkItem.get(workItemId).push({
        runId,
        generatedAt,
        path: toRelativePosix(storage.outputRoot, snapshot.filePath),
        budgetHealthColor: getBudgetHealthColor(workItem.budgetHealthColor),
        assignmentStatus: normalizeString(workItem.assignmentStatus) || "QUEUED",
        workItemStatus: normalizeString(workItem.workItemStatus) || "QUEUED",
      });
    }
  }

  const workItems = queue.items.map((queueItem) => {
    const assignment = assignmentByWorkItem.get(queueItem.workItemId) || null;
    const issue = issueByWorkItem.get(queueItem.workItemId) || null;
    const budget = budgetByWorkItem.get(queueItem.workItemId) || null;
    const budgetRunsForItem = budgetRunsByWorkItem.get(queueItem.workItemId) || [];
    const operatorSnapshotsForItem = operatorSnapshotsByWorkItem.get(queueItem.workItemId) || [];
    return {
      workItemId: queueItem.workItemId,
      workItemStatus: queueItem.status,
      severity: queueItem.severity,
      service: queueItem.service,
      endpoint: queueItem.endpoint,
      errorCode: queueItem.errorCode,
      message: queueItem.message,
      firstSeenAt: queueItem.firstSeenAt,
      lastSeenAt: queueItem.lastSeenAt,
      links: {
        sessionId: assignment?.sessionId || null,
        agentIdentity: assignment?.assignedAgentIdentity || null,
        assignmentStatus: assignment?.status || null,
        assignmentStage: assignment?.stage || null,
        loopRunId: assignment?.runId || null,
        jiraIssueKey: issue?.issueKey || null,
        jiraStatus: issue?.status || null,
        budgetLifecycleState: budget?.lifecycleState || "WITHIN_BUDGET",
        budgetHealthColor: getBudgetHealthColor(budget?.lifecycleState || "WITHIN_BUDGET"),
        latestOperatorSnapshotRunId: operatorSnapshotsForItem.length > 0
          ? operatorSnapshotsForItem[0].runId
          : null,
      },
      artifacts: {
        queuePath: toRelativePosix(storage.outputRoot, storage.queuePath),
        assignmentLedgerPath: toRelativePosix(storage.outputRoot, assignmentStorage.ledgerPath),
        jiraLifecyclePath: toRelativePosix(storage.outputRoot, jiraStorage.lifecyclePath),
        budgetStatePath: toRelativePosix(storage.outputRoot, budgetStorage.budgetStatePath),
        operatorStatePath: toRelativePosix(storage.outputRoot, operatorStorage.operatorStatePath),
        budgetRuns: budgetRunsForItem,
        operatorSnapshots: operatorSnapshotsForItem,
      },
      updatedAt: queueItem.updatedAt,
    };
  });

  await Promise.all(
    workItems.map(async (workItem) => {
      const closeout = await writeCloseoutArtifact({
        workItemId: workItem.workItemId,
        sessionId: normalizeString(workItem.links.sessionId),
        date: buildDayKey(normalizedNow),
        targetPath,
        outputDir,
        env,
        homeDir,
        nowIso: normalizedNow,
      });
      workItem.artifacts.closeoutPath = toRelativePosix(storage.outputRoot, closeout.closeoutPath);
      workItem.artifacts.closeoutAnchorSha256 = closeout.anchorSha256;
    })
  );

  const lineageRunId = createLineageRunId(normalizedNow);
  const statusCounts = summarizeStatusCounts(workItems);
  const linkedAgentIdentities = new Set(
    workItems.map((item) => normalizeString(item.links.agentIdentity)).filter(Boolean)
  );
  const jiraLinkedCount = workItems.filter((item) => Boolean(item.links.jiraIssueKey)).length;
  const budgetGuardedCount = workItems.filter((item) => item.links.budgetLifecycleState !== "WITHIN_BUDGET").length;
  const operatorCoveredCount = workItems.filter(
    (item) => Array.isArray(item.artifacts.operatorSnapshots) && item.artifacts.operatorSnapshots.length > 0
  ).length;

  const index = {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    generatedAt: normalizedNow,
    lineageRunId,
    summary: {
      totalQueueItems: queue.totalCount,
      totalWorkItemsIndexed: workItems.length,
      statusCounts,
      activeAgentCount: linkedAgentIdentities.size,
      jiraLinkedCount,
      budgetGuardedCount,
      operatorCoveredCount,
    },
    daemonArtifacts: {
      queuePath: toRelativePosix(storage.outputRoot, storage.queuePath),
      statePath: toRelativePosix(storage.outputRoot, storage.statePath),
      streamPath: toRelativePosix(storage.outputRoot, storage.streamPath),
      assignmentLedgerPath: toRelativePosix(storage.outputRoot, assignmentStorage.ledgerPath),
      assignmentEventsPath: toRelativePosix(storage.outputRoot, assignmentStorage.eventsPath),
      jiraLifecyclePath: toRelativePosix(storage.outputRoot, jiraStorage.lifecyclePath),
      jiraEventsPath: toRelativePosix(storage.outputRoot, jiraStorage.eventsPath),
      budgetStatePath: toRelativePosix(storage.outputRoot, budgetStorage.budgetStatePath),
      budgetEventsPath: toRelativePosix(storage.outputRoot, budgetStorage.budgetEventsPath),
      operatorStatePath: toRelativePosix(storage.outputRoot, operatorStorage.operatorStatePath),
      operatorEventsPath: toRelativePosix(storage.outputRoot, operatorStorage.operatorEventsPath),
    },
    runs: {
      errorDaemonRuns: errorRuns
        .map((run) => ({
          runId: normalizeString(run.payload.runId) || path.basename(run.filePath, ".json"),
          generatedAt: normalizeIsoTimestamp(run.payload.generatedAt, normalizedNow),
          startOffset: Number(run.payload.startOffset || 0),
          endOffset: Number(run.payload.endOffset || 0),
          queueDepth: Number(run.payload.queueDepth || 0),
          path: toRelativePosix(storage.outputRoot, run.filePath),
        }))
        .sort((left, right) => (Date.parse(String(right.generatedAt || "")) || 0) - (Date.parse(String(left.generatedAt || "")) || 0)),
      budgetChecks: budgetRuns
        .map((run) => ({
          runId: normalizeString(run.payload.runId) || path.basename(run.filePath, ".json"),
          generatedAt: normalizeIsoTimestamp(run.payload.generatedAt, normalizedNow),
          workItemId: normalizeString(run.payload.workItemId) || null,
          action: normalizeString(run.payload.action) || "NONE",
          lifecycleState: normalizeString(run.payload.lifecycleState) || "WITHIN_BUDGET",
          path: toRelativePosix(storage.outputRoot, run.filePath),
        }))
        .sort((left, right) => (Date.parse(String(right.generatedAt || "")) || 0) - (Date.parse(String(left.generatedAt || "")) || 0)),
      operatorSnapshots: operatorSnapshotSummaries.sort(
        (left, right) =>
          (Date.parse(String(right.generatedAt || "")) || 0) - (Date.parse(String(left.generatedAt || "")) || 0)
      ),
    },
    workItems,
  };

  await Promise.all([
    writeJsonFile(storage.lineageIndexPath, index),
    appendJsonLine(storage.lineageEventsPath, {
      timestamp: normalizedNow,
      eventType: "lineage_build",
      lineageRunId,
      totalWorkItemsIndexed: workItems.length,
      statusCounts,
      jiraLinkedCount,
      budgetGuardedCount,
      operatorCoveredCount,
    }),
  ]);

  return {
    ...storage,
    lineageRunId,
    indexPath: storage.lineageIndexPath,
    eventPath: storage.lineageEventsPath,
    summary: index.summary,
    workItems: index.workItems,
    index,
  };
}

export async function listArtifactLineage({
  targetPath = ".",
  outputDir = "",
  statuses = [],
  workItemId = "",
  limit = 50,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedLimit = normalizePositiveInteger(limit, "limit", 50);
  const normalizedStatuses = new Set(normalizeStatusList(statuses));
  const normalizedWorkItemId = normalizeString(workItemId);
  const storage = await resolveArtifactLineageStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  let index = await readJsonFile(storage.lineageIndexPath, null);
  if (!index) {
    const built = await buildArtifactLineageIndex({
      targetPath,
      outputDir,
      env,
      homeDir,
      nowIso: normalizedNow,
    });
    index = built.index;
  }
  const normalizedIndex = {
    ...createInitialLineageIndex(normalizedNow),
    ...(index && typeof index === "object" ? index : {}),
  };
  const filtered = (Array.isArray(normalizedIndex.workItems) ? normalizedIndex.workItems : []).filter(
    (item) => {
      if (
        normalizedStatuses.size > 0 &&
        !normalizedStatuses.has(normalizeString(item.workItemStatus).toUpperCase())
      ) {
        return false;
      }
      if (normalizedWorkItemId && normalizeString(item.workItemId) !== normalizedWorkItemId) {
        return false;
      }
      return true;
    }
  );
  const sorted = [...filtered].sort((left, right) => {
    const leftEpoch = Date.parse(String(left.updatedAt || left.lastSeenAt || "")) || 0;
    const rightEpoch = Date.parse(String(right.updatedAt || right.lastSeenAt || "")) || 0;
    return rightEpoch - leftEpoch;
  });
  return {
    ...storage,
    generatedAt: normalizeIsoTimestamp(normalizedIndex.generatedAt, normalizedNow),
    lineageRunId: normalizeString(normalizedIndex.lineageRunId) || null,
    summary:
      normalizedIndex.summary && typeof normalizedIndex.summary === "object"
        ? normalizedIndex.summary
        : createInitialLineageIndex(normalizedNow).summary,
    totalCount: Array.isArray(normalizedIndex.workItems) ? normalizedIndex.workItems.length : 0,
    visibleCount: sorted.length,
    workItems: sorted.slice(0, normalizedLimit),
    runs:
      normalizedIndex.runs && typeof normalizedIndex.runs === "object"
        ? normalizedIndex.runs
        : createInitialLineageIndex(normalizedNow).runs,
  };
}
