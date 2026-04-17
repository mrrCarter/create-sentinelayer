import path from "node:path";
import process from "node:process";

import { createAgentEvent } from "../events/schema.js";
import {
  detectStaleAgents,
  heartbeatAgent,
  listAgents,
  registerAgent,
  unregisterAgent,
} from "./agent-registry.js";
import { resolveSessionPaths } from "./paths.js";
import { stopRuntimeRunsForSession } from "./runtime-bridge.js";
import { getSession, renewSession } from "./store.js";
import { appendToStream, readStream, tailStream } from "./stream.js";

const DAEMON_TICK_INTERVAL_MS = 30_000;
const HELP_REQUEST_TIMEOUT_MS = 30_000;
const FILE_CONFLICT_WINDOW_MS = 60_000;
const RENEWAL_WINDOW_MS = 60 * 60 * 1000;
const RENEWAL_THRESHOLD_EVENTS = 10;
const RENEWAL_LEAD_MS = 60 * 60 * 1000;
const DEFAULT_STALE_AGENT_SECONDS = 90;

const SENTI_MODEL = "gpt-5.4-mini";
const SENTI_IDENTITY = Object.freeze({
  id: "senti",
  model: SENTI_MODEL,
  persona: "Senti",
  fullName: "Senti - SentinelLayer Session Daemon",
  role: "daemon",
  color: "magenta",
  description:
    "Session moderator, health monitor, and context provider. Short for SentinelLayer - your AI team lead.",
});

const ACTIVE_SENTI_DAEMONS = new Map();

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

function buildDaemonKey(sessionId, targetPath) {
  return `${path.resolve(String(targetPath || "."))}::${normalizeString(sessionId)}`;
}

async function emitSentiEvent(
  sessionId,
  event,
  payload = {},
  { targetPath = process.cwd(), nowIso = new Date().toISOString() } = {}
) {
  const envelope = createAgentEvent({
    event,
    agentId: SENTI_IDENTITY.id,
    agentModel: SENTI_IDENTITY.model,
    sessionId,
    ts: normalizeIsoTimestamp(nowIso, new Date().toISOString()),
    payload,
  });
  await appendToStream(sessionId, envelope, {
    targetPath,
  });
  return envelope;
}

function formatCodebaseSynopsis(session = {}) {
  const summary = session.codebaseContext?.summary || {};
  const loc = Number(summary.totalLoc || 0);
  const files = Number(summary.filesScanned || 0);
  const frameworks = Array.isArray(session.codebaseContext?.frameworks)
    ? session.codebaseContext.frameworks
    : [];
  const frameworkText = frameworks.length > 0 ? frameworks.slice(0, 3).join(", ") : "unknown stack";
  return `${frameworkText}, ${files} files, ${loc.toLocaleString("en-US")} LOC`;
}

function buildWelcomeMessage(session = {}, activeAgents = []) {
  const roster = activeAgents
    .filter((agent) => normalizeString(agent.agentId) !== SENTI_IDENTITY.id)
    .map((agent) => `${agent.agentId} (${agent.status || "idle"})`)
    .slice(0, 6);
  const rosterText = roster.length > 0 ? roster.join(", ") : "no active agents yet";
  return `Senti here. Session ${session.sessionId} is live. Codebase: ${formatCodebaseSynopsis(
    session
  )}. Active agents: ${rosterText}. Talk to me with @senti or /senti.`;
}

async function upsertSentiAgent(sessionId, { targetPath = process.cwd(), model = SENTI_MODEL } = {}) {
  const activeAgents = await listAgents(sessionId, {
    targetPath,
    includeInactive: true,
  });
  const existing = activeAgents.find((agent) => normalizeString(agent.agentId) === SENTI_IDENTITY.id);
  if (!existing) {
    return registerAgent(sessionId, {
      agentId: SENTI_IDENTITY.id,
      model,
      role: "daemon",
      targetPath,
    });
  }
  return heartbeatAgent(sessionId, SENTI_IDENTITY.id, {
    status: "watching",
    detail: "Monitoring session health and help requests.",
    targetPath,
  });
}

function createSentiState({
  daemonKey,
  sessionId,
  targetPath,
  startedAt,
  model,
  staleAgentSeconds,
  helpRequestTimeoutMs,
  tickIntervalMs,
  helpResponder,
}) {
  return {
    daemonKey,
    sessionId,
    targetPath,
    startedAt,
    model,
    staleAgentSeconds,
    helpRequestTimeoutMs,
    tickIntervalMs,
    helpResponder,
    running: true,
    tickTimer: null,
    helpAbortController: new AbortController(),
    pendingHelpTimers: new Map(),
    staleAlertedAgents: new Set(),
    fileActivity: new Map(),
    conflictAlertAt: new Map(),
    lastTickAt: null,
    lastTickSummary: null,
  };
}

async function hasHelpResponseFromPeer(
  sessionId,
  requestEvent,
  {
    targetPath = process.cwd(),
  } = {}
) {
  const requester = normalizeString(requestEvent?.agent?.id);
  const requestTs = normalizeIsoTimestamp(requestEvent?.ts, new Date().toISOString());
  const events = await readStream(sessionId, {
    targetPath,
    tail: 0,
    since: requestTs,
  });
  const requestEpoch = Date.parse(requestTs) || 0;
  return events.some((event) => {
    const eventAgentId = normalizeString(event.agent?.id);
    const eventEpoch = Date.parse(normalizeIsoTimestamp(event.ts, requestTs)) || 0;
    if (eventEpoch <= requestEpoch) {
      return false;
    }
    if (!eventAgentId || eventAgentId === SENTI_IDENTITY.id || eventAgentId === requester) {
      return false;
    }
    return true;
  });
}

async function buildHelpResponseMessage(
  daemonState,
  requestEvent,
  {
    targetPath = process.cwd(),
  } = {}
) {
  if (typeof daemonState.helpResponder === "function") {
    const custom = await daemonState.helpResponder({
      daemonState,
      requestEvent,
      targetPath,
    });
    const normalizedCustom = normalizeString(custom);
    if (normalizedCustom) {
      return normalizedCustom;
    }
  }

  const session = await getSession(daemonState.sessionId, {
    targetPath,
  });
  const synopsis = session ? formatCodebaseSynopsis(session) : "codebase context unavailable";
  const requestMessage =
    normalizeString(requestEvent?.payload?.message) ||
    normalizeString(requestEvent?.payload?.request) ||
    "help request received";
  return `I saw your help_request ("${requestMessage}"). Quick context: ${synopsis}. Share the failing file or stack frame and I can route next steps.`;
}

async function maybeRespondToHelpRequest(
  daemonState,
  requestEvent,
  {
    targetPath = process.cwd(),
  } = {}
) {
  const requestId =
    normalizeString(requestEvent.requestId) ||
    normalizeString(requestEvent.payload?.requestId) ||
    `${normalizeIsoTimestamp(requestEvent.ts)}:${normalizeString(requestEvent.agent?.id)}`;
  if (!requestId) {
    return null;
  }
  const hasPeerResponse = await hasHelpResponseFromPeer(daemonState.sessionId, requestEvent, {
    targetPath,
  });
  if (hasPeerResponse) {
    return null;
  }
  const responseMessage = await buildHelpResponseMessage(daemonState, requestEvent, {
    targetPath,
  });
  return emitSentiEvent(
    daemonState.sessionId,
    "help_response",
    {
      requestId,
      targetAgentId: normalizeString(requestEvent.agent?.id) || null,
      response: responseMessage,
      sourceEvent: "help_request",
    },
    {
      targetPath,
      nowIso: new Date().toISOString(),
    }
  );
}

function queueHelpResponse(daemonState, requestEvent) {
  if (!daemonState.running) {
    return;
  }
  const requestId =
    normalizeString(requestEvent.requestId) ||
    normalizeString(requestEvent.payload?.requestId) ||
    `${normalizeIsoTimestamp(requestEvent.ts)}:${normalizeString(requestEvent.agent?.id)}`;
  if (!requestId || daemonState.pendingHelpTimers.has(requestId)) {
    return;
  }
  const timer = setTimeout(() => {
    daemonState.pendingHelpTimers.delete(requestId);
    void maybeRespondToHelpRequest(daemonState, requestEvent, {
      targetPath: daemonState.targetPath,
    }).catch(() => {});
  }, daemonState.helpRequestTimeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  daemonState.pendingHelpTimers.set(requestId, timer);
}

async function runHelpWatcher(daemonState) {
  const signal = daemonState.helpAbortController.signal;
  try {
    for await (const event of tailStream(daemonState.sessionId, {
      targetPath: daemonState.targetPath,
      signal,
      since: daemonState.startedAt,
      replayTail: 0,
      pollMs: Math.max(25, Math.min(250, Math.floor(daemonState.helpRequestTimeoutMs / 4))),
    })) {
      if (!daemonState.running) {
        return;
      }
      if (normalizeString(event.event) !== "help_request") {
        continue;
      }
      if (normalizeString(event.agent?.id) === SENTI_IDENTITY.id) {
        continue;
      }
      queueHelpResponse(daemonState, event);
    }
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      return;
    }
    throw error;
  }
}

function buildConflictSignature(agentA, agentB, filePath) {
  const pair = [normalizeString(agentA), normalizeString(agentB)].filter(Boolean).sort().join("|");
  return `${pair}::${normalizeString(filePath).replace(/\\/g, "/")}`;
}

function parseEpoch(value, fallbackIso = new Date().toISOString()) {
  return Date.parse(normalizeIsoTimestamp(value, fallbackIso)) || 0;
}

function createHealthSummaryBase(nowIso, session, agents) {
  return {
    sessionId: session.sessionId,
    generatedAt: normalizeIsoTimestamp(nowIso, new Date().toISOString()),
    expiresAt: session.expiresAt,
    activeAgentCount: agents.filter((agent) => normalizeString(agent.agentId) !== SENTI_IDENTITY.id).length,
    staleAgents: [],
    conflictAlerts: [],
    renewed: null,
  };
}

async function emitStaleAndRecoveryAlerts(
  daemonState,
  summary,
  staleAgents = [],
  nowIso = new Date().toISOString()
) {
  const staleIds = new Set(staleAgents.map((agent) => normalizeString(agent.agentId)));

  for (const staleAgent of staleAgents) {
    const staleId = normalizeString(staleAgent.agentId);
    if (!staleId || daemonState.staleAlertedAgents.has(staleId)) {
      continue;
    }
    daemonState.staleAlertedAgents.add(staleId);
    const alert = await emitSentiEvent(
      daemonState.sessionId,
      "daemon_alert",
      {
        alert: "stuck_detected",
        targetAgentId: staleId,
        idleSeconds: staleAgent.idleSeconds,
        thresholdSeconds: daemonState.staleAgentSeconds,
      },
      {
        targetPath: daemonState.targetPath,
        nowIso,
      }
    );
    summary.staleAgents.push({
      agentId: staleId,
      idleSeconds: staleAgent.idleSeconds,
      event: alert,
    });
  }

  for (const previousStaleId of [...daemonState.staleAlertedAgents]) {
    if (staleIds.has(previousStaleId)) {
      continue;
    }
    daemonState.staleAlertedAgents.delete(previousStaleId);
    await emitSentiEvent(
      daemonState.sessionId,
      "daemon_alert",
      {
        alert: "stuck_recovered",
        targetAgentId: previousStaleId,
      },
      {
        targetPath: daemonState.targetPath,
        nowIso,
      }
    );
  }
}

async function emitConflictAlerts(
  daemonState,
  summary,
  agents = [],
  nowIso = new Date().toISOString()
) {
  const nowEpoch = parseEpoch(nowIso, nowIso);
  const staleCutoff = nowEpoch - FILE_CONFLICT_WINDOW_MS * 2;

  for (const [filePath, record] of daemonState.fileActivity.entries()) {
    if (!record || Number(record.timestamp || 0) < staleCutoff) {
      daemonState.fileActivity.delete(filePath);
    }
  }
  for (const [signature, epoch] of daemonState.conflictAlertAt.entries()) {
    if (Number(epoch || 0) < staleCutoff) {
      daemonState.conflictAlertAt.delete(signature);
    }
  }

  for (const agent of agents) {
    const agentId = normalizeString(agent.agentId);
    if (!agentId || agentId === SENTI_IDENTITY.id) {
      continue;
    }
    const filePath = normalizeString(agent.file).replace(/\\/g, "/");
    if (!filePath) {
      continue;
    }
    const activityEpoch = parseEpoch(agent.lastActivityAt, nowIso);
    const previous = daemonState.fileActivity.get(filePath) || null;
    if (previous && previous.agentId !== agentId) {
      const deltaMs = Math.abs(activityEpoch - Number(previous.timestamp || 0));
      if (deltaMs <= FILE_CONFLICT_WINDOW_MS) {
        const signature = buildConflictSignature(previous.agentId, agentId, filePath);
        const lastAlertEpoch = Number(daemonState.conflictAlertAt.get(signature) || 0);
        if (nowEpoch - lastAlertEpoch >= FILE_CONFLICT_WINDOW_MS) {
          const event = await emitSentiEvent(
            daemonState.sessionId,
            "daemon_alert",
            {
              alert: "file_conflict",
              file: filePath,
              agentA: previous.agentId,
              agentB: agentId,
              previousSeenAt: normalizeIsoTimestamp(previous.activityAt, nowIso),
              currentSeenAt: normalizeIsoTimestamp(agent.lastActivityAt, nowIso),
              suggestion: `${previous.agentId} and ${agentId} are touching ${filePath}. Coordinate before editing.`,
            },
            {
              targetPath: daemonState.targetPath,
              nowIso,
            }
          );
          daemonState.conflictAlertAt.set(signature, nowEpoch);
          summary.conflictAlerts.push({
            file: filePath,
            agentA: previous.agentId,
            agentB: agentId,
            event,
          });
        }
      }
    }

    daemonState.fileActivity.set(filePath, {
      agentId,
      activityAt: normalizeIsoTimestamp(agent.lastActivityAt, nowIso),
      timestamp: activityEpoch,
    });
  }
}

async function maybeRenewActiveSession(
  daemonState,
  summary,
  session,
  nowIso = new Date().toISOString()
) {
  const nowEpoch = parseEpoch(nowIso, nowIso);
  const expiryEpoch = parseEpoch(session.expiresAt, nowIso);
  if (!Number.isFinite(expiryEpoch) || expiryEpoch <= nowEpoch) {
    return;
  }
  if (expiryEpoch - nowEpoch > RENEWAL_LEAD_MS) {
    return;
  }
  const recentSinceIso = new Date(nowEpoch - RENEWAL_WINDOW_MS).toISOString();
  const recentEvents = await readStream(daemonState.sessionId, {
    targetPath: daemonState.targetPath,
    tail: 0,
    since: recentSinceIso,
  });
  if (recentEvents.length <= RENEWAL_THRESHOLD_EVENTS) {
    return;
  }
  const renewed = await renewSession(daemonState.sessionId, {
    targetPath: daemonState.targetPath,
  });
  summary.renewed = {
    renewalCount: renewed.renewalCount,
    expiresAt: renewed.expiresAt,
  };
}

export async function runSentiHealthTick(
  sessionId,
  {
    targetPath = process.cwd(),
    nowIso = new Date().toISOString(),
    staleAgentSeconds = DEFAULT_STALE_AGENT_SECONDS,
    daemonState = null,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const session = await getSession(normalizedSessionId, {
    targetPath: normalizedTargetPath,
  });
  if (!session) {
    throw new Error(`Session '${normalizedSessionId}' was not found.`);
  }

  const resolvedDaemonState =
    daemonState ||
    createSentiState({
      daemonKey: buildDaemonKey(normalizedSessionId, normalizedTargetPath),
      sessionId: normalizedSessionId,
      targetPath: normalizedTargetPath,
      startedAt: normalizeIsoTimestamp(nowIso, nowIso),
      model: SENTI_MODEL,
      staleAgentSeconds,
      helpRequestTimeoutMs: HELP_REQUEST_TIMEOUT_MS,
      tickIntervalMs: DAEMON_TICK_INTERVAL_MS,
      helpResponder: null,
    });
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const activeAgents = await listAgents(normalizedSessionId, {
    targetPath: normalizedTargetPath,
    includeInactive: false,
  });
  const filteredAgents = activeAgents.filter((agent) => normalizeString(agent.agentId) !== SENTI_IDENTITY.id);
  const staleAgents = detectStaleAgents(filteredAgents, {
    idleThresholdSeconds: normalizePositiveInteger(
      staleAgentSeconds,
      normalizePositiveInteger(resolvedDaemonState.staleAgentSeconds, DEFAULT_STALE_AGENT_SECONDS)
    ),
    nowIso: normalizedNow,
  });

  const summary = createHealthSummaryBase(normalizedNow, session, activeAgents);
  await emitStaleAndRecoveryAlerts(resolvedDaemonState, summary, staleAgents, normalizedNow);
  await emitConflictAlerts(resolvedDaemonState, summary, filteredAgents, normalizedNow);
  await maybeRenewActiveSession(resolvedDaemonState, summary, session, normalizedNow);
  return summary;
}

export async function startSenti(
  sessionId,
  {
    model = SENTI_MODEL,
    targetPath = process.cwd(),
    autoStart = true,
    tickIntervalMs = DAEMON_TICK_INTERVAL_MS,
    staleAgentSeconds = DEFAULT_STALE_AGENT_SECONDS,
    helpRequestTimeoutMs = HELP_REQUEST_TIMEOUT_MS,
    helpResponder = null,
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const daemonKey = buildDaemonKey(normalizedSessionId, normalizedTargetPath);
  const existing = ACTIVE_SENTI_DAEMONS.get(daemonKey);
  if (existing && existing.running) {
    return existing.handle;
  }

  const session = await getSession(normalizedSessionId, {
    targetPath: normalizedTargetPath,
  });
  if (!session) {
    throw new Error(`Session '${normalizedSessionId}' was not found.`);
  }

  const normalizedTickIntervalMs = normalizePositiveInteger(tickIntervalMs, DAEMON_TICK_INTERVAL_MS);
  const normalizedHelpTimeoutMs = normalizePositiveInteger(
    helpRequestTimeoutMs,
    HELP_REQUEST_TIMEOUT_MS
  );
  const normalizedStaleSeconds = normalizePositiveInteger(
    staleAgentSeconds,
    DEFAULT_STALE_AGENT_SECONDS
  );
  const nowIso = new Date().toISOString();
  const daemonState = createSentiState({
    daemonKey,
    sessionId: normalizedSessionId,
    targetPath: normalizedTargetPath,
    startedAt: nowIso,
    model: normalizeString(model) || SENTI_MODEL,
    staleAgentSeconds: normalizedStaleSeconds,
    helpRequestTimeoutMs: normalizedHelpTimeoutMs,
    tickIntervalMs: normalizedTickIntervalMs,
    helpResponder,
  });

  await upsertSentiAgent(normalizedSessionId, {
    targetPath: normalizedTargetPath,
    model: daemonState.model,
  });
  const activeAgents = await listAgents(normalizedSessionId, {
    targetPath: normalizedTargetPath,
    includeInactive: false,
  });
  await emitSentiEvent(
    normalizedSessionId,
    "daemon_alert",
    {
      alert: "senti_online",
      model: daemonState.model,
      message: buildWelcomeMessage(session, activeAgents),
      codebaseSynopsis: formatCodebaseSynopsis(session),
      activeAgents: activeAgents
        .filter((agent) => normalizeString(agent.agentId) !== SENTI_IDENTITY.id)
        .map((agent) => ({
          agentId: agent.agentId,
          status: agent.status,
          role: agent.role,
        })),
    },
    {
      targetPath: normalizedTargetPath,
      nowIso,
    }
  );

  const runTick = async (tickNowIso = new Date().toISOString()) => {
    if (!daemonState.running) {
      return daemonState.lastTickSummary;
    }
    const summary = await runSentiHealthTick(normalizedSessionId, {
      targetPath: normalizedTargetPath,
      nowIso: tickNowIso,
      staleAgentSeconds: daemonState.staleAgentSeconds,
      daemonState,
    });
    daemonState.lastTickAt = normalizeIsoTimestamp(tickNowIso, new Date().toISOString());
    daemonState.lastTickSummary = summary;
    return summary;
  };

  const stop = async (reason = "manual_stop") => {
    if (!daemonState.running) {
      return {
        stopped: false,
        daemonKey,
        reason: normalizeString(reason) || "manual_stop",
      };
    }

    daemonState.running = false;
    if (daemonState.tickTimer) {
      clearInterval(daemonState.tickTimer);
      daemonState.tickTimer = null;
    }
    daemonState.helpAbortController.abort();
    for (const timer of daemonState.pendingHelpTimers.values()) {
      clearTimeout(timer);
    }
    daemonState.pendingHelpTimers.clear();

    let runtimeStopSummary = null;
    try {
      runtimeStopSummary = await stopRuntimeRunsForSession(normalizedSessionId, {
        targetPath: normalizedTargetPath,
        reason: "manual_stop",
      });
    } catch {
      runtimeStopSummary = {
        sessionId: normalizedSessionId,
        targetPath: normalizedTargetPath,
        stoppedCount: 0,
        runs: [],
      };
    }

    try {
      await unregisterAgent(normalizedSessionId, SENTI_IDENTITY.id, {
        reason: "killed",
        targetPath: normalizedTargetPath,
      });
    } catch {
      // Non-blocking: if snapshot is already gone, continue to emit explicit kill event.
    }

    const killedEvent = await emitSentiEvent(
      normalizedSessionId,
      "agent_killed",
      {
        target: SENTI_IDENTITY.id,
        reason: normalizeString(reason) || "manual_stop",
        runtimeStops: runtimeStopSummary?.stoppedCount || 0,
      },
      {
        targetPath: normalizedTargetPath,
        nowIso: new Date().toISOString(),
      }
    );
    ACTIVE_SENTI_DAEMONS.delete(daemonKey);
    return {
      stopped: true,
      daemonKey,
      sessionId: normalizedSessionId,
      targetPath: normalizedTargetPath,
      reason: normalizeString(reason) || "manual_stop",
      runtimeStopSummary,
      event: killedEvent,
    };
  };

  const handle = {
    daemonKey,
    sessionId: normalizedSessionId,
    targetPath: normalizedTargetPath,
    startedAt: nowIso,
    model: daemonState.model,
    runTick,
    stop,
    isRunning: () => daemonState.running,
    getState: () => ({
      daemonKey,
      sessionId: normalizedSessionId,
      targetPath: normalizedTargetPath,
      startedAt: nowIso,
      running: daemonState.running,
      lastTickAt: daemonState.lastTickAt,
      staleAlertedAgents: [...daemonState.staleAlertedAgents],
      pendingHelpRequests: daemonState.pendingHelpTimers.size,
    }),
  };

  daemonState.handle = handle;
  ACTIVE_SENTI_DAEMONS.set(daemonKey, daemonState);

  void runHelpWatcher(daemonState).catch(() => {});

  if (autoStart) {
    await runTick(nowIso);
    daemonState.tickTimer = setInterval(() => {
      void runTick(new Date().toISOString()).catch(() => {});
    }, normalizedTickIntervalMs);
    if (typeof daemonState.tickTimer.unref === "function") {
      daemonState.tickTimer.unref();
    }
  }

  return handle;
}

export async function stopSenti(
  sessionId,
  {
    targetPath = process.cwd(),
    reason = "manual_stop",
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const daemonKey = buildDaemonKey(normalizedSessionId, normalizedTargetPath);
  const daemonState = ACTIVE_SENTI_DAEMONS.get(daemonKey);
  if (!daemonState || !daemonState.running) {
    return {
      stopped: false,
      daemonKey,
      sessionId: normalizedSessionId,
      targetPath: normalizedTargetPath,
      reason: normalizeString(reason) || "manual_stop",
    };
  }
  return daemonState.handle.stop(reason);
}

export function getSentiDaemon(
  sessionId,
  {
    targetPath = process.cwd(),
  } = {}
) {
  const daemonKey = buildDaemonKey(sessionId, targetPath);
  const daemonState = ACTIVE_SENTI_DAEMONS.get(daemonKey);
  return daemonState ? daemonState.handle : null;
}

export {
  ACTIVE_SENTI_DAEMONS,
  DAEMON_TICK_INTERVAL_MS,
  DEFAULT_STALE_AGENT_SECONDS,
  FILE_CONFLICT_WINDOW_MS,
  HELP_REQUEST_TIMEOUT_MS,
  RENEWAL_LEAD_MS,
  RENEWAL_THRESHOLD_EVENTS,
  RENEWAL_WINDOW_MS,
  SENTI_IDENTITY,
  SENTI_MODEL,
};
