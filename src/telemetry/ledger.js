import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveOutputRoot } from "../config/service.js";

const OBSERVABILITY_DIR_NAME = "observability";
const RUN_EVENTS_FILE_NAME = "run-events.jsonl";
const SCHEMA_VERSION = 1;

export const RUN_EVENT_TYPES = Object.freeze([
  "run_start",
  "run_step",
  "tool_call",
  "usage",
  "budget_check",
  "run_stop",
]);

export const STOP_CLASSES = Object.freeze([
  "NONE",
  "MAX_COST_EXCEEDED",
  "MAX_OUTPUT_TOKENS_EXCEEDED",
  "DIMINISHING_RETURNS",
  "MAX_RUNTIME_MS_EXCEEDED",
  "MAX_TOOL_CALLS_EXCEEDED",
  "MANUAL_STOP",
  "ERROR",
  "UNKNOWN",
]);

const RUN_EVENT_TYPE_SET = new Set(RUN_EVENT_TYPES);
const STOP_CLASS_SET = new Set(STOP_CLASSES);

function normalizeNonNegativeNumber(value, field) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function normalizeReasonCodes(reasonCodes = []) {
  if (reasonCodes === undefined || reasonCodes === null) {
    return [];
  }
  if (!Array.isArray(reasonCodes)) {
    throw new Error("stop.reasonCodes must be an array of strings.");
  }

  const unique = new Set();
  for (const reasonCode of reasonCodes) {
    const normalized = String(reasonCode || "").trim().toUpperCase();
    if (normalized) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

function normalizeStop(stop = null) {
  if (!stop) {
    return null;
  }
  if (typeof stop !== "object" || Array.isArray(stop)) {
    throw new Error("stop must be an object when provided.");
  }

  const stopClass = String(stop.stopClass || "NONE").trim().toUpperCase() || "NONE";
  if (!STOP_CLASS_SET.has(stopClass)) {
    throw new Error(`Unsupported stop class '${stopClass}'.`);
  }

  return {
    stopClass,
    blocking: Boolean(stop.blocking),
    reasonCodes: normalizeReasonCodes(stop.reasonCodes),
  };
}

function normalizeMetadata(metadata = {}) {
  if (metadata === undefined || metadata === null) {
    return {};
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("metadata must be an object when provided.");
  }
  return { ...metadata };
}

function normalizeUsage(usage = {}) {
  if (usage === undefined || usage === null) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    };
  }

  if (typeof usage !== "object" || Array.isArray(usage)) {
    throw new Error("usage must be an object when provided.");
  }

  return {
    inputTokens: normalizeNonNegativeNumber(usage.inputTokens, "usage.inputTokens"),
    outputTokens: normalizeNonNegativeNumber(usage.outputTokens, "usage.outputTokens"),
    cacheReadTokens: normalizeNonNegativeNumber(usage.cacheReadTokens, "usage.cacheReadTokens"),
    cacheWriteTokens: normalizeNonNegativeNumber(usage.cacheWriteTokens, "usage.cacheWriteTokens"),
    costUsd: normalizeNonNegativeNumber(usage.costUsd, "usage.costUsd"),
    durationMs: normalizeNonNegativeNumber(usage.durationMs, "usage.durationMs"),
    toolCalls: normalizeNonNegativeNumber(usage.toolCalls, "usage.toolCalls"),
  };
}

export function mapBudgetReasonToStopClass(reasonCode = "") {
  const normalized = String(reasonCode || "").trim().toUpperCase();
  switch (normalized) {
    case "MAX_COST_EXCEEDED":
      return "MAX_COST_EXCEEDED";
    case "MAX_OUTPUT_TOKENS_EXCEEDED":
      return "MAX_OUTPUT_TOKENS_EXCEEDED";
    case "DIMINISHING_RETURNS":
      return "DIMINISHING_RETURNS";
    case "MAX_RUNTIME_MS_EXCEEDED":
      return "MAX_RUNTIME_MS_EXCEEDED";
    case "MAX_TOOL_CALLS_EXCEEDED":
      return "MAX_TOOL_CALLS_EXCEEDED";
    default:
      return "UNKNOWN";
  }
}

export function deriveStopClassFromBudget(budget = {}) {
  if (!budget || !Array.isArray(budget.reasons) || budget.reasons.length === 0) {
    return "NONE";
  }
  const firstReasonCode = String(budget.reasons[0]?.code || "").trim().toUpperCase();
  return mapBudgetReasonToStopClass(firstReasonCode);
}

export function normalizeRunEvent(event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Run event must be an object.");
  }

  const eventType = String(event.eventType || "").trim();
  if (!RUN_EVENT_TYPE_SET.has(eventType)) {
    throw new Error(
      `Unsupported event type '${eventType}'. Allowed: ${RUN_EVENT_TYPES.join(", ")}.`
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: String(event.eventId || "").trim() || randomUUID(),
    timestamp: String(event.timestamp || "").trim() || new Date().toISOString(),
    sessionId: String(event.sessionId || "").trim() || "default",
    runId: String(event.runId || "").trim() || "default",
    eventType,
    usage: normalizeUsage(event.usage),
    stop: normalizeStop(event.stop),
    metadata: normalizeMetadata(event.metadata),
  };
}

function getInitialSummary() {
  return {
    eventCount: 0,
    runCount: 0,
    sessionCount: 0,
    earliestTimestamp: null,
    latestTimestamp: null,
    eventTypeCounts: {},
    stopClassCounts: {},
    reasonCodeCounts: {},
    usageTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolCalls: 0,
    },
  };
}

function incrementCounter(container, key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    return;
  }
  container[normalizedKey] = Number(container[normalizedKey] || 0) + 1;
}

function mergeUsageTotals(totals, usage = {}) {
  totals.inputTokens += normalizeNonNegativeNumber(usage.inputTokens, "usage.inputTokens");
  totals.outputTokens += normalizeNonNegativeNumber(usage.outputTokens, "usage.outputTokens");
  totals.cacheReadTokens += normalizeNonNegativeNumber(usage.cacheReadTokens, "usage.cacheReadTokens");
  totals.cacheWriteTokens += normalizeNonNegativeNumber(
    usage.cacheWriteTokens,
    "usage.cacheWriteTokens"
  );
  totals.costUsd += normalizeNonNegativeNumber(usage.costUsd, "usage.costUsd");
  totals.durationMs += normalizeNonNegativeNumber(usage.durationMs, "usage.durationMs");
  totals.toolCalls += normalizeNonNegativeNumber(usage.toolCalls, "usage.toolCalls");
}

export function summarizeRunEvents(events = []) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array.");
  }

  const summary = getInitialSummary();
  const runIds = new Set();
  const sessionIds = new Set();

  for (const rawEvent of events) {
    const event = normalizeRunEvent(rawEvent);
    summary.eventCount += 1;
    runIds.add(event.runId);
    sessionIds.add(event.sessionId);
    incrementCounter(summary.eventTypeCounts, event.eventType);
    mergeUsageTotals(summary.usageTotals, event.usage);

    if (!summary.earliestTimestamp || event.timestamp < summary.earliestTimestamp) {
      summary.earliestTimestamp = event.timestamp;
    }
    if (!summary.latestTimestamp || event.timestamp > summary.latestTimestamp) {
      summary.latestTimestamp = event.timestamp;
    }

    if (event.stop) {
      incrementCounter(summary.stopClassCounts, event.stop.stopClass);
      for (const reasonCode of event.stop.reasonCodes || []) {
        incrementCounter(summary.reasonCodeCounts, reasonCode);
      }
    }
  }

  summary.runCount = runIds.size;
  summary.sessionCount = sessionIds.size;
  return summary;
}

export async function resolveRunEventsPath({
  targetPath = ".",
  outputDirOverride = "",
  env,
  homeDir,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(targetPath),
    outputDirOverride,
    env,
    homeDir,
  });
  return path.join(outputRoot, OBSERVABILITY_DIR_NAME, RUN_EVENTS_FILE_NAME);
}

export async function appendRunEvent(options = {}, event = {}) {
  const normalizedEvent = normalizeRunEvent(event);
  const filePath = await resolveRunEventsPath(options);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(normalizedEvent)}\n`, "utf-8");
  return {
    filePath,
    event: normalizedEvent,
  };
}

export async function loadRunEvents(options = {}) {
  const filePath = await resolveRunEventsPath(options);
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const events = lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid run event JSON at ${filePath}:${index + 1} (${error instanceof Error ? error.message : String(error)}).`
        );
      }
    });
    return { filePath, events };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { filePath, events: [] };
    }
    throw error;
  }
}

