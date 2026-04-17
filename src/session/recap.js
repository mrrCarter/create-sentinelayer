import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createAgentEvent } from "../events/schema.js";
import { resolveSessionPaths } from "./paths.js";
import { appendToStream, readStream } from "./stream.js";

const SENTI_AGENT_ID = "senti";
const SENTI_MODEL = "gpt-5.4-mini";
const RECAP_STYLE = "italic-grey";
const DEFAULT_RECAP_MAX_EVENTS = 100;
const DEFAULT_RECAP_INTERVAL_MS = 300_000;
const DEFAULT_RECAP_INACTIVITY_MS = 600_000;
const DEFAULT_RECAP_ACTIVITY_THRESHOLD = 5;

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

function buildElapsedMinutes(events = [], nowIso = new Date().toISOString()) {
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }
  const firstEpoch = toEpoch(events[0]?.ts, nowIso);
  const nowEpoch = toEpoch(nowIso, nowIso);
  if (!Number.isFinite(firstEpoch) || !Number.isFinite(nowEpoch) || nowEpoch <= firstEpoch) {
    return 0;
  }
  return Math.max(0, Math.floor((nowEpoch - firstEpoch) / 60_000));
}

function buildRecapKey(sessionId, targetPath) {
  return `${path.resolve(String(targetPath || "."))}::${normalizeString(sessionId)}`;
}

function buildRecapText({
  activeAgents = [],
  totalFindings = 0,
  activeLocks = 0,
  pendingTasks = 0,
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
  const snippetText = snippets.length > 0 ? `Recent: ${snippets.join(" | ")}` : "";
  return `While you were away: ${agentText}. ${findingText}. ${lockText}. ${pendingText} ${snippetText}`.replace(
    /\s+/g,
    " "
  ).trim();
}

function buildPeriodicText(recap = {}) {
  const summary = recap.summary && typeof recap.summary === "object" ? recap.summary : {};
  const elapsedMinutes = Number(summary.elapsedMinutes || 0);
  const activeAgents = Number(summary.activeAgents || 0);
  const totalFindings = Number(summary.totalFindingsCount || 0);
  const activeLocks = Number(summary.activeLocks || 0);
  const lastActor = normalizeString(summary.lastActorId);
  const actorText = lastActor ? `${lastActor} active` : "no active actor";
  return `Session active for ${elapsedMinutes}m. ${activeAgents} agents. ${totalFindings} findings. ${activeLocks} locks. ${actorText}.`;
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

  const events = await readStream(normalizedSessionId, {
    targetPath: normalizedTargetPath,
    tail: normalizedMaxEvents,
  });
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
  const snippets = summarizeRecentActivity(visibleEvents, {
    forAgentId: normalizedForAgentId,
    limit: 2,
  });
  const elapsedMinutes = buildElapsedMinutes(visibleEvents, normalizedNow);
  const latestEvent = visibleEvents.length > 0 ? visibleEvents[visibleEvents.length - 1] : null;
  const recapText = buildRecapText({
    activeAgents,
    totalFindings: totalFindingsCount,
    activeLocks,
    pendingTasks,
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
      snippets,
      elapsedMinutes,
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
  } = {}
) {
  const recap = await buildSessionRecap(sessionId, {
    forAgentId,
    maxEvents,
    targetPath,
    nowIso,
  });
  const event = createAgentEvent({
    event: "context_briefing",
    agentId: SENTI_AGENT_ID,
    agentModel: SENTI_MODEL,
    sessionId,
    ts: recap.generatedAt,
    payload: {
      forAgent: normalizeString(forAgentId) || null,
      recap: recap.text,
      ephemeral: true,
      style: RECAP_STYLE,
      generatedAt: recap.generatedAt,
    },
  });
  const persisted = await appendToStream(sessionId, event, {
    targetPath,
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
  const relevantSinceRead = eventsSinceRead.filter((event) => {
    if (isRecapEvent(event)) {
      return false;
    }
    const sourceAgent = normalizeString(event.agent?.id || event.agentId).toLowerCase();
    if (!sourceAgent || !normalizedAgentId) {
      return true;
    }
    return sourceAgent !== normalizedAgentId;
  });
  if (relevantSinceRead.length > threshold) {
    return true;
  }

  const latest = await readStream(normalizedSessionId, {
    targetPath,
    tail: 1,
  });
  const latestEvent = latest.length > 0 ? latest[latest.length - 1] : null;
  if (!latestEvent || isRecapEvent(latestEvent)) {
    return false;
  }
  const idleMs = Math.max(0, toEpoch(normalizedNow, normalizedNow) - toEpoch(latestEvent.ts, normalizedNow));
  return idleMs >= normalizedInactivityMs;
}

export function emitPeriodicRecap(
  sessionId,
  {
    intervalMs = DEFAULT_RECAP_INTERVAL_MS,
    inactivityMs = DEFAULT_RECAP_INACTIVITY_MS,
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
    maxEvents: normalizedMaxEvents,
    targetPath: normalizedTargetPath,
    sessionId: normalizedSessionId,
    timer: null,
    lastRecapAt: null,
    lastSourceEventAt: null,
    lastRecapEvent: null,
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
    };
  };

  const tickNow = async () => {
    if (!state.running) {
      return null;
    }
    const nowIso = normalizeIsoTimestamp(nowProvider(), new Date().toISOString());
    const nowEpoch = toEpoch(nowIso, nowIso);
    const events = await readStream(state.sessionId, {
      targetPath: state.targetPath,
      tail: state.maxEvents,
    });
    const nonRecapEvents = events.filter((event) => !isRecapEvent(event));
    const latestSourceEvent = nonRecapEvents.length > 0 ? nonRecapEvents[nonRecapEvents.length - 1] : null;
    if (!latestSourceEvent) {
      return null;
    }

    const latestSourceEpoch = toEpoch(latestSourceEvent.ts, nowIso);
    const idleMs = Math.max(0, nowEpoch - latestSourceEpoch);
    if (idleMs >= state.inactivityMs) {
      stop("inactive");
      return null;
    }

    if (state.lastRecapAt) {
      const sinceLastRecapMs = Math.max(0, nowEpoch - toEpoch(state.lastRecapAt, nowIso));
      if (sinceLastRecapMs < state.intervalMs) {
        return null;
      }
    }
    if (state.lastSourceEventAt) {
      const previousSourceEpoch = toEpoch(state.lastSourceEventAt, nowIso);
      if (latestSourceEpoch <= previousSourceEpoch) {
        return null;
      }
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
        mode: "periodic",
        recap: text,
        ephemeral: true,
        style: RECAP_STYLE,
        generatedAt: nowIso,
      },
    });
    const persisted = await appendToStream(state.sessionId, event, {
      targetPath: state.targetPath,
    });
    state.lastRecapAt = nowIso;
    state.lastSourceEventAt = normalizeIsoTimestamp(latestSourceEvent.ts, nowIso);
    state.lastRecapEvent = persisted;

    if (typeof onEmit === "function") {
      await onEmit(persisted, recap);
    }
    return persisted;
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
      lastRecapAt: state.lastRecapAt,
      lastSourceEventAt: state.lastSourceEventAt,
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
  DEFAULT_RECAP_INACTIVITY_MS,
  DEFAULT_RECAP_INTERVAL_MS,
  DEFAULT_RECAP_MAX_EVENTS,
  RECAP_STYLE,
};
