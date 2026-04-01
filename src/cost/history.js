import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveOutputRoot } from "../config/service.js";
import { rollupUsage } from "./tracker.js";

const HISTORY_VERSION = 1;
const HISTORY_FILE_NAME = "cost-history.json";

function normalizeNumber(value, field) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function normalizeProgressScore(value) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  return normalized;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Cost entry must be an object.");
  }

  const provider = String(entry.provider || "").trim().toLowerCase();
  const model = String(entry.model || "").trim();
  if (!provider) {
    throw new Error("Cost entry provider is required.");
  }
  if (!model) {
    throw new Error("Cost entry model is required.");
  }

  const invocationId = String(entry.invocationId || "").trim() || randomUUID();
  const sessionId = String(entry.sessionId || "").trim() || "default";
  const timestamp = String(entry.timestamp || "").trim() || new Date().toISOString();

  return {
    invocationId,
    sessionId,
    timestamp,
    provider,
    model,
    inputTokens: normalizeNumber(entry.inputTokens, "entry.inputTokens"),
    outputTokens: normalizeNumber(entry.outputTokens, "entry.outputTokens"),
    cacheReadTokens: normalizeNumber(entry.cacheReadTokens, "entry.cacheReadTokens"),
    cacheWriteTokens: normalizeNumber(entry.cacheWriteTokens, "entry.cacheWriteTokens"),
    durationMs: normalizeNumber(entry.durationMs, "entry.durationMs"),
    toolCalls: normalizeNumber(entry.toolCalls, "entry.toolCalls"),
    costUsd: normalizeNumber(entry.costUsd, "entry.costUsd"),
    progressScore: normalizeProgressScore(entry.progressScore),
  };
}

export async function resolveCostHistoryPath({
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
  return path.join(outputRoot, HISTORY_FILE_NAME);
}

export async function loadCostHistory(options = {}) {
  const filePath = await resolveCostHistoryPath(options);
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      throw new Error("Invalid cost history payload.");
    }
    return {
      filePath,
      history: {
        version: Number(parsed.version || HISTORY_VERSION),
        entries: parsed.entries,
      },
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        filePath,
        history: {
          version: HISTORY_VERSION,
          entries: [],
        },
      };
    }
    throw error;
  }
}

export async function saveCostHistory({ filePath, history }) {
  const payload = {
    version: HISTORY_VERSION,
    entries: Array.isArray(history?.entries) ? history.entries : [],
  };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export async function appendCostEntry(options = {}, entry = {}) {
  const normalizedEntry = normalizeEntry(entry);
  const { filePath, history } = await loadCostHistory(options);
  const nextHistory = {
    version: HISTORY_VERSION,
    entries: [...history.entries, normalizedEntry],
  };
  await saveCostHistory({ filePath, history: nextHistory });
  return {
    filePath,
    entry: normalizedEntry,
    history: nextHistory,
  };
}

function summarizeSessionEntries(entries) {
  const usageEntries = entries.map((item) => ({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    costUsd: item.costUsd,
  }));
  const usage = rollupUsage(usageEntries);
  const cacheReadTokens = entries.reduce((sum, item) => sum + Number(item.cacheReadTokens || 0), 0);
  const cacheWriteTokens = entries.reduce((sum, item) => sum + Number(item.cacheWriteTokens || 0), 0);
  const durationMs = entries.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
  const toolCalls = entries.reduce((sum, item) => sum + Number(item.toolCalls || 0), 0);

  let noProgressStreak = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (Number(entries[index].progressScore || 0) > 0) {
      break;
    }
    noProgressStreak += 1;
  }

  return {
    invocationCount: entries.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    durationMs,
    toolCalls,
    costUsd: usage.costUsd,
    noProgressStreak,
  };
}

export function summarizeCostHistory(history = {}) {
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const sessionMap = new Map();
  for (const entry of entries) {
    const key = String(entry.sessionId || "default");
    const existing = sessionMap.get(key) || [];
    existing.push(entry);
    sessionMap.set(key, existing);
  }

  const sessions = [...sessionMap.entries()]
    .map(([sessionId, sessionEntries]) => ({
      sessionId,
      ...summarizeSessionEntries(sessionEntries),
    }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const totals = summarizeSessionEntries(entries);

  return {
    sessionCount: sessions.length,
    ...totals,
    sessions,
  };
}

