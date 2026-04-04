import fsp from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { listAssignments, resolveAssignmentLedgerStorage } from "./assignment-ledger.js";
import { listBudgetStates } from "./budget-governor.js";
import { listErrorQueue, resolveErrorDaemonStorage } from "./error-worker.js";

const WATCHDOG_SCHEMA_VERSION = "1.0.0";
const STATE_SCHEMA_VERSION = "1.0.0";

const ACTIVE_ASSIGNMENT_STATUSES = new Set(["CLAIMED", "IN_PROGRESS", "BLOCKED"]);

export const WATCHDOG_EVENT_TYPES = Object.freeze([
  "agent_stuck",
  "budget_warning",
  "alert_recovered",
  "pr_merged",
  "audit_complete",
  "kill_switch_activated",
]);

export const WATCHDOG_SIGNAL_CODES = Object.freeze([
  "NO_TOOL_CALL",
  "REPEATED_FILE_READ",
  "BUDGET_WARNING_NO_FINDINGS",
  "TURN_STALL",
]);

const WATCHDOG_SIGNAL_SET = new Set(WATCHDOG_SIGNAL_CODES);
const WATCHDOG_EVENT_SET = new Set(WATCHDOG_EVENT_TYPES);

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

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizePositiveInteger(value, fallbackValue) {
  const normalized = normalizeNumber(value, fallbackValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.max(1, Math.floor(normalized));
}

function normalizeNonNegativeNumber(value, fallbackValue = 0) {
  const normalized = normalizeNumber(value, fallbackValue);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallbackValue;
  }
  return normalized;
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeBoolean(value, fallbackValue = false) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return fallbackValue;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallbackValue;
}

function resolveEnvTemplate(value, env) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => normalizeString(env[key]));
}

function computeSecondsSince(previousIso, nowIso) {
  const previousEpoch = Date.parse(normalizeIsoTimestamp(previousIso, nowIso));
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  if (!Number.isFinite(previousEpoch) || !Number.isFinite(nowEpoch)) {
    return null;
  }
  return Math.max(0, Math.floor((nowEpoch - previousEpoch) / 1000));
}

function pickLastToolCallAt(assignment = {}) {
  const snapshot = normalizeObject(assignment.budgetSnapshot);
  return (
    normalizeString(snapshot.lastToolCallAt) ||
    normalizeString(snapshot.lastActionAt) ||
    normalizeString(assignment.heartbeatAt) ||
    normalizeString(assignment.updatedAt) ||
    ""
  );
}

function extractRecentFileReads(snapshot = {}) {
  const candidates = [];
  const normalizedSnapshot = normalizeObject(snapshot);
  for (const key of ["recentFileReads", "fileReadHistory", "fileReads"]) {
    const value = normalizedSnapshot[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          const normalized = normalizeString(item);
          if (normalized) {
            candidates.push(normalized);
          }
          continue;
        }
        if (item && typeof item === "object") {
          const normalized =
            normalizeString(item.path) ||
            normalizeString(item.file) ||
            normalizeString(item.filePath);
          if (normalized) {
            candidates.push(normalized);
          }
        }
      }
    }
  }
  return candidates;
}

function computeRepeatedTailCount(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      repeatedValue: "",
      repeatCount: 0,
    };
  }
  const normalized = values.map((value) => normalizeString(value)).filter(Boolean);
  if (normalized.length === 0) {
    return {
      repeatedValue: "",
      repeatCount: 0,
    };
  }
  const tail = normalized[normalized.length - 1];
  let repeatCount = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index] !== tail) {
      break;
    }
    repeatCount += 1;
  }
  return {
    repeatedValue: tail,
    repeatCount,
  };
}

function computeBudgetUsageRatio(record = {}) {
  const usage = normalizeObject(record.usage);
  const budget = normalizeObject(record.budget);
  const ratios = [];
  const pairs = [
    ["tokensUsed", "maxTokens"],
    ["costUsd", "maxCostUsd"],
    ["runtimeMs", "maxRuntimeMs"],
    ["toolCalls", "maxToolCalls"],
  ];
  for (const [usageKey, budgetKey] of pairs) {
    const used = normalizeNonNegativeNumber(usage[usageKey], 0);
    const limit = normalizeNonNegativeNumber(budget[budgetKey], 0);
    if (limit > 0) {
      ratios.push(used / limit);
    }
  }
  if (ratios.length === 0) {
    return 0;
  }
  return Math.max(...ratios);
}

function normalizeSeverity(value) {
  const normalized = normalizeString(value).toUpperCase();
  if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
    return normalized;
  }
  return "P3";
}

function createInitialState(nowIso) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    activeAlerts: {},
    runCount: 0,
    lastRunId: null,
    lastRunAt: null,
  };
}

function normalizeState(state = {}, nowIso = new Date().toISOString()) {
  const rawAlerts = state.activeAlerts && typeof state.activeAlerts === "object" ? state.activeAlerts : {};
  const activeAlerts = {};
  for (const [alertId, alert] of Object.entries(rawAlerts)) {
    if (!normalizeString(alertId)) {
      continue;
    }
    activeAlerts[alertId] = {
      alertId,
      eventType: WATCHDOG_EVENT_SET.has(normalizeString(alert.eventType))
        ? normalizeString(alert.eventType)
        : "agent_stuck",
      signalCode: WATCHDOG_SIGNAL_SET.has(normalizeString(alert.signalCode))
        ? normalizeString(alert.signalCode)
        : "NO_TOOL_CALL",
      workItemId: normalizeString(alert.workItemId),
      agentIdentity: normalizeString(alert.agentIdentity),
      firstSeenAt: normalizeIsoTimestamp(alert.firstSeenAt, nowIso),
      lastSeenAt: normalizeIsoTimestamp(alert.lastSeenAt, nowIso),
      message: normalizeString(alert.message),
      severity: normalizeSeverity(alert.severity),
    };
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(state.generatedAt, nowIso),
    activeAlerts,
    runCount: Math.max(0, Math.floor(normalizeNumber(state.runCount, 0))),
    lastRunId: normalizeString(state.lastRunId) || null,
    lastRunAt: state.lastRunAt ? normalizeIsoTimestamp(state.lastRunAt, nowIso) : null,
  };
}

async function readJsonFile(filePath, defaultFactory) {
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

async function writeJsonFile(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function appendEvent(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

function buildRunId(nowIso, count) {
  const token = normalizeIsoTimestamp(nowIso, new Date().toISOString()).replace(/[:.]/g, "-");
  return `watchdog-${token}-${String(count).padStart(4, "0")}`;
}

function normalizeChannel(channel = {}, env = process.env) {
  const type = normalizeString(channel.type).toLowerCase();
  if (type === "slack") {
    const webhookUrl = resolveEnvTemplate(
      channel.webhook_url || channel.webhookUrl || channel.url || "",
      env
    );
    return webhookUrl
      ? {
          type: "slack",
          webhookUrl,
        }
      : null;
  }
  if (type === "telegram") {
    const botToken = resolveEnvTemplate(channel.bot_token || channel.botToken || "", env);
    const chatId = resolveEnvTemplate(channel.chat_id || channel.chatId || "", env);
    return botToken && chatId
      ? {
          type: "telegram",
          botToken,
          chatId,
        }
      : null;
  }
  return null;
}

async function loadWatchdogConfig({ targetPath = ".", env = process.env } = {}) {
  const configPath = path.join(path.resolve(String(targetPath || ".")), ".sentinelayer.yml");
  const fallback = {
    channels: [],
    frequency: "smart",
    events: ["agent_stuck", "budget_warning", "alert_recovered"],
  };
  try {
    const parsed = parseYaml(await fsp.readFile(configPath, "utf-8")) || {};
    const alerts = parsed && typeof parsed === "object" ? normalizeObject(parsed.alerts) : {};
    const channels = Array.isArray(alerts.channels)
      ? alerts.channels.map((channel) => normalizeChannel(channel, env)).filter(Boolean)
      : [];
    const events = Array.isArray(alerts.events)
      ? alerts.events
          .map((eventType) => normalizeString(eventType))
          .filter((eventType) => WATCHDOG_EVENT_SET.has(eventType))
      : fallback.events;
    const frequency = normalizeString(alerts.frequency).toLowerCase() || fallback.frequency;
    return {
      configPath,
      exists: true,
      channels,
      frequency,
      events: events.length > 0 ? events : fallback.events,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        configPath,
        exists: false,
        channels: [],
        frequency: fallback.frequency,
        events: fallback.events,
      };
    }
    throw error;
  }
}

function buildDetection({
  eventType,
  signalCode,
  workItemId,
  agentIdentity,
  severity,
  message,
  details = {},
}) {
  return {
    alertId: `${workItemId}:${signalCode}`,
    eventType,
    signalCode,
    workItemId,
    agentIdentity,
    severity,
    message,
    details,
  };
}

function evaluateWatchdogSignals({
  assignment,
  queueItem,
  budgetRecord,
  nowIso,
  noToolCallSeconds,
  repeatedFileReadsThreshold,
  budgetWarningThreshold,
  turnStallTurns,
}) {
  const detections = [];
  const workItemId = normalizeString(assignment.workItemId);
  const agentIdentity = normalizeString(assignment.assignedAgentIdentity) || "unassigned";
  const severity = normalizeSeverity(queueItem?.severity);
  const budgetSnapshot = normalizeObject(assignment.budgetSnapshot);

  const lastToolCallAt = pickLastToolCallAt(assignment);
  const idleSeconds = computeSecondsSince(lastToolCallAt, nowIso);
  if (idleSeconds !== null && idleSeconds >= noToolCallSeconds) {
    detections.push(
      buildDetection({
        eventType: "agent_stuck",
        signalCode: "NO_TOOL_CALL",
        workItemId,
        agentIdentity,
        severity,
        message: `No tool calls observed for ${idleSeconds}s (threshold ${noToolCallSeconds}s).`,
        details: {
          idleSeconds,
          thresholdSeconds: noToolCallSeconds,
          lastToolCallAt: normalizeIsoTimestamp(lastToolCallAt, nowIso),
        },
      })
    );
  }

  const recentFileReads = extractRecentFileReads(budgetSnapshot);
  const repetition = computeRepeatedTailCount(recentFileReads);
  if (repetition.repeatCount >= repeatedFileReadsThreshold) {
    detections.push(
      buildDetection({
        eventType: "agent_stuck",
        signalCode: "REPEATED_FILE_READ",
        workItemId,
        agentIdentity,
        severity,
        message: `Repeated file read detected (${repetition.repeatCount}x): ${repetition.repeatedValue}`,
        details: {
          filePath: repetition.repeatedValue,
          repeatCount: repetition.repeatCount,
          threshold: repeatedFileReadsThreshold,
        },
      })
    );
  }

  const turnCount = Math.floor(normalizeNonNegativeNumber(budgetSnapshot.turnCount, 0));
  const lastProgressTurn = Math.floor(
    normalizeNonNegativeNumber(
      budgetSnapshot.lastProgressTurn ?? budgetSnapshot.lastFindingTurn ?? turnCount,
      turnCount
    )
  );
  const stalledTurns = Math.max(0, turnCount - lastProgressTurn);
  if (turnCount > 0 && stalledTurns >= turnStallTurns) {
    detections.push(
      buildDetection({
        eventType: "agent_stuck",
        signalCode: "TURN_STALL",
        workItemId,
        agentIdentity,
        severity,
        message: `Turn progression stalled for ${stalledTurns} turns (threshold ${turnStallTurns}).`,
        details: {
          turnCount,
          lastProgressTurn,
          stalledTurns,
          threshold: turnStallTurns,
        },
      })
    );
  }

  const usageRatio = computeBudgetUsageRatio(budgetRecord || {});
  const findingsProduced = Math.floor(
    normalizeNonNegativeNumber(
      budgetSnapshot.findingsProduced ??
        queueItem?.metadata?.findingsProduced ??
        queueItem?.metadata?.findingsCount ??
        0,
      0
    )
  );
  if (usageRatio >= budgetWarningThreshold && findingsProduced <= 0) {
    detections.push(
      buildDetection({
        eventType: "budget_warning",
        signalCode: "BUDGET_WARNING_NO_FINDINGS",
        workItemId,
        agentIdentity,
        severity,
        message: `Budget usage ${(usageRatio * 100).toFixed(1)}% with no findings produced.`,
        details: {
          usageRatio: Number(usageRatio.toFixed(6)),
          threshold: budgetWarningThreshold,
          findingsProduced,
          lifecycleState: normalizeString(budgetRecord?.lifecycleState) || "WITHIN_BUDGET",
        },
      })
    );
  }

  return detections;
}

function toActiveAlertRecord(alert = {}, nowIso = new Date().toISOString()) {
  return {
    alertId: alert.alertId,
    eventType: alert.eventType,
    signalCode: alert.signalCode,
    workItemId: alert.workItemId,
    agentIdentity: alert.agentIdentity,
    firstSeenAt: normalizeIsoTimestamp(alert.firstSeenAt || nowIso, nowIso),
    lastSeenAt: normalizeIsoTimestamp(nowIso, nowIso),
    message: normalizeString(alert.message),
    severity: normalizeSeverity(alert.severity),
  };
}

function buildAlertTransitions({
  detections = [],
  previousState = {},
  nowIso = new Date().toISOString(),
}) {
  const previousAlerts = normalizeObject(previousState.activeAlerts);
  const activeAlerts = {};
  const activated = [];
  const stillActive = [];
  const detectionById = new Map();
  for (const detection of detections) {
    detectionById.set(detection.alertId, detection);
    const previous = previousAlerts[detection.alertId] || null;
    const record = toActiveAlertRecord(
      {
        ...detection,
        firstSeenAt: previous?.firstSeenAt || nowIso,
      },
      nowIso
    );
    activeAlerts[detection.alertId] = record;
    if (previous) {
      stillActive.push({
        ...detection,
        firstSeenAt: previous.firstSeenAt,
        lastSeenAt: nowIso,
      });
    } else {
      activated.push({
        ...detection,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      });
    }
  }

  const recovered = [];
  for (const [alertId, previous] of Object.entries(previousAlerts)) {
    if (detectionById.has(alertId)) {
      continue;
    }
    recovered.push({
      alertId,
      eventType: "alert_recovered",
      signalCode: normalizeString(previous.signalCode),
      workItemId: normalizeString(previous.workItemId),
      agentIdentity: normalizeString(previous.agentIdentity),
      severity: normalizeSeverity(previous.severity),
      message: `Recovered: ${normalizeString(previous.message) || "watchdog signal cleared"}`,
      firstSeenAt: normalizeIsoTimestamp(previous.firstSeenAt, nowIso),
      lastSeenAt: normalizeIsoTimestamp(previous.lastSeenAt, nowIso),
      recoveredAt: normalizeIsoTimestamp(nowIso, nowIso),
    });
  }

  return {
    activeAlerts,
    activated,
    stillActive,
    recovered,
  };
}

function formatAlertMessage(alert = {}) {
  const eventType = normalizeString(alert.eventType);
  if (eventType === "agent_stuck") {
    const idleSeconds = normalizeNumber(alert.details?.idleSeconds, 0);
    const budgetRatio = normalizeNumber(alert.details?.usageRatio, 0);
    const budgetPct = budgetRatio > 0 ? ` | budget=${(budgetRatio * 100).toFixed(1)}%` : "";
    return `[SentinelLayer] Agent "${alert.agentIdentity}" stuck (${alert.signalCode}) on ${alert.workItemId}${idleSeconds > 0 ? ` | idle=${idleSeconds}s` : ""}${budgetPct}\n${alert.message}`;
  }
  if (eventType === "budget_warning") {
    const budgetRatio = normalizeNumber(alert.details?.usageRatio, 0);
    return `[SentinelLayer] Budget warning for ${alert.workItemId} (${alert.agentIdentity}) | usage=${(budgetRatio * 100).toFixed(1)}%\n${alert.message}`;
  }
  return `[SentinelLayer] ${alert.eventType} ${alert.workItemId || ""} ${alert.agentIdentity || ""}\n${alert.message}`;
}

async function sendSlackAlert(channel, message, fetchImpl) {
  const response = await fetchImpl(channel.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: message,
    }),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}.`);
  }
}

async function sendTelegramAlert(channel, message, fetchImpl) {
  const endpoint = `https://api.telegram.org/bot${channel.botToken}/sendMessage`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: channel.chatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage returned ${response.status}.`);
  }
}

async function dispatchAlertToChannel({
  channel,
  alert,
  execute = false,
  fetchImpl = globalThis.fetch,
}) {
  const message = formatAlertMessage(alert);
  if (!execute) {
    return {
      channelType: channel.type,
      alertId: alert.alertId,
      eventType: alert.eventType,
      sent: false,
      dryRun: true,
      message,
      error: "",
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      channelType: channel.type,
      alertId: alert.alertId,
      eventType: alert.eventType,
      sent: false,
      dryRun: false,
      message,
      error: "Fetch implementation is unavailable.",
    };
  }
  try {
    if (channel.type === "slack") {
      await sendSlackAlert(channel, message, fetchImpl);
    } else if (channel.type === "telegram") {
      await sendTelegramAlert(channel, message, fetchImpl);
    } else {
      throw new Error(`Unsupported alert channel type '${channel.type}'.`);
    }
    return {
      channelType: channel.type,
      alertId: alert.alertId,
      eventType: alert.eventType,
      sent: true,
      dryRun: false,
      message,
      error: "",
    };
  } catch (error) {
    return {
      channelType: channel.type,
      alertId: alert.alertId,
      eventType: alert.eventType,
      sent: false,
      dryRun: false,
      message,
      error: normalizeString(error?.message || error),
    };
  }
}

async function dispatchAlerts({
  alerts = [],
  config = {},
  execute = false,
  fetchImpl = globalThis.fetch,
}) {
  const channels = Array.isArray(config.channels) ? config.channels : [];
  const allowedEvents = new Set(Array.isArray(config.events) ? config.events : []);
  const tasks = [];
  for (const alert of alerts) {
    if (allowedEvents.size > 0 && !allowedEvents.has(alert.eventType)) {
      continue;
    }
    for (const channel of channels) {
      tasks.push(
        dispatchAlertToChannel({
          channel,
          alert,
          execute,
          fetchImpl,
        })
      );
    }
  }
  return Promise.all(tasks);
}

export async function resolveWatchdogStorage({
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
    watchdogStatePath: path.join(daemonStorage.baseDir, "watchdog-state.json"),
    watchdogEventsPath: path.join(daemonStorage.baseDir, "watchdog-events.ndjson"),
    watchdogRunsDir: path.join(daemonStorage.baseDir, "watchdog-runs"),
  };
}

export async function runWatchdogTick({
  targetPath = ".",
  outputDir = "",
  noToolCallSeconds = 60,
  repeatedFileReadsThreshold = 3,
  budgetWarningThreshold = 0.9,
  turnStallTurns = 5,
  execute = false,
  limit = 200,
  env = process.env,
  homeDir,
  nowIso = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedNoToolCallSeconds = normalizePositiveInteger(noToolCallSeconds, 60);
  const normalizedRepeatedFileReads = normalizePositiveInteger(repeatedFileReadsThreshold, 3);
  const normalizedTurnStallTurns = normalizePositiveInteger(turnStallTurns, 5);
  const normalizedBudgetWarningThreshold = Math.max(
    0,
    Math.min(1, normalizeNonNegativeNumber(budgetWarningThreshold, 0.9))
  );
  const normalizedLimit = normalizePositiveInteger(limit, 200);
  const normalizedExecute = normalizeBoolean(execute, false);
  const storage = await resolveWatchdogStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const config = await loadWatchdogConfig({
    targetPath,
    env,
  });

  const [assignments, queue, budgets, previousState] = await Promise.all([
    listAssignments({
      targetPath,
      outputDir,
      includeExpired: true,
      limit: normalizedLimit,
      env,
      homeDir,
      nowIso: normalizedNow,
    }),
    listErrorQueue({
      targetPath,
      outputDir,
      limit: normalizedLimit,
      env,
      homeDir,
    }),
    listBudgetStates({
      targetPath,
      outputDir,
      limit: normalizedLimit,
      env,
      homeDir,
      nowIso: normalizedNow,
    }),
    readJsonFile(storage.watchdogStatePath, () => createInitialState(normalizedNow)).then((state) =>
      normalizeState(state, normalizedNow)
    ),
  ]);

  const queueByWorkItem = new Map(queue.items.map((item) => [item.workItemId, item]));
  const budgetByWorkItem = new Map(budgets.records.map((record) => [record.workItemId, record]));
  const activeAssignments = assignments.assignments.filter((assignment) =>
    ACTIVE_ASSIGNMENT_STATUSES.has(normalizeString(assignment.status).toUpperCase())
  );

  const detections = [];
  for (const assignment of activeAssignments) {
    const queueItem = queueByWorkItem.get(assignment.workItemId) || null;
    const budgetRecord = budgetByWorkItem.get(assignment.workItemId) || null;
    detections.push(
      ...evaluateWatchdogSignals({
        assignment,
        queueItem,
        budgetRecord,
        nowIso: normalizedNow,
        noToolCallSeconds: normalizedNoToolCallSeconds,
        repeatedFileReadsThreshold: normalizedRepeatedFileReads,
        budgetWarningThreshold: normalizedBudgetWarningThreshold,
        turnStallTurns: normalizedTurnStallTurns,
      })
    );
  }

  const transitions = buildAlertTransitions({
    detections,
    previousState,
    nowIso: normalizedNow,
  });
  const stateChangedAlerts = [...transitions.activated, ...transitions.recovered];
  const notifications = await dispatchAlerts({
    alerts: stateChangedAlerts,
    config,
    execute: normalizedExecute,
    fetchImpl,
  });

  const nextState = normalizeState(
    {
      ...previousState,
      generatedAt: normalizedNow,
      activeAlerts: transitions.activeAlerts,
      runCount: previousState.runCount + 1,
      lastRunId: buildRunId(normalizedNow, previousState.runCount + 1),
      lastRunAt: normalizedNow,
    },
    normalizedNow
  );

  await fsp.mkdir(storage.watchdogRunsDir, { recursive: true });
  const runId = nextState.lastRunId;
  const runPath = path.join(storage.watchdogRunsDir, `${runId}.json`);
  const runPayload = {
    schemaVersion: WATCHDOG_SCHEMA_VERSION,
    generatedAt: normalizedNow,
    runId,
    config: {
      noToolCallSeconds: normalizedNoToolCallSeconds,
      repeatedFileReadsThreshold: normalizedRepeatedFileReads,
      budgetWarningThreshold: normalizedBudgetWarningThreshold,
      turnStallTurns: normalizedTurnStallTurns,
      execute: normalizedExecute,
      channelCount: config.channels.length,
      events: config.events,
      frequency: config.frequency,
    },
    summary: {
      assignmentCount: activeAssignments.length,
      detectionCount: detections.length,
      activeAlertCount: Object.keys(transitions.activeAlerts).length,
      activatedCount: transitions.activated.length,
      recoveredCount: transitions.recovered.length,
      notificationCount: notifications.length,
      sentNotificationCount: notifications.filter((item) => item.sent).length,
      failedNotificationCount: notifications.filter((item) => !item.sent && !item.dryRun).length,
    },
    detections,
    activatedAlerts: transitions.activated,
    recoveredAlerts: transitions.recovered,
    notifications,
  };

  await Promise.all([
    writeJsonFile(runPath, runPayload),
    writeJsonFile(storage.watchdogStatePath, nextState),
    appendEvent(storage.watchdogEventsPath, {
      timestamp: normalizedNow,
      eventType: "watchdog_tick",
      runId,
      detectionCount: detections.length,
      activatedCount: transitions.activated.length,
      recoveredCount: transitions.recovered.length,
      notificationCount: notifications.length,
      sentNotificationCount: notifications.filter((item) => item.sent).length,
      failedNotificationCount: notifications.filter((item) => !item.sent && !item.dryRun).length,
    }),
  ]);

  return {
    ...storage,
    configPath: config.configPath,
    configExists: config.exists,
    runId,
    runPath,
    statePath: storage.watchdogStatePath,
    eventsPath: storage.watchdogEventsPath,
    state: nextState,
    detections,
    activatedAlerts: transitions.activated,
    recoveredAlerts: transitions.recovered,
    notifications,
    summary: runPayload.summary,
  };
}

export async function getWatchdogStatus({
  targetPath = ".",
  outputDir = "",
  limit = 10,
  env = process.env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedLimit = normalizePositiveInteger(limit, 10);
  const storage = await resolveWatchdogStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const config = await loadWatchdogConfig({
    targetPath,
    env,
  });
  const state = await readJsonFile(storage.watchdogStatePath, () =>
    createInitialState(normalizedNow)
  ).then((payload) => normalizeState(payload, normalizedNow));

  let runEntries = [];
  try {
    runEntries = await fsp.readdir(storage.watchdogRunsDir, { withFileTypes: true });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  const runFiles = runEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, normalizedLimit);

  const recentRuns = [];
  for (const runFile of runFiles) {
    const runPath = path.join(storage.watchdogRunsDir, runFile);
    try {
      const parsed = JSON.parse(await fsp.readFile(runPath, "utf-8"));
      recentRuns.push({
        runId: normalizeString(parsed.runId),
        generatedAt: normalizeIsoTimestamp(parsed.generatedAt, normalizedNow),
        detectionCount: normalizeNonNegativeNumber(parsed.summary?.detectionCount, 0),
        activatedCount: normalizeNonNegativeNumber(parsed.summary?.activatedCount, 0),
        recoveredCount: normalizeNonNegativeNumber(parsed.summary?.recoveredCount, 0),
        notificationCount: normalizeNonNegativeNumber(parsed.summary?.notificationCount, 0),
        runPath,
      });
    } catch {
      // Ignore malformed run artifacts.
    }
  }

  return {
    ...storage,
    configPath: config.configPath,
    configExists: config.exists,
    config,
    statePath: storage.watchdogStatePath,
    eventsPath: storage.watchdogEventsPath,
    state,
    activeAlerts: Object.values(state.activeAlerts),
    activeAlertCount: Object.keys(state.activeAlerts).length,
    runCount: state.runCount,
    recentRuns,
  };
}
