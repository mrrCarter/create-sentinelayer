const SCORE_MODEL_VERSION = "1.0.0";
const RESPONSE_TIME_HALF_LIFE_MS = 60_000;
const FINDINGS_PER_DOLLAR_CAP = 10;

const SCORE_WEIGHTS = Object.freeze({
  findingsPerDollar: 0.2,
  avgResponseTime: 0.15,
  taskCompletionRate: 0.25,
  conflictsCreated: 0.1,
  stuckCount: 0.1,
  reviewAccuracy: 0.2,
});

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeNonNegativeNumber(value, fallbackValue = 0) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallbackValue;
  }
  return normalized;
}

function normalizeRate(value, fallbackValue = 0) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return fallbackValue;
  }
  return Math.max(0, Math.min(1, normalized));
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

function parseEpoch(value, fallbackIso = new Date().toISOString()) {
  return Date.parse(normalizeIsoTimestamp(value, fallbackIso)) || 0;
}

function parseFindingCountFromMessage(message = "") {
  const normalized = normalizeString(message);
  if (!normalized) {
    return 0;
  }
  if (/\bfinding\s*:\s*\[(P[0-3])\]/i.test(normalized)) {
    return 1;
  }
  if (/\[(P[0-3])\]/i.test(normalized)) {
    return 1;
  }
  return 0;
}

function parseHitlTruth(payload = {}) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (typeof payload.truth === "boolean") {
    return payload.truth;
  }
  if (typeof payload.truthVerdict === "boolean") {
    return payload.truthVerdict;
  }
  const normalized = normalizeString(
    payload.truthVerdict || payload.truth || payload.verdict || payload.outcome || payload.action
  ).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "confirmed" || normalized === "valid" || normalized === "true" || normalized === "accept") {
    return true;
  }
  if (
    normalized === "rejected" ||
    normalized === "invalid" ||
    normalized === "false" ||
    normalized === "dismissed" ||
    normalized === "overturned"
  ) {
    return false;
  }
  return null;
}

function isHitlEvent(eventName = "", payload = {}) {
  const normalizedEvent = normalizeString(eventName).toLowerCase();
  if (normalizedEvent.includes("hitl")) {
    return true;
  }
  const channel = normalizeString(payload.channel).toLowerCase();
  if (channel === "hitl") {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(payload, "truth") || Object.prototype.hasOwnProperty.call(payload, "truthVerdict");
}

function ensureMetricsRecord(metricsByAgent, agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    return null;
  }
  if (!metricsByAgent.has(normalizedAgentId)) {
    metricsByAgent.set(normalizedAgentId, {
      agentId: normalizedAgentId,
      findings: 0,
      costUsd: 0,
      responseSamples: [],
      avgResponseTimeMs: 0,
      tasksAssigned: 0,
      tasksCompleted: 0,
      fileConflicts: 0,
      stuckDetections: 0,
      findingsConfirmed: 0,
      findingsTotal: 0,
      activeAssignments: 0,
    });
  }
  return metricsByAgent.get(normalizedAgentId);
}

function finalizeMetrics(raw = {}) {
  const tasksAssigned = normalizeNonNegativeNumber(raw.tasksAssigned, 0);
  const tasksCompleted = normalizeNonNegativeNumber(raw.tasksCompleted, 0);
  const responseSamples = Array.isArray(raw.responseSamples) ? raw.responseSamples : [];
  const responseTotal = responseSamples.reduce((sum, value) => sum + normalizeNonNegativeNumber(value, 0), 0);
  const avgResponseTimeMs = responseSamples.length > 0 ? Math.round(responseTotal / responseSamples.length) : 0;
  return {
    agentId: normalizeString(raw.agentId),
    findings: normalizeNonNegativeNumber(raw.findings, 0),
    costUsd: normalizeNonNegativeNumber(raw.costUsd, 0),
    avgResponseTimeMs,
    tasksAssigned,
    tasksCompleted: Math.min(tasksCompleted, tasksAssigned || tasksCompleted),
    fileConflicts: normalizeNonNegativeNumber(raw.fileConflicts, 0),
    stuckDetections: normalizeNonNegativeNumber(raw.stuckDetections, 0),
    findingsConfirmed: normalizeNonNegativeNumber(raw.findingsConfirmed, 0),
    findingsTotal: normalizeNonNegativeNumber(raw.findingsTotal, 0),
    activeAssignments: normalizeNonNegativeNumber(raw.activeAssignments, 0),
  };
}

function toMetricsObject(metricsByAgent) {
  const output = {};
  for (const [agentId, metrics] of metricsByAgent.entries()) {
    output[agentId] = finalizeMetrics(metrics);
  }
  return output;
}

function buildEmptyScore(agentId = "") {
  return {
    scoreModelVersion: SCORE_MODEL_VERSION,
    agentId: normalizeString(agentId),
    findingsPerDollar: 0,
    avgResponseTimeMs: 0,
    taskCompletionRate: 0,
    conflictsCreated: 0,
    stuckCount: 0,
    reviewAccuracy: 0.5,
    overallScore: 0,
  };
}

function scoreFindingsPerDollar(value) {
  const normalized = normalizeNonNegativeNumber(value, 0);
  if (normalized <= 0) {
    return 0;
  }
  return normalizeRate(normalized / FINDINGS_PER_DOLLAR_CAP, 0);
}

function scoreResponseTime(avgResponseTimeMs) {
  const normalized = normalizeNonNegativeNumber(avgResponseTimeMs, 0);
  if (normalized <= 0) {
    return 1;
  }
  const score = 1 / (1 + normalized / RESPONSE_TIME_HALF_LIFE_MS);
  return normalizeRate(score, 0);
}

function scorePenaltyCount(count) {
  const normalized = normalizeNonNegativeNumber(count, 0);
  return normalizeRate(1 / (1 + normalized), 0);
}

function computeOverallScore(components = {}) {
  return normalizeRate(
    components.findingsPerDollar * SCORE_WEIGHTS.findingsPerDollar +
      components.avgResponseTime * SCORE_WEIGHTS.avgResponseTime +
      components.taskCompletionRate * SCORE_WEIGHTS.taskCompletionRate +
      components.conflictsCreated * SCORE_WEIGHTS.conflictsCreated +
      components.stuckCount * SCORE_WEIGHTS.stuckCount +
      components.reviewAccuracy * SCORE_WEIGHTS.reviewAccuracy,
    0
  );
}

function normalizeAgentMetrics(raw = {}) {
  const tasksAssigned = normalizeNonNegativeNumber(raw.tasksAssigned, 0);
  const tasksCompleted = normalizeNonNegativeNumber(raw.tasksCompleted, 0);
  const findingsTotal = normalizeNonNegativeNumber(raw.findingsTotal, 0);
  const findingsConfirmed = normalizeNonNegativeNumber(raw.findingsConfirmed, 0);
  return {
    findings: normalizeNonNegativeNumber(raw.findings, 0),
    costUsd: normalizeNonNegativeNumber(raw.costUsd, 0),
    avgResponseTimeMs: normalizeNonNegativeNumber(raw.avgResponseTimeMs, 0),
    tasksAssigned,
    tasksCompleted: Math.min(tasksCompleted, tasksAssigned || tasksCompleted),
    fileConflicts: normalizeNonNegativeNumber(raw.fileConflicts, 0),
    stuckDetections: normalizeNonNegativeNumber(raw.stuckDetections, 0),
    findingsTotal,
    findingsConfirmed: Math.min(findingsConfirmed, findingsTotal || findingsConfirmed),
  };
}

function computeAgentScore(agentId, sessionAnalytics = {}) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    return buildEmptyScore(agentId);
  }
  const metrics = normalizeAgentMetrics(sessionAnalytics);
  const findingsPerDollar = metrics.findings / Math.max(metrics.costUsd, 0.01);
  const taskCompletionRate =
    metrics.tasksAssigned > 0 ? metrics.tasksCompleted / metrics.tasksAssigned : 0;
  const reviewAccuracy =
    metrics.findingsTotal > 0 ? metrics.findingsConfirmed / metrics.findingsTotal : 0.5;

  const scoreComponents = {
    findingsPerDollar: scoreFindingsPerDollar(findingsPerDollar),
    avgResponseTime: scoreResponseTime(metrics.avgResponseTimeMs),
    taskCompletionRate: normalizeRate(taskCompletionRate, 0),
    conflictsCreated: scorePenaltyCount(metrics.fileConflicts),
    stuckCount: scorePenaltyCount(metrics.stuckDetections),
    reviewAccuracy: normalizeRate(reviewAccuracy, 0.5),
  };
  const overallScore = computeOverallScore(scoreComponents);

  return {
    scoreModelVersion: SCORE_MODEL_VERSION,
    agentId: normalizedAgentId,
    findingsPerDollar: Number(findingsPerDollar.toFixed(4)),
    avgResponseTimeMs: Math.round(metrics.avgResponseTimeMs),
    taskCompletionRate: Number(normalizeRate(taskCompletionRate, 0).toFixed(4)),
    conflictsCreated: metrics.fileConflicts,
    stuckCount: metrics.stuckDetections,
    reviewAccuracy: Number(normalizeRate(reviewAccuracy, 0.5).toFixed(4)),
    overallScore: Number(overallScore.toFixed(4)),
  };
}

function buildAgentAnalyticsSnapshot({
  events = [],
  tasks = [],
  activeAssignments = [],
  nowIso = new Date().toISOString(),
} = {}) {
  const metricsByAgent = new Map();
  const normalizedEvents = Array.isArray(events) ? [...events] : [];
  normalizedEvents.sort((left, right) => parseEpoch(left?.ts, nowIso) - parseEpoch(right?.ts, nowIso));

  let previousMessage = null;
  for (const event of normalizedEvents) {
    const eventName = normalizeString(event?.event);
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const eventAgentId =
      normalizeString(event?.agent?.id || event?.agentId || payload.agentId || payload.reviewerId) || null;

    if (eventName === "session_message") {
      const messageAgent = eventAgentId;
      if (messageAgent) {
        const metrics = ensureMetricsRecord(metricsByAgent, messageAgent);
        if (metrics) {
          metrics.findings += parseFindingCountFromMessage(payload.message || "");
          if (previousMessage && normalizeString(previousMessage.agentId) !== messageAgent) {
            const deltaMs = parseEpoch(event?.ts, nowIso) - parseEpoch(previousMessage.ts, nowIso);
            if (Number.isFinite(deltaMs) && deltaMs >= 0) {
              metrics.responseSamples.push(deltaMs);
            }
          }
        }
      }
      previousMessage = {
        agentId: messageAgent,
        ts: normalizeIsoTimestamp(event?.ts, nowIso),
      };
      continue;
    }

    if (eventName === "model_span" && eventAgentId) {
      const metrics = ensureMetricsRecord(metricsByAgent, eventAgentId);
      if (metrics) {
        metrics.costUsd += normalizeNonNegativeNumber(payload.costUsd, 0);
      }
    }

    if (eventName === "daemon_alert") {
      const alert = normalizeString(payload.alert).toLowerCase();
      if (alert === "file_conflict") {
        const agentA = normalizeString(payload.agentA);
        const agentB = normalizeString(payload.agentB);
        const metricsA = ensureMetricsRecord(metricsByAgent, agentA);
        const metricsB = ensureMetricsRecord(metricsByAgent, agentB);
        if (metricsA) {
          metricsA.fileConflicts += 1;
        }
        if (metricsB) {
          metricsB.fileConflicts += 1;
        }
      }
      if (alert === "stuck_detected") {
        const stuckAgent = normalizeString(payload.agentId || payload.target);
        const metrics = ensureMetricsRecord(metricsByAgent, stuckAgent);
        if (metrics) {
          metrics.stuckDetections += 1;
        }
      }
    }

    if (isHitlEvent(eventName, payload)) {
      const reviewerId =
        normalizeString(payload.reviewerId || payload.agentId || eventAgentId);
      const truth = parseHitlTruth(payload);
      const metrics = ensureMetricsRecord(metricsByAgent, reviewerId);
      if (metrics && truth !== null) {
        metrics.findingsTotal += 1;
        if (truth) {
          metrics.findingsConfirmed += 1;
        }
      }
    }
  }

  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  for (const task of normalizedTasks) {
    const assignee = normalizeString(task?.toAgentId);
    const metrics = ensureMetricsRecord(metricsByAgent, assignee);
    if (!metrics) {
      continue;
    }
    metrics.tasksAssigned += 1;
    if (normalizeString(task?.status).toUpperCase() === "COMPLETED") {
      metrics.tasksCompleted += 1;
    }
  }

  const normalizedAssignments = Array.isArray(activeAssignments) ? activeAssignments : [];
  for (const assignment of normalizedAssignments) {
    const assignee = normalizeString(assignment?.assignedAgentIdentity);
    const metrics = ensureMetricsRecord(metricsByAgent, assignee);
    if (!metrics) {
      continue;
    }
    metrics.activeAssignments += 1;
  }

  return toMetricsObject(metricsByAgent);
}

function compareRankedCandidates(left, right) {
  if (left.score.overallScore !== right.score.overallScore) {
    return right.score.overallScore - left.score.overallScore;
  }
  if (left.assignmentCount !== right.assignmentCount) {
    return left.assignmentCount - right.assignmentCount;
  }
  if (left.statusWeight !== right.statusWeight) {
    return left.statusWeight - right.statusWeight;
  }
  if (left.activityEpoch !== right.activityEpoch) {
    return left.activityEpoch - right.activityEpoch;
  }
  return left.agentId.localeCompare(right.agentId);
}

function rankAgentsByScore(candidates = [], analyticsByAgent = {}) {
  const normalizedCandidates = Array.isArray(candidates) ? candidates : [];
  const ranked = normalizedCandidates.map((candidate) => {
    const agentId = normalizeString(candidate?.agentId);
    const agentAnalytics =
      analyticsByAgent && typeof analyticsByAgent === "object" ? analyticsByAgent[agentId] || {} : {};
    const score = computeAgentScore(agentId, agentAnalytics);
    return {
      ...candidate,
      score,
    };
  });
  ranked.sort(compareRankedCandidates);
  return ranked;
}

export {
  SCORE_MODEL_VERSION,
  buildAgentAnalyticsSnapshot,
  computeAgentScore,
  rankAgentsByScore,
};
