import path from "node:path";
import process from "node:process";
import fsp from "node:fs/promises";

import { invokeViaProxy } from "../ai/proxy.js";
import { createAgentEvent } from "../events/schema.js";
import {
  buildDocumentsFromBlackboardEntries,
  buildLocalHybridIndex,
  buildSharedMemoryCorpus,
  queryLocalHybridIndex,
} from "../memory/retrieval.js";
import {
  endSession as endTelemetrySession,
  recordLlmUsage,
  startSession as startTelemetrySession,
} from "../telemetry/session-tracker.js";
import {
  detectStaleAgents,
  heartbeatAgent,
  listAgents,
  registerAgent,
  unregisterAgent,
} from "./agent-registry.js";
import {
  DEFAULT_FILE_LOCK_TTL_SECONDS,
  lockFile,
  unlockFile,
} from "./file-locks.js";
import { resolveSessionPaths } from "./paths.js";
import {
  DEFAULT_RECAP_INACTIVITY_MS,
  DEFAULT_RECAP_INTERVAL_MS,
  emitPeriodicRecap,
} from "./recap.js";
import { stopRuntimeRunsForSession } from "./runtime-bridge.js";
import { getSession, renewSession } from "./store.js";
import { appendToStream, readStream, tailStream } from "./stream.js";
import { handleTaskDirective } from "./tasks.js";

const DAEMON_TICK_INTERVAL_MS = 30_000;
const HELP_REQUEST_TIMEOUT_MS = 1_200;
const HELP_MODEL_TIMEOUT_MS = 3_000;
const HELP_CONTEXT_EVENT_TAIL = 50;
const HELP_CONTEXT_RESULT_LIMIT = 6;
const HELP_BLACKBOARD_ENTRY_LIMIT = 40;
const FILE_CONFLICT_WINDOW_MS = 60_000;
const RENEWAL_WINDOW_MS = 60 * 60 * 1000;
const RENEWAL_THRESHOLD_EVENTS = 10;
const RENEWAL_LEAD_MS = 60 * 60 * 1000;
const DEFAULT_STALE_AGENT_SECONDS = 90;
const DEFAULT_RECAP_INTERVAL_MS_OVERRIDE = DEFAULT_RECAP_INTERVAL_MS;
const DEFAULT_RECAP_INACTIVITY_MS_OVERRIDE = DEFAULT_RECAP_INACTIVITY_MS;

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
  recapIntervalMs,
  recapInactivityMs,
  helpResponder,
  llmInvoker,
  telemetrySessionId,
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
    recapIntervalMs,
    recapInactivityMs,
    helpResponder,
    llmInvoker,
    telemetrySessionId,
    running: true,
    tickTimer: null,
    helpAbortController: new AbortController(),
    pendingHelpTimers: new Map(),
    staleAlertedAgents: new Set(),
    fileActivity: new Map(),
    conflictAlertAt: new Map(),
    lastTickAt: null,
    lastTickSummary: null,
    recapEmitter: null,
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

function normalizeUsageNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return normalized;
}

function buildStreamContextDocuments(events = []) {
  return (events || [])
    .map((event, index) => {
      const payload = event && typeof event.payload === "object" ? event.payload : {};
      const text = [
        normalizeString(event.event),
        normalizeString(event.agent?.id || event.agentId),
        normalizeString(payload.message),
        normalizeString(payload.response),
        normalizeString(payload.alert),
        normalizeString(payload.reason),
        normalizeString(payload.file),
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!text) {
        return null;
      }
      return {
        documentId: `stream:${index + 1}:${normalizeIsoTimestamp(event.ts, new Date().toISOString())}`,
        sourceType: "session-stream",
        sourcePath: "",
        severity: "P3",
        updatedAt: normalizeIsoTimestamp(event.ts, new Date().toISOString()),
        text,
        metadata: {
          category: "session-stream",
          event: normalizeString(event.event),
          agentId: normalizeString(event.agent?.id || event.agentId),
        },
      };
    })
    .filter(Boolean);
}

async function loadLatestBlackboardEntries(targetPath, { limit = HELP_BLACKBOARD_ENTRY_LIMIT } = {}) {
  const memoryDirectory = path.join(targetPath, ".sentinelayer", "memory");
  let entries = [];
  try {
    entries = await fsp.readdir(memoryDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("blackboard-") && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const fileName of files) {
    const filePath = path.join(memoryDirectory, fileName);
    try {
      const payload = JSON.parse(await fsp.readFile(filePath, "utf-8"));
      if (!Array.isArray(payload.entries)) {
        continue;
      }
      return payload.entries.slice(-Math.max(1, Math.floor(Number(limit) || HELP_BLACKBOARD_ENTRY_LIMIT)));
    } catch {
      // Ignore malformed artifacts and continue searching older files.
    }
  }
  return [];
}

function buildFallbackHelpResponse({ requestMessage = "", synopsis = "context unavailable", contextHints = [] } = {}) {
  const topHints = contextHints.slice(0, 2).join(" | ");
  if (topHints) {
    return `I saw your help_request ("${requestMessage}"). Quick context: ${synopsis}. Top hints: ${topHints}. Share the failing file or stack frame and I can route next steps.`;
  }
  return `I saw your help_request ("${requestMessage}"). Quick context: ${synopsis}. Share the failing file or stack frame and I can route next steps.`;
}

async function runWithTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutHandle = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      if (typeof timeoutHandle.unref === "function") {
        timeoutHandle.unref();
      }
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function buildHelpResponseMessage(
  daemonState,
  requestEvent,
  {
    targetPath = process.cwd(),
  } = {}
) {
  const requestMessage =
    normalizeString(requestEvent?.payload?.message) ||
    normalizeString(requestEvent?.payload?.request) ||
    "help request received";

  if (typeof daemonState.helpResponder === "function") {
    const custom = await daemonState.helpResponder({
      daemonState,
      requestEvent,
      targetPath,
    });
    const normalizedCustom = normalizeString(custom);
    if (normalizedCustom) {
      return {
        message: normalizedCustom,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          model: daemonState.model,
          provider: "custom-responder",
          latencyMs: 0,
        },
        fallbackPath: false,
        fallbackReason: "",
        contextSignals: {
          documentCount: 0,
          memoryHits: 0,
          blackboardEntries: 0,
          recentEvents: 0,
        },
      };
    }
  }

  const session = await getSession(daemonState.sessionId, { targetPath });
  const synopsis = session ? formatCodebaseSynopsis(session) : "codebase context unavailable";
  const outputRoot = path.join(targetPath, ".sentinelayer");

  const [recentEvents, blackboardEntries, sharedMemory] = await Promise.all([
    readStream(daemonState.sessionId, {
      targetPath,
      tail: HELP_CONTEXT_EVENT_TAIL,
    }).catch(() => []),
    loadLatestBlackboardEntries(targetPath, {
      limit: HELP_BLACKBOARD_ENTRY_LIMIT,
    }),
    buildSharedMemoryCorpus({
      outputRoot,
      targetPath,
      ingest: session?.codebaseContext || {},
      maxAuditRuns: 2,
    }).catch(() => ({
      documents: [],
      sourceCounts: {},
    })),
  ]);

  const documents = [
    ...(sharedMemory.documents || []),
    ...buildStreamContextDocuments(recentEvents),
    ...buildDocumentsFromBlackboardEntries(blackboardEntries),
  ];
  const localIndex = buildLocalHybridIndex(documents);
  const memoryQuery = queryLocalHybridIndex(localIndex, {
    query: requestMessage,
    limit: HELP_CONTEXT_RESULT_LIMIT,
    minScore: 0.05,
  });
  const memoryHits = memoryQuery.results || [];
  const contextHints = memoryHits
    .slice(0, HELP_CONTEXT_RESULT_LIMIT)
    .map((result) => {
      const source = normalizeString(result.sourceType) || "memory";
      const snippet = normalizeString(result.snippet || "").replace(/\s+/g, " ").trim();
      if (!snippet) {
        return "";
      }
      return `${source}: ${snippet}`;
    })
    .filter(Boolean);

  const systemPrompt = [
    "You are Senti, SentinelLayer's session daemon.",
    "Answer the requesting agent with concise, actionable engineering guidance.",
    "Prioritize concrete next steps and reference available context snippets.",
    "Never invent repository files or runtime behavior.",
  ].join(" ");
  const userPrompt = [
    `Agent request: ${requestMessage}`,
    `Codebase synopsis: ${synopsis}`,
    "Context snippets:",
    contextHints.length > 0 ? contextHints.map((line, index) => `${index + 1}. ${line}`).join("\n") : "none",
    "Respond in 2-4 short sentences.",
  ].join("\n");

  const startedAt = Date.now();
  let llmText = "";
  let fallbackPath = false;
  let fallbackReason = "";
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    model: daemonState.model,
    provider: "local-fallback",
    latencyMs: 0,
  };

  const llmTimeoutMs = Math.max(
    80,
    Math.min(
      HELP_MODEL_TIMEOUT_MS,
      normalizePositiveInteger(daemonState.helpRequestTimeoutMs, HELP_REQUEST_TIMEOUT_MS) * 2
    )
  );

  try {
    const llmResult = await runWithTimeout(
      Promise.resolve(
        daemonState.llmInvoker({
          model: daemonState.model,
          systemPrompt,
          prompt: userPrompt,
          maxTokens: 320,
          temperature: 0.1,
        })
      ),
      llmTimeoutMs,
      "Senti model response timeout."
    );
    llmText = normalizeString(llmResult?.text);
    usage = {
      inputTokens: normalizeUsageNumber(llmResult?.usage?.inputTokens),
      outputTokens: normalizeUsageNumber(llmResult?.usage?.outputTokens),
      costUsd: normalizeUsageNumber(llmResult?.usage?.costUsd),
      model: normalizeString(llmResult?.usage?.model) || daemonState.model,
      provider: normalizeString(llmResult?.usage?.provider) || "sentinelayer",
      latencyMs: normalizeUsageNumber(llmResult?.usage?.latencyMs),
    };
    if (!llmText) {
      fallbackPath = true;
      fallbackReason = "Senti model returned an empty response.";
    }
  } catch (error) {
    fallbackPath = true;
    fallbackReason = normalizeString(error?.message || error) || "Senti model invocation failed.";
  }

  if (!usage.latencyMs) {
    usage.latencyMs = Math.max(1, Date.now() - startedAt);
  }
  recordLlmUsage({
    sessionId: daemonState.telemetrySessionId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  });

  const message = llmText ||
    buildFallbackHelpResponse({
      requestMessage,
      synopsis,
      contextHints,
    });
  return {
    message,
    usage,
    fallbackPath,
    fallbackReason,
    contextSignals: {
      documentCount: documents.length,
      memoryHits: memoryHits.length,
      blackboardEntries: blackboardEntries.length,
      recentEvents: recentEvents.length,
    },
  };
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
  const response = await buildHelpResponseMessage(daemonState, requestEvent, {
    targetPath,
  });
  const nowIso = new Date().toISOString();
  const responseEvent = await emitSentiEvent(
    daemonState.sessionId,
    "help_response",
    {
      requestId,
      targetAgentId: normalizeString(requestEvent.agent?.id) || null,
      response: response.message,
      sourceEvent: "help_request",
      contextSignals: response.contextSignals,
    },
    {
      targetPath,
      nowIso,
    }
  );
  await emitSentiEvent(
    daemonState.sessionId,
    "model_span",
    {
      sourceEvent: "help_request",
      requestId,
      model: response.usage.model || daemonState.model,
      provider: response.usage.provider || "sentinelayer",
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
      latencyMs: response.usage.latencyMs,
      fallbackPath: Boolean(response.fallbackPath),
      fallbackReason: response.fallbackReason || null,
      contextSignals: response.contextSignals,
    },
    {
      targetPath,
      nowIso,
    }
  );
  return responseEvent;
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

function splitFileAndIntent(raw = "") {
  const normalized = normalizeString(raw);
  if (!normalized) {
    return {
      filePath: "",
      intent: "",
    };
  }
  const separatorMatch = /\s(?:—|–|-)\s/.exec(normalized);
  if (!separatorMatch) {
    return {
      filePath: normalizeString(normalized),
      intent: "",
    };
  }
  const separatorIndex = Number(separatorMatch.index || 0);
  return {
    filePath: normalizeString(normalized.slice(0, separatorIndex)),
    intent: normalizeString(normalized.slice(separatorIndex + separatorMatch[0].length)),
  };
}

function parseSessionDirective(event = {}) {
  if (normalizeString(event.event) !== "session_message") {
    return null;
  }
  const message = normalizeString(event.payload?.message);
  if (!message) {
    return null;
  }
  const directive = /^(lock|unlock)\s*:\s*(.+)$/i.exec(message);
  if (!directive) {
    return null;
  }
  const action = normalizeString(directive[1]).toLowerCase();
  const body = normalizeString(directive[2]);
  const parsed = splitFileAndIntent(body);
  if (!parsed.filePath) {
    return null;
  }
  return {
    action,
    filePath: parsed.filePath,
    intent: parsed.intent,
  };
}

async function maybeHandleSessionDirective(daemonState, event) {
  const agentId = normalizeString(event.agent?.id);
  if (!agentId || agentId === SENTI_IDENTITY.id) {
    return null;
  }
  const nowIso = normalizeIsoTimestamp(event.ts, new Date().toISOString());
  const fileDirective = parseSessionDirective(event);
  if (fileDirective) {
    if (fileDirective.action === "lock") {
      const result = await lockFile(
        daemonState.sessionId,
        agentId,
        fileDirective.filePath,
        {
          intent: fileDirective.intent,
          ttlSeconds: DEFAULT_FILE_LOCK_TTL_SECONDS,
          targetPath: daemonState.targetPath,
          nowIso,
        }
      );
      if (!result.locked) {
        await emitSentiEvent(
          daemonState.sessionId,
          "daemon_alert",
          {
            alert: "file_lock_denied",
            file: result.file || fileDirective.filePath,
            requestedBy: agentId,
            heldBy: result.heldBy || null,
            since: result.since || null,
            suggestion: `${fileDirective.filePath} is locked by ${result.heldBy || "another agent"} (${result.since || "recently"}). Coordinate before editing.`,
          },
          {
            targetPath: daemonState.targetPath,
            nowIso,
          }
        );
      }
      return result;
    }
    if (fileDirective.action === "unlock") {
      const result = await unlockFile(
        daemonState.sessionId,
        agentId,
        fileDirective.filePath,
        {
          reason: "session_message_unlock",
          targetPath: daemonState.targetPath,
          nowIso,
        }
      );
      if (!result.unlocked && result.reason === "held_by_other_agent") {
        await emitSentiEvent(
          daemonState.sessionId,
          "daemon_alert",
          {
            alert: "file_unlock_denied",
            file: result.file || fileDirective.filePath,
            requestedBy: agentId,
            heldBy: result.heldBy || null,
            since: result.since || null,
            suggestion: `${fileDirective.filePath} is locked by ${result.heldBy || "another agent"}. Only the lock holder can release it.`,
          },
          {
            targetPath: daemonState.targetPath,
            nowIso,
          }
        );
      }
      return result;
    }
  }

  try {
    return await handleTaskDirective(daemonState.sessionId, event, {
      targetPath: daemonState.targetPath,
      nowIso,
    });
  } catch (error) {
    await emitSentiEvent(
      daemonState.sessionId,
      "daemon_alert",
      {
        alert: "task_directive_error",
        requestedBy: agentId,
        reason: normalizeString(error?.message) || "Task directive failed.",
        message: normalizeString(event.payload?.message) || null,
      },
      {
        targetPath: daemonState.targetPath,
        nowIso,
      }
    );
    return null;
  }
}

async function runSessionDirectiveWatcher(daemonState) {
  const signal = daemonState.helpAbortController.signal;
  try {
    for await (const event of tailStream(daemonState.sessionId, {
      targetPath: daemonState.targetPath,
      signal,
      since: daemonState.startedAt,
      replayTail: 0,
      pollMs: 100,
    })) {
      if (!daemonState.running) {
        return;
      }
      if (normalizeString(event.event) !== "session_message") {
        continue;
      }
      await maybeHandleSessionDirective(daemonState, event);
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
      recapIntervalMs: DEFAULT_RECAP_INTERVAL_MS_OVERRIDE,
      recapInactivityMs: DEFAULT_RECAP_INACTIVITY_MS_OVERRIDE,
      helpResponder: null,
      llmInvoker: invokeViaProxy,
      telemetrySessionId: null,
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
    recapIntervalMs = DEFAULT_RECAP_INTERVAL_MS_OVERRIDE,
    recapInactivityMs = DEFAULT_RECAP_INACTIVITY_MS_OVERRIDE,
    helpResponder = null,
    llmInvoker = invokeViaProxy,
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
  const normalizedRecapIntervalMs = normalizePositiveInteger(
    recapIntervalMs,
    DEFAULT_RECAP_INTERVAL_MS_OVERRIDE
  );
  const normalizedRecapInactivityMs = normalizePositiveInteger(
    recapInactivityMs,
    DEFAULT_RECAP_INACTIVITY_MS_OVERRIDE
  );
  const nowIso = new Date().toISOString();
  const telemetrySession = startTelemetrySession(`session daemon ${normalizedSessionId}`);
  const daemonState = createSentiState({
    daemonKey,
    sessionId: normalizedSessionId,
    targetPath: normalizedTargetPath,
    startedAt: nowIso,
    model: normalizeString(model) || SENTI_MODEL,
    staleAgentSeconds: normalizedStaleSeconds,
    helpRequestTimeoutMs: normalizedHelpTimeoutMs,
    tickIntervalMs: normalizedTickIntervalMs,
    recapIntervalMs: normalizedRecapIntervalMs,
    recapInactivityMs: normalizedRecapInactivityMs,
    helpResponder,
    llmInvoker: typeof llmInvoker === "function" ? llmInvoker : invokeViaProxy,
    telemetrySessionId: telemetrySession?.id || null,
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
    if (daemonState.recapEmitter && daemonState.recapEmitter.isRunning()) {
      daemonState.recapEmitter.stop("daemon_stop");
      daemonState.recapEmitter = null;
    }

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
    if (daemonState.telemetrySessionId) {
      endTelemetrySession({ sessionId: daemonState.telemetrySessionId });
    }
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
      recapRunning: Boolean(daemonState.recapEmitter?.isRunning?.()),
    }),
  };

  daemonState.handle = handle;
  ACTIVE_SENTI_DAEMONS.set(daemonKey, daemonState);

  void runHelpWatcher(daemonState).catch(() => {});
  void runSessionDirectiveWatcher(daemonState).catch(() => {});
  daemonState.recapEmitter = emitPeriodicRecap(normalizedSessionId, {
    targetPath: normalizedTargetPath,
    intervalMs: daemonState.recapIntervalMs,
    inactivityMs: daemonState.recapInactivityMs,
  });

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
  DEFAULT_RECAP_INACTIVITY_MS_OVERRIDE,
  DEFAULT_RECAP_INTERVAL_MS_OVERRIDE,
  DEFAULT_STALE_AGENT_SECONDS,
  FILE_CONFLICT_WINDOW_MS,
  HELP_REQUEST_TIMEOUT_MS,
  RENEWAL_LEAD_MS,
  RENEWAL_THRESHOLD_EVENTS,
  RENEWAL_WINDOW_MS,
  SENTI_IDENTITY,
  SENTI_MODEL,
};
