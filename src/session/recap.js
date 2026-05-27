import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createAgentEvent } from "../events/schema.js";
import { dedupeSessionEvents } from "./event-identity.js";
import { resolveSessionPaths } from "./paths.js";
import { appendToStream, readStream } from "./stream.js";
import { getSession } from "./store.js";
import { aggregateSessionUsage } from "./usage.js";

const SENTI_AGENT_ID = "senti";
const SENTI_MODEL = "gpt-5.4-mini";
const RECAP_STYLE = "italic-grey";
const DEFAULT_RECAP_MAX_EVENTS = 100;
const DEFAULT_RECAP_INTERVAL_MS = 300_000;
const DEFAULT_RECAP_INACTIVITY_MS = 600_000;
const DEFAULT_RECAP_ACTIVITY_THRESHOLD = 5;
const DEFAULT_TASK_SUMMARY_LIMIT = 3;
const DEFAULT_WORK_PLAN_SUMMARY_LIMIT = 5;
const MAX_WORK_PLAN_BYTES = 128_000;
const WORK_PLAN_RELATIVE_PATH = "tasks/todo.md";
const RECAP_SOURCE_IGNORED_EVENTS = new Set([
  "agent_heartbeat",
  "agent_join",
  "agent_status",
  "context_briefing",
  "daemon_alert",
  "session_ack",
  "session_checkpoint",
  "session_reaction",
  "session_recap",
  "session_usage",
  "session_view",
]);
const ACTIVE_TASK_STATUSES = new Set(["PENDING", "ACCEPTED", "BLOCKED"]);
const TASK_STATUS_KEYS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  COMPLETED: "completed",
  BLOCKED: "blocked",
};

const ACTIVE_RECAP_EMITTERS = new Map();

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
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.max(1, Math.floor(normalized));
}

function toEpoch(value, fallbackIso = new Date().toISOString()) {
  return Date.parse(normalizeIsoTimestamp(value, fallbackIso)) || 0;
}

function isRecapEvent(event = {}) {
  const eventName = normalizeString(event.event).toLowerCase();
  if (eventName === "context_briefing" || eventName === "session_recap") {
    return true;
  }
  const payload = event && typeof event.payload === "object" ? event.payload : {};
  return payload.ephemeral === true && normalizeString(payload.style) === RECAP_STYLE;
}

function eventSequenceId(event = {}) {
  const parsed = Number(event.sequenceId ?? event.sequence_id);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function eventCursor(event = {}) {
  return normalizeString(event.cursor || event.eventId || event.idempotencyToken || event.ts);
}

function isMeaningfulRecapSourceEvent(event = {}) {
  if (isRecapEvent(event)) {
    return false;
  }
  const eventName = normalizeString(event.event).toLowerCase();
  if (!eventName || RECAP_SOURCE_IGNORED_EVENTS.has(eventName)) {
    return false;
  }
  return true;
}

function isEventAfterRecapAnchor(event = {}, state = {}) {
  const anchorSequence = Number(state.lastSourceSequenceId);
  const sequence = eventSequenceId(event);
  if (Number.isFinite(anchorSequence) && anchorSequence > 0 && sequence !== null) {
    return sequence > anchorSequence;
  }

  const anchorAt = normalizeString(state.lastSourceEventAt);
  if (!anchorAt) {
    return true;
  }
  const anchorEpoch = toEpoch(anchorAt, anchorAt);
  const eventEpoch = toEpoch(event.ts, anchorAt);
  if (eventEpoch > anchorEpoch) {
    return true;
  }
  if (eventEpoch < anchorEpoch) {
    return false;
  }

  const anchorCursor = normalizeString(state.lastSourceCursor);
  if (!anchorCursor) {
    return true;
  }
  return eventCursor(event) !== anchorCursor;
}

function rememberRecapSource(state, event = {}, nowIso = new Date().toISOString()) {
  state.lastSourceEventAt = normalizeIsoTimestamp(event.ts, nowIso);
  state.lastSourceSequenceId = eventSequenceId(event);
  state.lastSourceCursor = eventCursor(event);
}

function resolvePeriodicRecapTrigger(state, events = [], nowIso = new Date().toISOString()) {
  const sortedEvents = sortEventsByConversationTime(events, nowIso);
  const sourceEvents = sortedEvents.filter(isMeaningfulRecapSourceEvent);
  const unrecappedSourceEvents = sourceEvents.filter((event) => isEventAfterRecapAnchor(event, state));
  const latestSourceEvent = sourceEvents.length > 0 ? sourceEvents[sourceEvents.length - 1] : null;
  const latestUnrecappedSourceEvent =
    unrecappedSourceEvents.length > 0
      ? unrecappedSourceEvents[unrecappedSourceEvents.length - 1]
      : null;
  const nowEpoch = toEpoch(nowIso, nowIso);
  const latestSourceEventAt = latestSourceEvent
    ? normalizeIsoTimestamp(latestSourceEvent.ts, nowIso)
    : null;
  const latestUnrecappedSourceEventAt = latestUnrecappedSourceEvent
    ? normalizeIsoTimestamp(latestUnrecappedSourceEvent.ts, nowIso)
    : null;
  const sourceIdleMs = latestSourceEvent
    ? Math.max(0, nowEpoch - toEpoch(latestSourceEvent.ts, nowIso))
    : null;
  const unrecappedSourceIdleMs = latestUnrecappedSourceEvent
    ? Math.max(0, nowEpoch - toEpoch(latestUnrecappedSourceEvent.ts, nowIso))
    : null;
  const sinceLastRecapMs = state.lastRecapAt
    ? Math.max(0, nowEpoch - toEpoch(state.lastRecapAt, nowIso))
    : null;
  const policy = {
    intervalMs: state.intervalMs,
    inactivityMs: state.inactivityMs,
    activityThreshold: state.newEventThreshold,
    sourceEventCount: unrecappedSourceEvents.length,
    totalSourceEventCount: sourceEvents.length,
    latestSourceEventAt,
    latestUnrecappedSourceEventAt,
    sourceIdleMs,
    unrecappedSourceIdleMs,
    lastRecapAt: state.lastRecapAt,
    lastSourceEventAt: state.lastSourceEventAt,
  };

  if (!latestSourceEvent) {
    return {
      shouldEmit: false,
      shouldStop: false,
      stopAfterEmit: false,
      mode: "",
      reason: "recap_no_source_events",
      sourceEvent: null,
      policy,
    };
  }

  if (!latestUnrecappedSourceEvent) {
    return {
      shouldEmit: false,
      shouldStop: sourceIdleMs !== null && sourceIdleMs >= state.inactivityMs,
      stopAfterEmit: false,
      mode: "",
      reason: "recap_no_new_source_events",
      sourceEvent: null,
      policy,
    };
  }

  if (unrecappedSourceIdleMs !== null && unrecappedSourceIdleMs >= state.inactivityMs) {
    return {
      shouldEmit: true,
      shouldStop: false,
      stopAfterEmit: true,
      mode: "inactivity",
      reason: "",
      sourceEvent: latestUnrecappedSourceEvent,
      policy,
    };
  }

  if (!state.lastRecapAt) {
    return {
      shouldEmit: true,
      shouldStop: false,
      stopAfterEmit: false,
      mode: "initial",
      reason: "",
      sourceEvent: latestUnrecappedSourceEvent,
      policy,
    };
  }

  if (unrecappedSourceEvents.length >= state.newEventThreshold) {
    return {
      shouldEmit: true,
      shouldStop: false,
      stopAfterEmit: false,
      mode: "activity_threshold",
      reason: "",
      sourceEvent: latestUnrecappedSourceEvent,
      policy,
    };
  }

  if (sinceLastRecapMs !== null && sinceLastRecapMs >= state.intervalMs) {
    return {
      shouldEmit: true,
      shouldStop: false,
      stopAfterEmit: false,
      mode: "periodic",
      reason: "",
      sourceEvent: latestUnrecappedSourceEvent,
      policy,
    };
  }

  return {
    shouldEmit: false,
    shouldStop: false,
    stopAfterEmit: false,
    mode: "",
    reason: "recap_cadence_wait",
    sourceEvent: latestUnrecappedSourceEvent,
    policy,
  };
}

function parseFindingSeverity(text = "") {
  const normalized = normalizeString(text);
  if (!normalized) {
    return "";
  }
  const findingMatch = /finding\s*:\s*\[(P[0-3])\]/i.exec(normalized);
  if (findingMatch) {
    return normalizeString(findingMatch[1]).toUpperCase();
  }
  const bracketMatch = /\[(P[0-3])\]/i.exec(normalized);
  if (bracketMatch) {
    return normalizeString(bracketMatch[1]).toUpperCase();
  }
  return "";
}

function buildFindingSummary(events = []) {
  const summary = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  for (const event of events) {
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const severity =
      parseFindingSeverity(payload.message) ||
      normalizeString(payload.severity).toUpperCase() ||
      parseFindingSeverity(payload.title);
    if (Object.prototype.hasOwnProperty.call(summary, severity)) {
      summary[severity] += 1;
    }
  }
  return summary;
}

function countActiveLocks(events = []) {
  const activeLocks = new Map();
  for (const event of events) {
    const eventName = normalizeString(event.event).toLowerCase();
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const filePath = normalizeString(payload.file || payload.filePath || payload.path).replace(/\\/g, "/");
    if (!filePath) {
      continue;
    }
    if (eventName === "file_lock") {
      const holder = normalizeString(event.agent?.id || event.agentId);
      activeLocks.set(filePath, holder || "unknown");
      continue;
    }
    if (eventName === "file_unlock") {
      activeLocks.delete(filePath);
    }
  }
  return activeLocks.size;
}

function summarizeRecentActivity(events = [], { forAgentId = "", limit = 2 } = {}) {
  const normalizedAgentId = normalizeString(forAgentId).toLowerCase();
  const snippets = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const agentId = normalizeString(event.agent?.id || event.agentId);
    if (!agentId || agentId.toLowerCase() === normalizedAgentId || agentId === SENTI_AGENT_ID) {
      continue;
    }
    const payload = event && typeof event.payload === "object" ? event.payload : {};
    const message = normalizeString(
      payload.message || payload.response || payload.recap || payload.alert || payload.reason
    );
    if (!message) {
      continue;
    }
    snippets.push(`${agentId}: ${message.replace(/\s+/g, " ").slice(0, 120)}`);
    if (snippets.length >= Math.max(1, limit)) {
      break;
    }
  }
  return snippets.reverse();
}

async function readPendingTasks(sessionId, { forAgentId = "", targetPath = process.cwd() } = {}) {
  const normalizedAgentId = normalizeString(forAgentId).toLowerCase();
  if (!normalizedAgentId) {
    return 0;
  }
  const paths = resolveSessionPaths(sessionId, { targetPath });
  try {
    const raw = await fsp.readFile(paths.tasksPath, "utf-8");
    const parsed = JSON.parse(raw);
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    return tasks.filter((task) => {
      const owner = normalizeString(task?.toAgentId).toLowerCase();
      const status = normalizeString(task?.status).toUpperCase();
      if (!owner || owner !== normalizedAgentId) {
        return false;
      }
      return status === "PENDING" || status === "ACCEPTED";
    }).length;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return 0;
    }
    return 0;
  }
}

function normalizeTaskStatus(value) {
  const normalized = normalizeString(value).toUpperCase();
  return Object.prototype.hasOwnProperty.call(TASK_STATUS_KEYS, normalized)
    ? normalized
    : "PENDING";
}

function taskOwner(task = {}) {
  return (
    normalizeString(task.toAgentId) ||
    normalizeString(task.requestedToAgentId) ||
    (normalizeString(task.roleFilter) ? `role:${normalizeString(task.roleFilter)}` : "") ||
    "unassigned"
  );
}

function shortTaskText(value) {
  const text = normalizeString(value).replace(/\s+/g, " ");
  if (text.length <= 80) {
    return text;
  }
  return `${text.slice(0, 77)}...`;
}

function emptyTaskLedgerSummary() {
  return {
    total: 0,
    active: 0,
    pending: 0,
    accepted: 0,
    blocked: 0,
    completed: 0,
    owners: [],
    recent: [],
  };
}

function emptyWorkPlanSummary() {
  return {
    path: WORK_PLAN_RELATIVE_PATH,
    exists: false,
    truncated: false,
    total: 0,
    open: 0,
    completed: 0,
    currentSection: "",
    recentOpen: [],
    recent: [],
  };
}

function shortWorkPlanText(value) {
  const text = normalizeString(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ");
  if (text.length <= 100) {
    return text;
  }
  return `${text.slice(0, 97)}...`;
}

function summarizeWorkPlanMarkdown(raw = "", { limit = DEFAULT_WORK_PLAN_SUMMARY_LIMIT, truncated = false } = {}) {
  const summary = emptyWorkPlanSummary();
  summary.exists = true;
  summary.truncated = Boolean(truncated);

  const records = [];
  let section = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    const headingMatch = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      section = shortWorkPlanText(headingMatch[2]);
      continue;
    }

    const taskMatch = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (!taskMatch) {
      continue;
    }
    const completed = taskMatch[1].toLowerCase() === "x";
    const record = {
      status: completed ? "completed" : "open",
      section,
      task: shortWorkPlanText(taskMatch[2]),
    };
    if (!record.task) {
      continue;
    }
    records.push(record);
    summary.total += 1;
    if (completed) {
      summary.completed += 1;
    } else {
      summary.open += 1;
    }
    summary.currentSection = section || summary.currentSection;
  }

  const normalizedLimit = Math.max(1, normalizePositiveInteger(limit, DEFAULT_WORK_PLAN_SUMMARY_LIMIT));
  summary.recentOpen = records
    .filter((record) => record.status === "open")
    .slice(-normalizedLimit);
  summary.recent = records.slice(-normalizedLimit);
  return summary;
}

async function readWorkPlanSummary({ targetPath = process.cwd(), limit = DEFAULT_WORK_PLAN_SUMMARY_LIMIT } = {}) {
  const filePath = path.join(path.resolve(String(targetPath || ".")), WORK_PLAN_RELATIVE_PATH);
  try {
    const stats = await fsp.stat(filePath);
    let source = "";
    let truncated = false;
    if (stats.size > MAX_WORK_PLAN_BYTES) {
      truncated = true;
      const handle = await fsp.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_WORK_PLAN_BYTES);
        const position = Math.max(0, stats.size - MAX_WORK_PLAN_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, MAX_WORK_PLAN_BYTES, position);
        source = buffer.subarray(0, bytesRead).toString("utf-8");
      } finally {
        await handle.close();
      }
    } else {
      source = await fsp.readFile(filePath, "utf-8");
    }
    return summarizeWorkPlanMarkdown(source, { limit, truncated });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return emptyWorkPlanSummary();
    }
    return emptyWorkPlanSummary();
  }
}

function summarizeTaskLedger(tasks = [], { limit = DEFAULT_TASK_SUMMARY_LIMIT } = {}) {
  const summary = emptyTaskLedgerSummary();
  const owners = new Map();
  const normalizedTasks = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== "object") {
      continue;
    }
    const status = normalizeTaskStatus(task.status);
    const statusKey = TASK_STATUS_KEYS[status];
    const owner = taskOwner(task);
    const priority = normalizeString(task.priority) || "when-free";
    const taskId = normalizeString(task.taskId) || "task";
    const updatedAt = normalizeIsoTimestamp(
      task.updatedAt || task.completedAt || task.acceptedAt || task.createdAt,
      new Date().toISOString(),
    );
    const record = {
      taskId,
      status,
      priority,
      owner,
      task: shortTaskText(task.task),
      updatedAt,
    };
    normalizedTasks.push(record);
    summary.total += 1;
    summary[statusKey] += 1;

    if (ACTIVE_TASK_STATUSES.has(status)) {
      summary.active += 1;
      const ownerRecord = owners.get(owner) || {
        agentId: owner,
        active: 0,
        pending: 0,
        accepted: 0,
        blocked: 0,
      };
      ownerRecord.active += 1;
      ownerRecord[statusKey] += 1;
      owners.set(owner, ownerRecord);
    }
  }

  summary.owners = [...owners.values()]
    .sort((left, right) => {
      if (right.active !== left.active) return right.active - left.active;
      return left.agentId.localeCompare(right.agentId);
    })
    .slice(0, Math.max(1, limit));
  summary.recent = normalizedTasks
    .sort((left, right) => toEpoch(right.updatedAt) - toEpoch(left.updatedAt))
    .slice(0, Math.max(1, limit));
  return summary;
}

async function readTaskLedgerSummary(
  sessionId,
  { targetPath = process.cwd(), limit = DEFAULT_TASK_SUMMARY_LIMIT } = {},
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  try {
    const raw = await fsp.readFile(paths.tasksPath, "utf-8");
    const parsed = JSON.parse(raw);
    return summarizeTaskLedger(parsed?.tasks || [], { limit });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return emptyTaskLedgerSummary();
    }
    return emptyTaskLedgerSummary();
  }
}

function elapsedMinutesBetween(startIso, nowIso = new Date().toISOString()) {
  const normalizedStartIso = normalizeString(startIso);
  if (!normalizedStartIso) {
    return 0;
  }
  const firstEpoch = toEpoch(normalizedStartIso, nowIso);
  const nowEpoch = toEpoch(nowIso, nowIso);
  if (!Number.isFinite(firstEpoch) || !Number.isFinite(nowEpoch) || nowEpoch <= firstEpoch) {
    return 0;
  }
  return Math.max(0, Math.floor((nowEpoch - firstEpoch) / 60_000));
}

function earliestIso(values = [], fallbackIso = new Date().toISOString()) {
  const validEpochs = values
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (validEpochs.length === 0) {
    return "";
  }
  validEpochs.sort((left, right) => left - right);
  return normalizeIsoTimestamp(new Date(validEpochs[0]).toISOString(), fallbackIso);
}

function buildElapsedMinutes(events = [], nowIso = new Date().toISOString(), { startedAt = "" } = {}) {
  const eventStart = Array.isArray(events) && events.length > 0 ? events[0]?.ts || events[0]?.timestamp : "";
  const startIso = earliestIso([startedAt, eventStart], nowIso);
  return elapsedMinutesBetween(startIso, nowIso);
}

function eventSequenceNumber(event = {}) {
  for (const value of [event.sequenceId, event.sequence, event.seq, event.payload?.sequenceId]) {
    const normalized = Number(value);
    if (Number.isFinite(normalized)) {
      return normalized;
    }
  }
  return 0;
}

function sortEventsByConversationTime(events = [], fallbackIso = new Date().toISOString()) {
  return [...(Array.isArray(events) ? events : [])].sort((left, right) => {
    const leftEpoch = toEpoch(left?.ts || left?.timestamp, fallbackIso);
    const rightEpoch = toEpoch(right?.ts || right?.timestamp, fallbackIso);
    if (leftEpoch !== rightEpoch) {
      return leftEpoch - rightEpoch;
    }
    const leftSequence = eventSequenceNumber(left);
    const rightSequence = eventSequenceNumber(right);
    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
    return normalizeString(left?.cursor).localeCompare(normalizeString(right?.cursor));
  });
}

function buildRecapKey(sessionId, targetPath) {
  return `${path.resolve(String(targetPath || "."))}::${normalizeString(sessionId)}`;
}

function buildRecapText({
  activeAgents = [],
  totalFindings = 0,
  activeLocks = 0,
  pendingTasks = 0,
  taskLedger = emptyTaskLedgerSummary(),
  workPlan = emptyWorkPlanSummary(),
  usageSummary = normalizeUsageSummary(),
  snippets = [],
} = {}) {
  const agentText =
    activeAgents.length > 0
      ? `${activeAgents.length} active (${activeAgents.slice(0, 3).join(", ")})`
      : "no active peers yet";
  const findingText = `${totalFindings} finding${totalFindings === 1 ? "" : "s"} logged`;
  const lockText = `${activeLocks} file lock${activeLocks === 1 ? "" : "s"} active`;
  const pendingText =
    pendingTasks > 0 ? `You have ${pendingTasks} pending task${pendingTasks === 1 ? "" : "s"}.` : "";
  const taskText = buildTaskLedgerText(taskLedger);
  const usageText = buildUsageLedgerText(usageSummary);
  const workPlanText = buildWorkPlanText(workPlan);
  const snippetText = snippets.length > 0 ? `Recent: ${snippets.join(" | ")}` : "";
  return `While you were away: ${agentText}. ${findingText}. ${lockText}. ${pendingText} ${taskText}. ${workPlanText} ${usageText} ${snippetText}`.replace(
    /\s+/g,
    " "
  ).trim();
}

function buildTaskLedgerText(taskLedger = emptyTaskLedgerSummary()) {
  const total = Number(taskLedger.total || 0);
  if (!total) {
    return "Tasks: none queued";
  }
  const active = Number(taskLedger.active || 0);
  const counts = [
    `${Number(taskLedger.pending || 0)} pending`,
    `${Number(taskLedger.accepted || 0)} accepted`,
    `${Number(taskLedger.blocked || 0)} blocked`,
    `${Number(taskLedger.completed || 0)} done`,
  ].join(", ");
  const ownerText =
    Array.isArray(taskLedger.owners) && taskLedger.owners.length > 0
      ? `Owners: ${taskLedger.owners
          .map((owner) => {
            const parts = [];
            if (owner.pending) parts.push(`${owner.pending} pending`);
            if (owner.accepted) parts.push(`${owner.accepted} accepted`);
            if (owner.blocked) parts.push(`${owner.blocked} blocked`);
            return `${owner.agentId} (${parts.join("/") || `${owner.active || 0} active`})`;
          })
          .join("; ")}`
      : "Owners: none active";
  const recentText =
    Array.isArray(taskLedger.recent) && taskLedger.recent.length > 0
      ? `Recent tasks: ${taskLedger.recent
          .map((task) => `${task.priority} ${task.status} ${task.owner}: ${task.task}`)
          .join(" | ")}`
      : "";
  return [`Tasks: ${active} active of ${total} total (${counts})`, ownerText, recentText]
    .filter(Boolean)
    .join(". ");
}

function buildWorkPlanText(workPlan = emptyWorkPlanSummary()) {
  if (!workPlan || typeof workPlan !== "object" || !workPlan.exists) {
    return "";
  }
  const open = Number(workPlan.open || 0);
  const completed = Number(workPlan.completed || 0);
  const pathText = normalizeString(workPlan.path) || WORK_PLAN_RELATIVE_PATH;
  const currentSection = normalizeString(workPlan.currentSection);
  const currentText = currentSection ? ` Current: ${currentSection}.` : "";
  const recentOpen = Array.isArray(workPlan.recentOpen) ? workPlan.recentOpen : [];
  const nextText =
    recentOpen.length > 0
      ? ` Next: ${recentOpen
          .map((item) => {
            const section = normalizeString(item.section);
            const task = normalizeString(item.task);
            return section ? `${section} - ${task}` : task;
          })
          .filter(Boolean)
          .join("; ")}.`
      : "";
  const truncatedText = workPlan.truncated ? " Recent window only." : "";
  return `Plan: ${open} open / ${completed} done in ${pathText}.${currentText}${nextText}${truncatedText}`;
}

function roundCurrency(value) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return Math.round(normalized * 1_000_000) / 1_000_000;
}

function normalizeUsageSummary(events = []) {
  const aggregate = aggregateSessionUsage(events);
  const totals = {
    totalTokens: Number(aggregate.totals.totalTokens || 0),
    inputTokens: Number(aggregate.totals.inputTokens || 0),
    outputTokens: Number(aggregate.totals.outputTokens || 0),
    costUsd: roundCurrency(aggregate.totals.costUsd),
    interactions: Number(aggregate.totals.interactions || 0),
  };
  const topAgents = [...aggregate.perAgent.values()]
    .filter(
      (agent) =>
        Number(agent.totalTokens || 0) > 0 ||
        Number(agent.costUsd || 0) > 0 ||
        Number(agent.interactions || 0) > 0,
    )
    .sort((left, right) => {
      const costDelta = Number(right.costUsd || 0) - Number(left.costUsd || 0);
      if (costDelta !== 0) return costDelta;
      const tokenDelta = Number(right.totalTokens || 0) - Number(left.totalTokens || 0);
      if (tokenDelta !== 0) return tokenDelta;
      return normalizeString(left.agentId).localeCompare(normalizeString(right.agentId));
    })
    .slice(0, 3)
    .map((agent) => ({
      agentId: normalizeString(agent.agentId) || "unknown",
      model: normalizeString(agent.model) || "unknown",
      totalTokens: Number(agent.totalTokens || 0),
      inputTokens: Number(agent.inputTokens || 0),
      outputTokens: Number(agent.outputTokens || 0),
      costUsd: roundCurrency(agent.costUsd),
      interactions: Number(agent.interactions || 0),
    }));
  return { totals, topAgents };
}

function buildUsageLedgerText(usageSummary = {}) {
  const totals = usageSummary.totals && typeof usageSummary.totals === "object" ? usageSummary.totals : {};
  const totalTokens = Number(totals.totalTokens || 0);
  const costUsd = roundCurrency(totals.costUsd);
  if (totalTokens <= 0 && costUsd <= 0) {
    return "";
  }
  const topAgents = Array.isArray(usageSummary.topAgents) ? usageSummary.topAgents : [];
  const topText =
    topAgents.length > 0
      ? ` Top agents: ${topAgents
          .map(
            (agent) =>
              `${agent.agentId} ${Number(agent.totalTokens || 0).toLocaleString("en-US")} tokens/$${roundCurrency(agent.costUsd).toFixed(4)}`,
          )
          .join("; ")}.`
      : "";
  return `Usage: ${totalTokens.toLocaleString("en-US")} tokens / $${costUsd.toFixed(4)}.${topText}`;
}

// Multi-agent session etiquette + read-path rules surfaced in the
// context_briefing payload an agent receives on first join. Web
// renders this as markdown (see sentinelayer-web Session.tsx
// SessionMessage), so headers/lists/inline code are intentional.
//
// Keep this short and operationally actionable. Anything that's
// purely doctrinal belongs in AGENTS.md, not the per-join briefing.
const AGENT_JOIN_RULES = [
  "**Welcome to this session.** Quick rules so we coordinate cleanly:",
  "",
  "**Reading the room** — When you join, the recap above summarizes activity since the last quiet stretch. To read further back, run `sl session read --remote --tail 50 --json` (bump `--tail` if you need more). Do this BEFORE responding so you don't repeat questions or miss a lock-and-claim someone else already opened.",
  "",
  "**Polling cadence** — Poll new events at most once per 60s (`sl session listen` or `sl session read --remote --tail N`). `session listen` is only a delivery cursor, not a grounding command; join or recap before acting. More frequent than that wastes budget and can hit per-user rate limits. Less frequent than ~5min and peers may think you went idle.",
  "",
  "**Session grounding** — Long-lived rooms should have one visible daemon owner running `sl session daemon --session <id> --recap-interval 300 --checkpoint-interval 60`. If no durable `session_recap` or `session_checkpoint` is appearing, run `sl session recap now <id> --remote --agent <your-name> --json` before posting a long plan.",
  "",
  "**Writing back** — You can use **markdown**: bold, italic, lists, fenced code, and `inline code`. The web dashboard renders it. Plain text also works. Keep posts terse and technical — link to the work, don't recap it.",
  "",
  "**Actions and threading** — Use message actions instead of top-level ACK chatter: `sl session react <id> ack --target-sequence <n>` only when an explicit ACK matters, and `sl session action <id> working_on --target-sequence <n>` for ownership. Read receipts are automatic when you run `sl session read <id> --remote --agent <your-name>`; reserve `sl session view <id> <sequence>` for repair/backfill. Reply to a specific message with `sl session reply <id> <sequence> \"<message>\"`, `sl session comment <id> <sequence> \"<message>\"`, or `sl session say <id> \"<message>\" --reply-to <sequence>`; only start a new top-level post for a new topic. Run `sl session actions` for the full list.",
  "",
  "**Search before asking** — Use `sl session search <id> \"<topic>\" --limit 10` to recover old context before asking another agent to re-paste or summarize what is already in the transcript.",
  "",
  "**Coordination** — Lock-and-claim before you start a scope another agent could be on. If you push back on someone's approach, cite the specific assumption you disagree with and the file:line evidence.",
  "",
  "**Stop conditions** — If the human asks you to stop, stop. If 60+ minutes of total session silence, stop polling.",
].join("\n");

function buildAgentJoinBriefingText({ recap = "", forAgent = "" } = {}) {
  const trimmedRecap = normalizeString(recap);
  const trimmedAgent = normalizeString(forAgent);
  const greeting = trimmedAgent ? `**${trimmedAgent}** joined. ${trimmedRecap}` : trimmedRecap;
  const recapBlock = greeting || "Welcome — no prior session activity to summarize yet.";
  return `${recapBlock}\n\n---\n\n${AGENT_JOIN_RULES}`;
}

function buildPeriodicText(recap = {}) {
  const summary = recap.summary && typeof recap.summary === "object" ? recap.summary : {};
  const elapsedMinutes = Number(summary.elapsedMinutes || 0);
  const activeAgents = Number(summary.activeAgents || 0);
  const totalFindings = Number(summary.totalFindingsCount || 0);
  const activeLocks = Number(summary.activeLocks || 0);
  const lastActor = normalizeString(summary.lastActorId);
  const actorText = lastActor ? `${lastActor} active` : "no active actor";
  const taskText = buildTaskLedgerText(summary.taskLedger);
  const workPlanText = buildWorkPlanText(summary.workPlan);
  const usageText = buildUsageLedgerText({
    totals: summary.usageTotals,
    topAgents: summary.usageTopAgents,
  });
  return `Session active for ${elapsedMinutes}m. ${activeAgents} agents. ${totalFindings} findings. ${activeLocks} locks. ${taskText}. ${workPlanText} ${usageText} ${actorText}.`.replace(
    /\s+/g,
    " ",
  ).trim();
}

export async function buildSessionRecap(
  sessionId,
  {
    forAgentId = "",
    maxEvents = DEFAULT_RECAP_MAX_EVENTS,
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedMaxEvents = normalizePositiveInteger(maxEvents, DEFAULT_RECAP_MAX_EVENTS);
  const normalizedForAgentId = normalizeString(forAgentId);

  const allEvents = await readStream(normalizedSessionId, {
    targetPath: normalizedTargetPath,
    tail: 0,
  });
  let sessionMetadata = null;
  try {
    sessionMetadata = await getSession(normalizedSessionId, { targetPath: normalizedTargetPath });
  } catch {
    sessionMetadata = null;
  }
  const sortedEvents = sortEventsByConversationTime(dedupeSessionEvents(allEvents), normalizedNow);
  const usageSummary = normalizeUsageSummary(sortedEvents);
  const events = sortedEvents.slice(-normalizedMaxEvents);
  const visibleEvents = (Array.isArray(events) ? events : []).filter((event) => {
    const agentId = normalizeString(event.agent?.id || event.agentId);
    if (!agentId) {
      return true;
    }
    if (agentId === SENTI_AGENT_ID && isRecapEvent(event)) {
      return false;
    }
    return !normalizedForAgentId || agentId.toLowerCase() !== normalizedForAgentId.toLowerCase();
  });

  const activeAgentSet = new Set();
  for (const event of visibleEvents) {
    const agentId = normalizeString(event.agent?.id || event.agentId);
    if (agentId && agentId !== SENTI_AGENT_ID) {
      activeAgentSet.add(agentId);
    }
  }
  const activeAgents = [...activeAgentSet].sort((left, right) => left.localeCompare(right));

  const findingSummary = buildFindingSummary(visibleEvents);
  const totalFindingsCount =
    findingSummary.P0 + findingSummary.P1 + findingSummary.P2 + findingSummary.P3;
  const activeLocks = countActiveLocks(visibleEvents);
  const pendingTasks = await readPendingTasks(normalizedSessionId, {
    forAgentId: normalizedForAgentId,
    targetPath: normalizedTargetPath,
  });
  const taskLedger = await readTaskLedgerSummary(normalizedSessionId, {
    targetPath: normalizedTargetPath,
  });
  const workPlan = await readWorkPlanSummary({
    targetPath: normalizedTargetPath,
  });
  const snippets = summarizeRecentActivity(visibleEvents, {
    forAgentId: normalizedForAgentId,
    limit: 2,
  });
  const windowElapsedMinutes = buildElapsedMinutes(visibleEvents, normalizedNow);
  const elapsedMinutes = buildElapsedMinutes(visibleEvents, normalizedNow, {
    startedAt: sessionMetadata?.createdAt,
  });
  const latestEvent = visibleEvents.length > 0 ? visibleEvents[visibleEvents.length - 1] : null;
  const recapText = buildRecapText({
    activeAgents,
    totalFindings: totalFindingsCount,
    activeLocks,
    pendingTasks,
    taskLedger,
    workPlan,
    usageSummary,
    snippets,
  });

  return {
    sessionId: normalizedSessionId,
    forAgentId: normalizedForAgentId || null,
    generatedAt: normalizedNow,
    ephemeral: true,
    style: RECAP_STYLE,
    text: recapText,
    recap: recapText,
    summary: {
      activeAgents: activeAgents.length,
      activeAgentIds: activeAgents,
      totalFindings: findingSummary,
      totalFindingsCount,
      activeLocks,
      pendingTasksForAgent: pendingTasks,
      taskLedger,
      workPlan,
      usageTotals: usageSummary.totals,
      usageTopAgents: usageSummary.topAgents,
      snippets,
      elapsedMinutes,
      windowElapsedMinutes,
      sessionStartedAt: sessionMetadata?.createdAt
        ? normalizeIsoTimestamp(sessionMetadata.createdAt, normalizedNow)
        : null,
      lastActorId: normalizeString(latestEvent?.agent?.id || latestEvent?.agentId) || null,
      lastEventAt: latestEvent ? normalizeIsoTimestamp(latestEvent.ts, normalizedNow) : null,
    },
  };
}

export async function emitContextBriefing(
  sessionId,
  {
    forAgentId = "",
    maxEvents = DEFAULT_RECAP_MAX_EVENTS,
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    includeJoinRules = true,
    awaitRemoteSync = false,
  } = {}
) {
  const recap = await buildSessionRecap(sessionId, {
    forAgentId,
    maxEvents,
    targetPath,
    nowIso,
  });
  const briefingMessage = includeJoinRules
    ? buildAgentJoinBriefingText({ recap: recap.text, forAgent: forAgentId })
    : recap.text;
  const event = createAgentEvent({
    event: "context_briefing",
    agentId: SENTI_AGENT_ID,
    agentModel: SENTI_MODEL,
    sessionId,
    ts: recap.generatedAt,
    payload: {
      forAgent: normalizeString(forAgentId) || null,
      message: briefingMessage,
      recap: recap.text,
      rules: includeJoinRules ? AGENT_JOIN_RULES : null,
      ephemeral: true,
      style: RECAP_STYLE,
      generatedAt: recap.generatedAt,
      summary: recap.summary,
    },
  });
  const persisted = await appendToStream(sessionId, event, {
    targetPath,
    awaitRemoteSync,
  });
  return {
    recap,
    event: persisted,
  };
}

export async function shouldEmitRecap(
  sessionId,
  agentId,
  {
    lastReadAt = "",
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    newEventThreshold = DEFAULT_RECAP_ACTIVITY_THRESHOLD,
    inactivityMs = DEFAULT_RECAP_INTERVAL_MS,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  const normalizedAgentId = normalizeString(agentId).toLowerCase();
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedInactivityMs = normalizePositiveInteger(inactivityMs, DEFAULT_RECAP_INTERVAL_MS);
  const threshold = normalizePositiveInteger(newEventThreshold, DEFAULT_RECAP_ACTIVITY_THRESHOLD);

  const eventsSinceRead = await readStream(normalizedSessionId, {
    targetPath,
    tail: 0,
    since: normalizeString(lastReadAt) || null,
  });
  const isRelevantSourceEvent = (event = {}) => {
    if (!isMeaningfulRecapSourceEvent(event)) {
      return false;
    }
    const sourceAgent = normalizeString(event.agent?.id || event.agentId).toLowerCase();
    if (!sourceAgent || !normalizedAgentId) {
      return true;
    }
    return sourceAgent !== normalizedAgentId;
  };
  const relevantSinceRead = eventsSinceRead.filter(isRelevantSourceEvent);
  if (relevantSinceRead.length >= threshold) {
    return true;
  }

  const latest = await readStream(normalizedSessionId, {
    targetPath,
    tail: 200,
  });
  const latestRelevant = sortEventsByConversationTime(latest, normalizedNow)
    .filter(isRelevantSourceEvent)
    .at(-1);
  if (!latestRelevant) {
    return false;
  }
  const idleMs = Math.max(0, toEpoch(normalizedNow, normalizedNow) - toEpoch(latestRelevant.ts, normalizedNow));
  return idleMs >= normalizedInactivityMs;
}

export function emitPeriodicRecap(
  sessionId,
  {
    intervalMs = DEFAULT_RECAP_INTERVAL_MS,
    inactivityMs = DEFAULT_RECAP_INACTIVITY_MS,
    newEventThreshold = DEFAULT_RECAP_ACTIVITY_THRESHOLD,
    maxEvents = DEFAULT_RECAP_MAX_EVENTS,
    targetPath = process.cwd(),
    nowProvider = () => new Date().toISOString(),
    onEmit = null,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedIntervalMs = normalizePositiveInteger(intervalMs, DEFAULT_RECAP_INTERVAL_MS);
  const normalizedInactivityMs = normalizePositiveInteger(
    inactivityMs,
    DEFAULT_RECAP_INACTIVITY_MS
  );
  const normalizedNewEventThreshold = normalizePositiveInteger(
    newEventThreshold,
    DEFAULT_RECAP_ACTIVITY_THRESHOLD
  );
  const normalizedMaxEvents = normalizePositiveInteger(maxEvents, DEFAULT_RECAP_MAX_EVENTS);
  const key = buildRecapKey(normalizedSessionId, normalizedTargetPath);
  const existing = ACTIVE_RECAP_EMITTERS.get(key);
  if (existing && existing.running) {
    return existing.handle;
  }

  const state = {
    key,
    running: true,
    startedAt: normalizeIsoTimestamp(nowProvider(), new Date().toISOString()),
    intervalMs: normalizedIntervalMs,
    inactivityMs: normalizedInactivityMs,
    newEventThreshold: normalizedNewEventThreshold,
    maxEvents: normalizedMaxEvents,
    targetPath: normalizedTargetPath,
    sessionId: normalizedSessionId,
    timer: null,
    inFlight: false,
    lastRecapAt: null,
    lastSourceEventAt: null,
    lastSourceSequenceId: null,
    lastSourceCursor: null,
    lastRecapEvent: null,
    lastDecision: null,
    stoppedReason: null,
  };

  const stop = (reason = "manual_stop") => {
    if (!state.running) {
      return {
        stopped: false,
        sessionId: state.sessionId,
        reason: normalizeString(reason) || "manual_stop",
      };
    }
    state.running = false;
    state.stoppedReason = normalizeString(reason) || "manual_stop";
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    ACTIVE_RECAP_EMITTERS.delete(key);
    return {
      stopped: true,
      sessionId: state.sessionId,
      reason: state.stoppedReason,
      lastRecapAt: state.lastRecapAt,
      lastDecision: state.lastDecision,
    };
  };

  const tickNow = async (overrideNowIso = "") => {
    if (!state.running || state.inFlight) {
      return null;
    }
    state.inFlight = true;
    try {
      const nowIso = normalizeIsoTimestamp(
        overrideNowIso || nowProvider(),
        new Date().toISOString()
      );
      const events = await readStream(state.sessionId, {
        targetPath: state.targetPath,
        tail: state.maxEvents,
      });
      const trigger = resolvePeriodicRecapTrigger(state, events, nowIso);
      state.lastDecision = {
        emitted: false,
        mode: trigger.mode,
        reason: trigger.reason,
        policy: trigger.policy,
      };
      if (!trigger.shouldEmit) {
        if (trigger.shouldStop) {
          stop("inactive");
        }
        return null;
      }

      const recap = await buildSessionRecap(state.sessionId, {
        targetPath: state.targetPath,
        maxEvents: state.maxEvents,
        nowIso,
      });
      const text = buildPeriodicText(recap);
      const event = createAgentEvent({
        event: "session_recap",
        agentId: SENTI_AGENT_ID,
        agentModel: SENTI_MODEL,
        sessionId: state.sessionId,
        ts: nowIso,
        payload: {
          mode: trigger.mode,
          recap: text,
          ephemeral: true,
          style: RECAP_STYLE,
          generatedAt: nowIso,
          sourceEventCount: trigger.policy.sourceEventCount,
          latestSourceEventAt: trigger.policy.latestUnrecappedSourceEventAt,
          policy: trigger.policy,
          summary: recap.summary,
        },
      });
      const persisted = await appendToStream(state.sessionId, event, {
        targetPath: state.targetPath,
      });
      state.lastRecapAt = nowIso;
      rememberRecapSource(state, trigger.sourceEvent, nowIso);
      state.lastRecapEvent = persisted;
      state.lastDecision = {
        emitted: true,
        mode: trigger.mode,
        reason: "",
        eventId: persisted.eventId || null,
        sourceEventCount: trigger.policy.sourceEventCount,
        policy: trigger.policy,
      };

      if (typeof onEmit === "function") {
        await onEmit(persisted, recap);
      }
      if (trigger.stopAfterEmit) {
        stop("inactive");
      }
      return persisted;
    } finally {
      state.inFlight = false;
    }
  };

  const handle = {
    sessionId: state.sessionId,
    targetPath: state.targetPath,
    isRunning: () => state.running,
    stop,
    tickNow,
    getState: () => ({
      sessionId: state.sessionId,
      targetPath: state.targetPath,
      startedAt: state.startedAt,
      running: state.running,
      intervalMs: state.intervalMs,
      inactivityMs: state.inactivityMs,
      newEventThreshold: state.newEventThreshold,
      inFlight: state.inFlight,
      lastRecapAt: state.lastRecapAt,
      lastSourceEventAt: state.lastSourceEventAt,
      lastSourceSequenceId: state.lastSourceSequenceId,
      lastDecision: state.lastDecision,
      stoppedReason: state.stoppedReason,
    }),
  };

  state.handle = handle;
  state.timer = setInterval(() => {
    void tickNow().catch(() => {});
  }, state.intervalMs);
  if (typeof state.timer.unref === "function") {
    state.timer.unref();
  }

  ACTIVE_RECAP_EMITTERS.set(key, state);
  return handle;
}

export function getPeriodicRecapEmitter(sessionId, { targetPath = process.cwd() } = {}) {
  const key = buildRecapKey(sessionId, targetPath);
  const state = ACTIVE_RECAP_EMITTERS.get(key);
  return state ? state.handle : null;
}

export {
  ACTIVE_RECAP_EMITTERS,
  DEFAULT_RECAP_ACTIVITY_THRESHOLD,
  DEFAULT_RECAP_INACTIVITY_MS,
  DEFAULT_RECAP_INTERVAL_MS,
  DEFAULT_RECAP_MAX_EVENTS,
  RECAP_STYLE,
};
