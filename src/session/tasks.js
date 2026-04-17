import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ensureWorkItemQueued,
  heartbeatLease,
  leaseWorkItem,
  listAssignments,
  releaseLease,
} from "../daemon/assignment-ledger.js";
import { createAgentEvent } from "../events/schema.js";
import { listAgents } from "./agent-registry.js";
import { resolveSessionPaths } from "./paths.js";
import { buildAgentAnalyticsSnapshot, rankAgentsByScore } from "./scoring.js";
import { appendToStream, readStream } from "./stream.js";

const TASK_REGISTRY_SCHEMA_VERSION = "1.0.0";
const DEFAULT_TASK_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TASK_LIST_LIMIT = 200;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 25;
const SCORING_EVENT_WINDOW = 2_000;

const TASK_STATUSES = Object.freeze(["PENDING", "ACCEPTED", "COMPLETED", "BLOCKED"]);
const TASK_STATUS_SET = new Set(TASK_STATUSES);
const TASK_PRIORITIES = Object.freeze(["P0", "P1", "P2", "when-free"]);
const TASK_PRIORITY_SET = new Set(["P0", "P1", "P2", "WHEN-FREE"]);

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

function normalizePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Value must be a positive integer.");
  }
  return Math.floor(normalized);
}

function normalizeTaskStatus(value, fallbackValue = "PENDING") {
  const normalized = normalizeString(value).toUpperCase();
  if (TASK_STATUS_SET.has(normalized)) {
    return normalized;
  }
  return fallbackValue;
}

function normalizeTaskPriority(value, fallbackValue = "when-free") {
  const normalized = normalizeString(value).toUpperCase().replace(/_/g, "-");
  if (!normalized) {
    return fallbackValue;
  }
  if (!TASK_PRIORITY_SET.has(normalized)) {
    return fallbackValue;
  }
  if (normalized === "WHEN-FREE") {
    return "when-free";
  }
  return normalized;
}

function normalizeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeTaskId(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function buildTaskId() {
  return `task-${randomUUID().slice(0, 8)}`;
}

function buildWorkItemId(taskId) {
  return `session-task-${normalizeString(taskId)}`;
}

function normalizeTaskRecord(raw = {}, nowIso = new Date().toISOString()) {
  const createdAt = normalizeIsoTimestamp(raw.createdAt, nowIso);
  const updatedAt = normalizeIsoTimestamp(raw.updatedAt, createdAt);
  return {
    taskId: normalizeTaskId(raw.taskId) || buildTaskId(),
    workItemId: normalizeString(raw.workItemId),
    sessionId: normalizeString(raw.sessionId),
    fromAgentId: normalizeString(raw.fromAgentId),
    toAgentId: normalizeString(raw.toAgentId),
    requestedToAgentId: normalizeString(raw.requestedToAgentId),
    roleFilter: normalizeString(raw.roleFilter).toLowerCase() || null,
    task: normalizeString(raw.task),
    priority: normalizeTaskPriority(raw.priority, "when-free"),
    context: normalizeContext(raw.context),
    status: normalizeTaskStatus(raw.status, "PENDING"),
    createdAt,
    acceptedAt: raw.acceptedAt ? normalizeIsoTimestamp(raw.acceptedAt, updatedAt) : null,
    completedAt: raw.completedAt ? normalizeIsoTimestamp(raw.completedAt, updatedAt) : null,
    result: normalizeString(raw.result) || null,
    updatedAt,
  };
}

function normalizeTaskRegistry(raw = {}, { sessionId, nowIso = new Date().toISOString() } = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const tasks = Array.isArray(source.tasks)
    ? source.tasks
        .map((item) => normalizeTaskRecord(item, nowIso))
        .filter((item) => normalizeString(item.taskId))
    : [];
  return {
    schemaVersion: TASK_REGISTRY_SCHEMA_VERSION,
    sessionId: normalizeString(source.sessionId) || normalizeString(sessionId),
    updatedAt: normalizeIsoTimestamp(source.updatedAt, nowIso),
    tasks,
  };
}

async function readJsonFile(filePath, { allowMissing = true } = {}) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (allowMissing && error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await fsp.rename(tmpPath, filePath);
}

async function ensureSessionExists(paths) {
  try {
    await fsp.access(paths.metadataPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`Session '${paths.sessionId}' was not found.`);
    }
    throw error;
  }
}

async function acquireLock(
  lockPath,
  {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleMs = DEFAULT_LOCK_STALE_MS,
    pollMs = DEFAULT_LOCK_POLL_MS,
  } = {}
) {
  const startedAt = Date.now();
  while (true) {
    try {
      await fsp.mkdir(lockPath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : "";
      if (!(code === "EEXIST" || code === "EPERM" || code === "EACCES")) {
        throw error;
      }
      try {
        const stat = await fsp.stat(lockPath);
        const ageMs = Date.now() - Number(stat.mtimeMs || 0);
        if (Number.isFinite(ageMs) && ageMs > staleMs) {
          await fsp.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Continue waiting.
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out waiting for session task lock.");
      }
      await sleep(pollMs);
    }
  }
}

async function releaseLock(lockPath) {
  await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
}

async function mutateTaskRegistry(
  sessionId,
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {},
  mutator = async () => ({})
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  await ensureSessionExists(paths);
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());

  await acquireLock(paths.tasksLockPath);
  try {
    const raw = await readJsonFile(paths.tasksPath, { allowMissing: true });
    const registry = normalizeTaskRegistry(raw || {}, {
      sessionId: paths.sessionId,
      nowIso: normalizedNow,
    });
    const result = await mutator(registry, {
      nowIso: normalizedNow,
      paths,
    });
    registry.updatedAt = normalizedNow;
    await writeJsonFile(paths.tasksPath, registry);
    return {
      result,
      registry,
      paths,
      nowIso: normalizedNow,
    };
  } finally {
    await releaseLock(paths.tasksLockPath);
  }
}

function parseStatusFilters(status, statuses = []) {
  const source = Array.isArray(statuses) && statuses.length > 0 ? statuses : status ? [status] : [];
  if (source.length === 0) {
    return null;
  }
  const normalized = source
    .map((item) => normalizeTaskStatus(item, ""))
    .filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  return new Set(normalized);
}

function severityForPriority(priority) {
  const normalized = normalizeTaskPriority(priority, "when-free");
  if (normalized === "P0" || normalized === "P1" || normalized === "P2") {
    return normalized;
  }
  return "P3";
}

function normalizeAssigneeToken(toAgentId) {
  return normalizeString(toAgentId).replace(/^@+/, "");
}

function normalizeRoleFilter(roleFilter = "") {
  const normalized = normalizeString(roleFilter).toLowerCase();
  return normalized || null;
}

function parseAssignmentTargetToken(rawToken) {
  const token = normalizeAssigneeToken(rawToken);
  if (!token) {
    throw new Error("assign target is required.");
  }
  const lower = token.toLowerCase();
  if (lower === "*") {
    return {
      wildcard: true,
      requestedToAgentId: "*",
      roleFilter: null,
    };
  }
  if (lower.startsWith("*:")) {
    return {
      wildcard: true,
      requestedToAgentId: "*",
      roleFilter: normalizeRoleFilter(token.slice(2)),
    };
  }
  if (lower.endsWith(":*")) {
    return {
      wildcard: true,
      requestedToAgentId: "*",
      roleFilter: normalizeRoleFilter(token.slice(0, -2)),
    };
  }
  if (lower.startsWith("role:")) {
    return {
      wildcard: true,
      requestedToAgentId: "*",
      roleFilter: normalizeRoleFilter(token.slice(5)),
    };
  }
  return {
    wildcard: false,
    requestedToAgentId: token,
    roleFilter: null,
  };
}

function parseEpoch(value, fallbackIso = new Date().toISOString()) {
  return Date.parse(normalizeIsoTimestamp(value, fallbackIso)) || 0;
}

function statusWeight(status = "") {
  const normalized = normalizeString(status).toLowerCase();
  if (normalized === "idle") return 0;
  if (normalized === "watching") return 1;
  if (normalized === "coding" || normalized === "reviewing" || normalized === "testing") return 2;
  if (normalized === "blocked") return 3;
  return 2;
}

async function resolveExplicitAgent(sessionId, requestedAgentId, { targetPath = process.cwd(), roleFilter = null } = {}) {
  const agents = await listAgents(sessionId, {
    targetPath,
    includeInactive: false,
  });
  const normalizedRequested = normalizeString(requestedAgentId).toLowerCase();
  const match = agents.find((agent) => normalizeString(agent.agentId).toLowerCase() === normalizedRequested);
  if (!match) {
    throw new Error(`Target agent '${requestedAgentId}' is not active in session '${sessionId}'.`);
  }
  if (roleFilter && normalizeString(match.role).toLowerCase() !== roleFilter) {
    throw new Error(
      `Target agent '${requestedAgentId}' role '${match.role}' does not match required role '${roleFilter}'.`
    );
  }
  return {
    ...match,
    assignmentCount: 0,
    statusWeight: statusWeight(match.status),
    activityEpoch: parseEpoch(match.lastActivityAt),
  };
}

async function resolveHighestScoringAgent(
  sessionId,
  {
    targetPath = process.cwd(),
    roleFilter = null,
    nowIso = new Date().toISOString(),
  } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const [agents, activeAssignments, events, rawTaskRegistry] = await Promise.all([
    listAgents(sessionId, {
      targetPath,
      includeInactive: false,
    }),
    listAssignments({
      targetPath,
      sessionId,
      statuses: ["CLAIMED", "IN_PROGRESS"],
      includeExpired: false,
      limit: 500,
      nowIso,
    }),
    readStream(sessionId, {
      targetPath,
      tail: SCORING_EVENT_WINDOW,
    }),
    readJsonFile(paths.tasksPath, { allowMissing: true }),
  ]);

  const taskRegistry = normalizeTaskRegistry(rawTaskRegistry || {}, {
    sessionId,
    nowIso,
  });
  const counts = new Map();
  for (const assignment of activeAssignments.assignments) {
    const agentId = normalizeString(assignment.assignedAgentIdentity);
    if (!agentId) {
      continue;
    }
    counts.set(agentId, Number(counts.get(agentId) || 0) + 1);
  }

  const candidates = agents
    .filter((agent) => normalizeString(agent.agentId).toLowerCase() !== "senti")
    .filter((agent) => !roleFilter || normalizeString(agent.role).toLowerCase() === roleFilter)
    .map((agent) => ({
      ...agent,
      assignmentCount: Number(counts.get(normalizeString(agent.agentId)) || 0),
      statusWeight: statusWeight(agent.status),
      activityEpoch: parseEpoch(agent.lastActivityAt, nowIso),
    }));

  if (candidates.length === 0) {
    if (roleFilter) {
      throw new Error(`No active agent matches role '${roleFilter}' in session '${sessionId}'.`);
    }
    throw new Error(`No active agents available for wildcard task routing in session '${sessionId}'.`);
  }

  const analyticsByAgent = buildAgentAnalyticsSnapshot({
    events: Array.isArray(events) ? events : [],
    tasks: taskRegistry.tasks,
    activeAssignments: activeAssignments.assignments,
    nowIso,
  });
  const rankedCandidates = rankAgentsByScore(candidates, analyticsByAgent);
  return {
    ...rankedCandidates[0],
    rankedCandidates: rankedCandidates.slice(0, 5).map((candidate) => ({
      agentId: candidate.agentId,
      role: candidate.role,
      overallScore: candidate.score.overallScore,
      taskCompletionRate: candidate.score.taskCompletionRate,
      reviewAccuracy: candidate.score.reviewAccuracy,
      assignmentCount: candidate.assignmentCount,
    })),
  };
}

async function resolveTaskAssignee(
  sessionId,
  {
    toAgentId,
    roleFilter = null,
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  const parsedTarget = parseAssignmentTargetToken(toAgentId);
  const resolvedRoleFilter = normalizeRoleFilter(roleFilter || parsedTarget.roleFilter);
  if (parsedTarget.wildcard) {
    const agent = await resolveHighestScoringAgent(sessionId, {
      targetPath,
      roleFilter: resolvedRoleFilter,
      nowIso,
    });
    return {
      wildcard: true,
      requestedToAgentId: "*",
      roleFilter: resolvedRoleFilter,
      strategy: "score",
      routedAgent: agent,
      rankedCandidates: Array.isArray(agent.rankedCandidates) ? agent.rankedCandidates : [],
    };
  }
  const agent = await resolveExplicitAgent(sessionId, parsedTarget.requestedToAgentId, {
    targetPath,
    roleFilter: resolvedRoleFilter,
  });
  return {
    wildcard: false,
    requestedToAgentId: parsedTarget.requestedToAgentId,
    roleFilter: resolvedRoleFilter,
    strategy: "explicit",
    routedAgent: agent,
    rankedCandidates: [],
  };
}

function findTaskById(registry, taskId) {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) {
    return null;
  }
  return registry.tasks.find((task) => task.taskId === normalizedTaskId) || null;
}

function findLatestTaskForAgent(registry, agentId, allowedStatuses = []) {
  const normalizedAgentId = normalizeString(agentId).toLowerCase();
  const statusOrder = Array.isArray(allowedStatuses) ? [...allowedStatuses] : [];
  for (const status of statusOrder) {
    const match = registry.tasks
      .filter((task) => normalizeString(task.toAgentId).toLowerCase() === normalizedAgentId)
      .filter((task) => normalizeTaskStatus(task.status, "") === normalizeTaskStatus(status, ""))
      .sort((left, right) => parseEpoch(right.updatedAt) - parseEpoch(left.updatedAt))[0];
    if (match) {
      return match;
    }
  }
  return null;
}

function parsePriorityAndTask(rawTask) {
  const normalizedTask = normalizeString(rawTask);
  if (!normalizedTask) {
    throw new Error("task is required.");
  }
  const bracketPriority = normalizedTask.match(/^\[(P0|P1|P2|when-free)\]\s*(.+)$/i);
  if (bracketPriority) {
    return {
      priority: normalizeTaskPriority(bracketPriority[1], "when-free"),
      task: normalizeString(bracketPriority[2]),
    };
  }
  const inlinePriority = normalizedTask.match(/^(P0|P1|P2|when-free)\s*[:\-]\s*(.+)$/i);
  if (inlinePriority) {
    return {
      priority: normalizeTaskPriority(inlinePriority[1], "when-free"),
      task: normalizeString(inlinePriority[2]),
    };
  }
  return {
    priority: "when-free",
    task: normalizedTask,
  };
}

function parseFilesFromTaskText(taskText) {
  const match = /\bfiles?\s*:\s*(.+)$/i.exec(normalizeString(taskText));
  if (!match) {
    return [];
  }
  return match[1]
    .split(",")
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function extractTaskIdFromText(text) {
  const normalized = normalizeString(text);
  if (!normalized) {
    return null;
  }
  const explicit = /\btask(?:\s+id)?\s*[:#-]?\s*([a-z0-9][a-z0-9._-]{5,})\b/i.exec(normalized);
  if (explicit) {
    return normalizeTaskId(explicit[1]);
  }
  return null;
}

function buildTaskAssignPayload(taskRecord, routing = {}) {
  return {
    taskId: taskRecord.taskId,
    workItemId: taskRecord.workItemId,
    from: taskRecord.fromAgentId,
    to: taskRecord.toAgentId,
    requestedTo: taskRecord.requestedToAgentId,
    wildcardRouted: Boolean(routing.wildcard),
    roleFilter: taskRecord.roleFilter,
    task: taskRecord.task,
    priority: taskRecord.priority,
    context: taskRecord.context,
    routingStrategy: normalizeString(routing.strategy) || (routing.wildcard ? "score" : "explicit"),
    selectedScore:
      routing &&
      routing.routedAgent &&
      routing.routedAgent.score &&
      Number.isFinite(Number(routing.routedAgent.score.overallScore))
        ? Number(routing.routedAgent.score.overallScore)
        : null,
    scoreModelVersion:
      routing && routing.routedAgent && routing.routedAgent.score
        ? normalizeString(routing.routedAgent.score.scoreModelVersion) || null
        : null,
    rankedCandidates:
      Array.isArray(routing.rankedCandidates) && routing.rankedCandidates.length > 0
        ? routing.rankedCandidates
        : [],
  };
}

export async function assignTask(
  sessionId,
  {
    fromAgentId,
    toAgentId,
    task,
    priority = "when-free",
    context = {},
    roleFilter = null,
    leaseTtlMs = DEFAULT_TASK_LEASE_TTL_MS,
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedFromAgentId = normalizeString(fromAgentId);
  if (!normalizedFromAgentId) {
    throw new Error("fromAgentId is required.");
  }
  const parsedTask = parsePriorityAndTask(task);
  const normalizedPriority = normalizeTaskPriority(priority || parsedTask.priority, parsedTask.priority);
  const normalizedTaskText = normalizeString(parsedTask.task);
  const normalizedContext = normalizeContext(context);

  const routing = await resolveTaskAssignee(sessionId, {
    toAgentId,
    roleFilter,
    targetPath,
    nowIso: normalizedNow,
  });
  const taskId = buildTaskId();
  const workItemId = buildWorkItemId(taskId);
  const mergedContext = {
    ...normalizedContext,
    files:
      Array.isArray(normalizedContext.files) && normalizedContext.files.length > 0
        ? [...normalizedContext.files]
        : parseFilesFromTaskText(normalizedTaskText),
  };
  const taskRecord = normalizeTaskRecord(
    {
      taskId,
      workItemId,
      sessionId: normalizeString(sessionId),
      fromAgentId: normalizedFromAgentId,
      toAgentId: routing.routedAgent.agentId,
      requestedToAgentId: routing.requestedToAgentId,
      roleFilter: routing.roleFilter,
      task: normalizedTaskText,
      priority: normalizedPriority,
      context: mergedContext,
      status: "PENDING",
      createdAt: normalizedNow,
      updatedAt: normalizedNow,
    },
    normalizedNow
  );

  await ensureWorkItemQueued({
    targetPath,
    sessionId,
    workItemId,
    severity: severityForPriority(normalizedPriority),
    message: normalizedTaskText,
    metadata: {
      taskId: taskRecord.taskId,
      fromAgentId: taskRecord.fromAgentId,
      toAgentId: taskRecord.toAgentId,
      priority: taskRecord.priority,
      roleFilter: taskRecord.roleFilter,
    },
    nowIso: normalizedNow,
  });

  const lease = await leaseWorkItem({
    targetPath,
    sessionId,
    workItemId,
    agentIdentity: taskRecord.toAgentId,
    leaseTtlMs: normalizePositiveInteger(leaseTtlMs, DEFAULT_TASK_LEASE_TTL_MS),
    stage: "session_task_assigned",
    budgetSnapshot: {
      taskId: taskRecord.taskId,
      priority: taskRecord.priority,
      scope: "session_task",
    },
    nowIso: normalizedNow,
  });

  await mutateTaskRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
    },
    async (registry) => {
      registry.tasks.push(taskRecord);
      return taskRecord;
    }
  );

  const event = await appendToStream(
    sessionId,
    createAgentEvent({
      event: "task_assign",
      agentId: normalizedFromAgentId,
      sessionId,
      workItemId: taskRecord.workItemId,
      ts: normalizedNow,
      payload: buildTaskAssignPayload(taskRecord, routing),
    }),
    {
      targetPath,
    }
  );

  return {
    task: taskRecord,
    lease: lease.assignment,
    event,
    routing: {
      wildcard: routing.wildcard,
      strategy: routing.strategy || (routing.wildcard ? "score" : "explicit"),
      roleFilter: routing.roleFilter,
      selectedAgentId: routing.routedAgent.agentId,
      selectedAgentRole: routing.routedAgent.role,
      assignmentCount: routing.routedAgent.assignmentCount,
      selectedScore:
        routing.routedAgent && routing.routedAgent.score
          ? Number(routing.routedAgent.score.overallScore)
          : null,
      scoreModelVersion:
        routing.routedAgent && routing.routedAgent.score
          ? normalizeString(routing.routedAgent.score.scoreModelVersion) || null
          : null,
      rankedCandidates: Array.isArray(routing.rankedCandidates) ? routing.rankedCandidates : [],
    },
  };
}

export async function acceptTask(
  sessionId,
  agentId,
  taskId = null,
  {
    note = "",
    leaseTtlMs = DEFAULT_TASK_LEASE_TTL_MS,
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    throw new Error("agentId is required.");
  }
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedNote = normalizeString(note);
  const mutation = await mutateTaskRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
    },
    async (registry) => {
      const explicitTask = findTaskById(registry, taskId);
      const candidate =
        explicitTask ||
        findLatestTaskForAgent(registry, normalizedAgentId, ["PENDING", "ACCEPTED"]);
      if (!candidate) {
        throw new Error(`No pending task found for agent '${normalizedAgentId}'.`);
      }
      if (normalizeString(candidate.toAgentId).toLowerCase() !== normalizedAgentId.toLowerCase()) {
        throw new Error(
          `Task '${candidate.taskId}' is assigned to '${candidate.toAgentId}', not '${normalizedAgentId}'.`
        );
      }
      if (candidate.status !== "PENDING" && candidate.status !== "ACCEPTED") {
        throw new Error(`Task '${candidate.taskId}' cannot transition from status '${candidate.status}'.`);
      }
      candidate.status = "ACCEPTED";
      candidate.acceptedAt = candidate.acceptedAt || normalizedNow;
      candidate.updatedAt = normalizedNow;
      if (normalizedNote) {
        candidate.context = {
          ...normalizeContext(candidate.context),
          acceptedNote: normalizedNote,
        };
      }
      return normalizeTaskRecord(candidate, normalizedNow);
    }
  );
  const acceptedTask = mutation.result;

  const lease = await heartbeatLease({
    targetPath,
    sessionId,
    workItemId: acceptedTask.workItemId,
    agentIdentity: normalizedAgentId,
    leaseTtlMs: normalizePositiveInteger(leaseTtlMs, DEFAULT_TASK_LEASE_TTL_MS),
    stage: "session_task_in_progress",
    budgetSnapshot: {
      taskId: acceptedTask.taskId,
      priority: acceptedTask.priority,
      scope: "session_task",
    },
    nowIso: normalizedNow,
  });

  const event = await appendToStream(
    sessionId,
    createAgentEvent({
      event: "task_accepted",
      agentId: normalizedAgentId,
      sessionId,
      workItemId: acceptedTask.workItemId,
      ts: normalizedNow,
      payload: {
        taskId: acceptedTask.taskId,
        workItemId: acceptedTask.workItemId,
        from: acceptedTask.fromAgentId,
        to: acceptedTask.toAgentId,
        note: normalizedNote || null,
      },
    }),
    {
      targetPath,
    }
  );

  return {
    task: acceptedTask,
    lease: lease.assignment,
    event,
  };
}

export async function completeTask(
  sessionId,
  agentId,
  taskId = null,
  {
    result = "",
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    throw new Error("agentId is required.");
  }
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedResult = normalizeString(result);
  const mutation = await mutateTaskRegistry(
    sessionId,
    {
      targetPath,
      nowIso: normalizedNow,
    },
    async (registry) => {
      const explicitTask = findTaskById(registry, taskId);
      const candidate =
        explicitTask ||
        findLatestTaskForAgent(registry, normalizedAgentId, ["ACCEPTED", "PENDING"]);
      if (!candidate) {
        throw new Error(`No active task found for agent '${normalizedAgentId}'.`);
      }
      if (normalizeString(candidate.toAgentId).toLowerCase() !== normalizedAgentId.toLowerCase()) {
        throw new Error(
          `Task '${candidate.taskId}' is assigned to '${candidate.toAgentId}', not '${normalizedAgentId}'.`
        );
      }
      if (candidate.status !== "PENDING" && candidate.status !== "ACCEPTED") {
        throw new Error(`Task '${candidate.taskId}' cannot transition from status '${candidate.status}'.`);
      }
      candidate.status = "COMPLETED";
      candidate.completedAt = normalizedNow;
      candidate.updatedAt = normalizedNow;
      candidate.result = normalizedResult || null;
      return normalizeTaskRecord(candidate, normalizedNow);
    }
  );
  const completedTask = mutation.result;

  const lease = await releaseLease({
    targetPath,
    sessionId,
    workItemId: completedTask.workItemId,
    agentIdentity: normalizedAgentId,
    status: "DONE",
    reason: "session_task_completed",
    budgetSnapshot: {
      taskId: completedTask.taskId,
      priority: completedTask.priority,
      scope: "session_task",
      result: normalizedResult || null,
    },
    nowIso: normalizedNow,
  });

  const event = await appendToStream(
    sessionId,
    createAgentEvent({
      event: "task_completed",
      agentId: normalizedAgentId,
      sessionId,
      workItemId: completedTask.workItemId,
      ts: normalizedNow,
      payload: {
        taskId: completedTask.taskId,
        workItemId: completedTask.workItemId,
        from: completedTask.fromAgentId,
        to: completedTask.toAgentId,
        result: normalizedResult || null,
      },
    }),
    {
      targetPath,
    }
  );

  return {
    task: completedTask,
    lease: lease.assignment,
    event,
  };
}

export async function listSessionTasks(
  sessionId,
  {
    status = null,
    statuses = [],
    limit = DEFAULT_TASK_LIST_LIMIT,
    targetPath = process.cwd(),
  } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const nowIso = new Date().toISOString();
  const raw = await readJsonFile(paths.tasksPath, { allowMissing: true });
  const registry = normalizeTaskRegistry(raw || {}, {
    sessionId: paths.sessionId,
    nowIso,
  });
  const filter = parseStatusFilters(status, statuses);
  const normalizedLimit = normalizePositiveInteger(limit, DEFAULT_TASK_LIST_LIMIT);
  const visible = registry.tasks
    .filter((task) => (filter ? filter.has(normalizeTaskStatus(task.status, "")) : true))
    .sort((left, right) => parseEpoch(right.updatedAt) - parseEpoch(left.updatedAt));
  return {
    sessionId: paths.sessionId,
    tasksPath: paths.tasksPath,
    totalCount: registry.tasks.length,
    visibleCount: visible.length,
    tasks: visible.slice(0, normalizedLimit),
  };
}

export function parseTaskDirectiveMessage(message = "") {
  const normalizedMessage = normalizeString(message);
  if (!normalizedMessage) {
    return null;
  }

  const assignMatch = /^assign\s*:\s*@([^\s]+)\s+(.+)$/i.exec(normalizedMessage);
  if (assignMatch) {
    const parsedTask = parsePriorityAndTask(assignMatch[2]);
    const parsedTarget = parseAssignmentTargetToken(assignMatch[1]);
    return {
      action: "assign",
      requestedToAgentId: parsedTarget.requestedToAgentId,
      roleFilter: parsedTarget.roleFilter,
      wildcard: parsedTarget.wildcard,
      task: parsedTask.task,
      priority: parsedTask.priority,
      context: {
        files: parseFilesFromTaskText(parsedTask.task),
      },
    };
  }

  const acceptedMatch = /^accepted\s*:\s*(.+)$/i.exec(normalizedMessage);
  if (acceptedMatch) {
    const note = normalizeString(acceptedMatch[1]);
    return {
      action: "accepted",
      taskId: extractTaskIdFromText(note),
      note,
    };
  }

  const doneMatch = /^done\s*:\s*(.+)$/i.exec(normalizedMessage);
  if (doneMatch) {
    const result = normalizeString(doneMatch[1]);
    return {
      action: "done",
      taskId: extractTaskIdFromText(result),
      result,
    };
  }

  return null;
}

export async function handleTaskDirective(
  sessionId,
  event = {},
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  if (normalizeString(event.event) !== "session_message") {
    return null;
  }
  const message = normalizeString(event.payload?.message);
  if (!message) {
    return null;
  }
  const parsed = parseTaskDirectiveMessage(message);
  if (!parsed) {
    return null;
  }
  const fromAgentId = normalizeString(event.agent?.id);
  if (!fromAgentId) {
    throw new Error("session_message agent id is required for task directives.");
  }
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());

  if (parsed.action === "assign") {
    const assigned = await assignTask(sessionId, {
      fromAgentId,
      toAgentId: parsed.wildcard ? "*" : parsed.requestedToAgentId,
      roleFilter: parsed.roleFilter,
      task: parsed.task,
      priority: parsed.priority,
      context: parsed.context,
      targetPath,
      nowIso: normalizedNow,
    });
    return {
      action: "assign",
      parsed,
      assigned,
    };
  }

  if (parsed.action === "accepted") {
    const accepted = await acceptTask(sessionId, fromAgentId, parsed.taskId, {
      note: parsed.note,
      targetPath,
      nowIso: normalizedNow,
    });
    return {
      action: "accepted",
      parsed,
      accepted,
    };
  }

  if (parsed.action === "done") {
    const completed = await completeTask(sessionId, fromAgentId, parsed.taskId, {
      result: parsed.result,
      targetPath,
      nowIso: normalizedNow,
    });
    return {
      action: "done",
      parsed,
      completed,
    };
  }

  return null;
}

export {
  DEFAULT_TASK_LEASE_TTL_MS,
  TASK_PRIORITIES,
  TASK_STATUSES,
};
