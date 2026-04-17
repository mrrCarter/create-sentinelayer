import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadCostHistory } from "../cost/history.js";
import { resolveOutputRoot } from "../config/service.js";
import { loadRunEvents } from "../telemetry/ledger.js";
import { resolveSessionPaths } from "./paths.js";
import { readStream } from "./stream.js";

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

function normalizeNonNegativeNumber(value, fallbackValue = 0) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallbackValue;
  }
  return normalized;
}

function normalizeRate(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(normalized.toFixed(4))));
}

function normalizeSessionMetadata(raw = {}, nowIso = new Date().toISOString()) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    sessionId: normalizeString(source.sessionId),
    createdAt: normalizeIsoTimestamp(source.createdAt, nowIso),
    lastInteractionAt: normalizeIsoTimestamp(source.lastInteractionAt, nowIso),
    renewalCount: Math.max(0, Number(source.renewalCount || 0)),
  };
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

function toEpoch(value, fallbackIso = new Date().toISOString()) {
  return Date.parse(normalizeIsoTimestamp(value, fallbackIso)) || 0;
}

function buildInitialFindingsSummary() {
  return {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
}

function incrementFinding(summary, severity) {
  const normalized = normalizeString(severity).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(summary, normalized)) {
    return;
  }
  summary[normalized] += 1;
}

function extractFindingSeverity(message = "") {
  const normalized = normalizeString(message);
  if (!normalized) {
    return "";
  }
  const findingMatch = /finding\s*:\s*\[(P[0-3])\]/i.exec(normalized);
  if (findingMatch) {
    return normalizeString(findingMatch[1]).toUpperCase();
  }
  const bracketSeverityMatch = /\[(P[0-3])\]/i.exec(normalized);
  if (bracketSeverityMatch) {
    return normalizeString(bracketSeverityMatch[1]).toUpperCase();
  }
  return "";
}

function summarizeResponseLatencyMs(events = []) {
  const messageEvents = events
    .filter((event) => normalizeString(event.event) === "session_message")
    .sort((left, right) => toEpoch(left.ts) - toEpoch(right.ts));
  if (messageEvents.length < 2) {
    return 0;
  }
  const deltas = [];
  for (let index = 1; index < messageEvents.length; index += 1) {
    const previous = messageEvents[index - 1];
    const current = messageEvents[index];
    const previousAgent = normalizeString(previous.agent?.id || previous.agentId);
    const currentAgent = normalizeString(current.agent?.id || current.agentId);
    if (!previousAgent || !currentAgent || previousAgent === currentAgent) {
      continue;
    }
    const deltaMs = toEpoch(current.ts) - toEpoch(previous.ts);
    if (Number.isFinite(deltaMs) && deltaMs >= 0) {
      deltas.push(deltaMs);
    }
  }
  if (deltas.length === 0) {
    return 0;
  }
  const sum = deltas.reduce((accumulator, value) => accumulator + value, 0);
  return Math.round(sum / deltas.length);
}

function summarizeTaskMetrics(events = [], registryTasks = []) {
  const taskAssignedEvents = events.filter((event) => normalizeString(event.event) === "task_assign");
  const taskCompletedEvents = events.filter((event) => normalizeString(event.event) === "task_completed");
  const fallbackAssignedCount = Array.isArray(registryTasks) ? registryTasks.length : 0;
  const fallbackCompletedCount = Array.isArray(registryTasks)
    ? registryTasks.filter((task) => normalizeString(task.status).toUpperCase() === "COMPLETED").length
    : 0;

  const tasksAssigned = Math.max(taskAssignedEvents.length, fallbackAssignedCount);
  const tasksCompleted = Math.max(taskCompletedEvents.length, fallbackCompletedCount);

  let handoffsSuccessful = 0;
  for (const event of taskCompletedEvents) {
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const fromAgent = normalizeString(payload.from);
    const toAgent = normalizeString(payload.to);
    if (fromAgent && toAgent && fromAgent !== toAgent) {
      handoffsSuccessful += 1;
    }
  }
  if (handoffsSuccessful === 0 && Array.isArray(registryTasks)) {
    handoffsSuccessful = registryTasks.filter((task) => {
      const fromAgent = normalizeString(task.fromAgentId);
      const toAgent = normalizeString(task.toAgentId);
      const status = normalizeString(task.status).toUpperCase();
      return status === "COMPLETED" && fromAgent && toAgent && fromAgent !== toAgent;
    }).length;
  }

  return {
    tasksAssigned,
    tasksCompleted,
    handoffsSuccessful,
  };
}

function summarizeHitlMetrics(events = []) {
  const hitlEvents = events.filter((event) => {
    const eventName = normalizeString(event.event).toLowerCase();
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const channel = normalizeString(payload.channel).toLowerCase();
    return eventName.includes("hitl") || channel === "hitl";
  });

  let humanOverrides = 0;
  let disagreements = 0;
  for (const event of hitlEvents) {
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const verdict = normalizeString(payload.verdict || payload.action).toLowerCase();
    const humanVerdict = normalizeString(payload.humanVerdict).toLowerCase();
    const modelVerdict = normalizeString(payload.modelVerdict).toLowerCase();
    if (
      payload.override === true ||
      verdict === "override" ||
      verdict === "reject" ||
      verdict === "escalate"
    ) {
      humanOverrides += 1;
    }
    if (
      payload.disagreement === true ||
      (humanVerdict && modelVerdict && humanVerdict !== modelVerdict)
    ) {
      disagreements += 1;
    }
  }

  const denominator = hitlEvents.length;
  return {
    humanOverrideRate: denominator > 0 ? humanOverrides / denominator : 0,
    hitlDisagreementRate: denominator > 0 ? disagreements / denominator : 0,
  };
}

function summarizeEvalRegressionRate(events = []) {
  const evalEvents = events.filter((event) => normalizeString(event.event).toLowerCase().includes("eval"));
  if (evalEvents.length === 0) {
    return 0;
  }
  const regressions = evalEvents.filter((event) => {
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    if (payload.regression === true) {
      return true;
    }
    const status = normalizeString(payload.status || payload.result).toLowerCase();
    return status.includes("regress");
  }).length;
  return regressions / evalEvents.length;
}

async function walkDirectory(filePath, visitor) {
  let entries = [];
  try {
    entries = await fsp.readdir(filePath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(filePath, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(entryPath, visitor);
      continue;
    }
    if (entry.isFile()) {
      await visitor(entryPath);
    }
  }
}

async function loadCloseoutArtifactsForSession({
  targetPath,
  outputDir = "",
  env,
  homeDir,
  sessionId,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(String(targetPath || ".")),
    outputDirOverride: outputDir,
    env,
    homeDir,
  });
  const observabilityRoot = path.join(outputRoot, "observability");
  const closeouts = [];

  await walkDirectory(observabilityRoot, async (candidatePath) => {
    if (path.basename(candidatePath).toLowerCase() !== "closeout.json") {
      return;
    }
    const payload = await readJsonFileOptional(candidatePath);
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (normalizeString(payload.sessionId) !== normalizeString(sessionId)) {
      return;
    }
    closeouts.push(payload);
  });

  return closeouts;
}

function summarizeProvenanceCoverage(closeouts = []) {
  if (!Array.isArray(closeouts) || closeouts.length === 0) {
    return {
      reproducibilitySuccessRate: 1,
      provenanceAttestationCoverage: 0,
    };
  }
  const reproducibleCount = closeouts.filter((closeout) => closeout.chainVerified !== false).length;
  const attestedCount = closeouts.filter((closeout) => {
    const hasCosignRef = Boolean(normalizeString(closeout.cosignAttestationRef));
    const hasSbomRef = Boolean(normalizeString(closeout.sbomRef));
    return hasCosignRef || hasSbomRef;
  }).length;
  return {
    reproducibilitySuccessRate: reproducibleCount / closeouts.length,
    provenanceAttestationCoverage: attestedCount / closeouts.length,
  };
}

function summarizeCostFromStream(events = []) {
  return events.reduce((sum, event) => {
    if (normalizeString(event.event) !== "model_span") {
      return sum;
    }
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    return sum + normalizeNonNegativeNumber(payload.costUsd, 0);
  }, 0);
}

export async function computeSessionAnalytics(
  sessionId,
  {
    targetPath = process.cwd(),
    outputDir = "",
    env,
    homeDir,
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }

  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const paths = resolveSessionPaths(normalizedSessionId, {
    targetPath: normalizedTargetPath,
  });
  const rawMetadata = await readJsonFileOptional(paths.metadataPath);
  if (!rawMetadata || typeof rawMetadata !== "object") {
    throw new Error(`Session '${normalizedSessionId}' was not found.`);
  }

  const metadata = normalizeSessionMetadata(rawMetadata, nowIso);
  const [events, rawTaskRegistry, costHistoryResult, runEventsResult, closeouts] = await Promise.all([
    readStream(normalizedSessionId, {
      targetPath: normalizedTargetPath,
      tail: 0,
    }),
    readJsonFileOptional(paths.tasksPath),
    loadCostHistory({
      targetPath: normalizedTargetPath,
      outputDirOverride: outputDir,
      env,
      homeDir,
    }),
    loadRunEvents({
      targetPath: normalizedTargetPath,
      outputDirOverride: outputDir,
      env,
      homeDir,
    }),
    loadCloseoutArtifactsForSession({
      targetPath: normalizedTargetPath,
      outputDir,
      env,
      homeDir,
      sessionId: normalizedSessionId,
    }),
  ]);

  const normalizedEvents = Array.isArray(events) ? events : [];
  const findingSummary = buildInitialFindingsSummary();
  const uniqueAgents = new Set();
  let totalMessages = 0;
  let fileLockDeniedCount = 0;
  let fileLockEvents = 0;
  let stuckRecoveries = 0;
  let productiveEvents = 0;
  let idleEvents = 0;

  for (const event of normalizedEvents) {
    const eventName = normalizeString(event.event);
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const agentId = normalizeString(event.agent?.id || event.agentId);
    if (agentId) {
      uniqueAgents.add(agentId);
    }

    if (eventName === "session_message") {
      totalMessages += 1;
      productiveEvents += 1;
      incrementFinding(findingSummary, extractFindingSeverity(payload.message));
      continue;
    }

    if (eventName === "task_assign" || eventName === "task_accepted" || eventName === "task_completed") {
      productiveEvents += 1;
      continue;
    }

    if (eventName === "file_lock" || eventName === "file_unlock") {
      fileLockEvents += eventName === "file_lock" ? 1 : 0;
      productiveEvents += 1;
      continue;
    }

    if (eventName === "help_response" || eventName === "runtime_run_heartbeat") {
      productiveEvents += 1;
      continue;
    }

    if (eventName === "daemon_alert") {
      const alert = normalizeString(payload.alert).toLowerCase();
      if (alert === "file_lock_denied") {
        fileLockDeniedCount += 1;
        productiveEvents += 1;
        continue;
      }
      if (alert === "stuck_recovered") {
        stuckRecoveries += 1;
        productiveEvents += 1;
        continue;
      }
      if (alert === "stuck_detected") {
        idleEvents += 1;
        continue;
      }
    }
  }

  const registryTasks =
    rawTaskRegistry &&
    typeof rawTaskRegistry === "object" &&
    Array.isArray(rawTaskRegistry.tasks)
      ? rawTaskRegistry.tasks
      : [];
  const taskMetrics = summarizeTaskMetrics(normalizedEvents, registryTasks);
  const hitlMetrics = summarizeHitlMetrics(normalizedEvents);
  const provenanceMetrics = summarizeProvenanceCoverage(closeouts);

  const streamCostUsd = summarizeCostFromStream(normalizedEvents);
  const historyEntries = Array.isArray(costHistoryResult?.history?.entries)
    ? costHistoryResult.history.entries
    : [];
  const costHistoryUsd = historyEntries
    .filter((entry) => normalizeString(entry.sessionId) === normalizedSessionId)
    .reduce((sum, entry) => sum + normalizeNonNegativeNumber(entry.costUsd, 0), 0);
  const runEvents = Array.isArray(runEventsResult?.events) ? runEventsResult.events : [];
  const telemetryCostUsd = runEvents
    .filter((event) => normalizeString(event.sessionId) === normalizedSessionId)
    .filter((event) => normalizeString(event.eventType) === "usage")
    .reduce((sum, event) => {
      const usage = event && typeof event.usage === "object" ? event.usage : {};
      return sum + normalizeNonNegativeNumber(usage.costUsd, 0);
    }, 0);
  const totalCostUsd = Number(
    Math.max(streamCostUsd, costHistoryUsd, telemetryCostUsd).toFixed(6)
  );

  const denominator = productiveEvents + idleEvents;
  const coordinationEfficiency = denominator > 0 ? productiveEvents / denominator : 0;
  const createdEpoch = toEpoch(metadata.createdAt, nowIso);
  const terminalIso = normalizeIsoTimestamp(
    metadata.lastInteractionAt || nowIso,
    nowIso
  );
  const terminalEpoch = Math.max(toEpoch(terminalIso, nowIso), createdEpoch);
  const elapsedHours = Number(((terminalEpoch - createdEpoch) / (60 * 60 * 1000)).toFixed(4));

  const fixPlanUsefulnessScore =
    taskMetrics.tasksAssigned > 0 ? taskMetrics.tasksCompleted / taskMetrics.tasksAssigned : 0;

  return {
    totalMessages,
    uniqueAgents: uniqueAgents.size,
    totalFindings: findingSummary,
    conflictsPrevented: fileLockDeniedCount + fileLockEvents,
    tasksAssigned: taskMetrics.tasksAssigned,
    tasksCompleted: taskMetrics.tasksCompleted,
    handoffsSuccessful: taskMetrics.handoffsSuccessful,
    avgResponseTimeMs: summarizeResponseLatencyMs(normalizedEvents),
    stuckRecoveries,
    totalCostUsd,
    coordinationEfficiency: normalizeRate(coordinationEfficiency),
    elapsedHours: Math.max(0, elapsedHours),
    renewalCount: metadata.renewalCount,
    humanOverrideRate: normalizeRate(hitlMetrics.humanOverrideRate),
    hitlDisagreementRate: normalizeRate(hitlMetrics.hitlDisagreementRate),
    reproducibilitySuccessRate: normalizeRate(provenanceMetrics.reproducibilitySuccessRate),
    fixPlanUsefulnessScore: normalizeRate(fixPlanUsefulnessScore),
    evalRegressionRate: normalizeRate(summarizeEvalRegressionRate(normalizedEvents)),
    provenanceAttestationCoverage: normalizeRate(provenanceMetrics.provenanceAttestationCoverage),
  };
}
