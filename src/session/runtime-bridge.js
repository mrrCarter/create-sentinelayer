import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createAgentEvent } from "../events/schema.js";
import { resolveSessionPaths } from "./paths.js";
import { appendToStream } from "./stream.js";

const RUNTIME_BRIDGE_AGENT_ID = "runtime-bridge";
const DEFAULT_HEARTBEAT_MS = 30_000;

const STOP_CLASSES = Object.freeze([
  "clean",
  "budget_exhausted",
  "blocked_by_policy",
  "awaiting_hitl",
  "infra_error",
  "validation_error",
  "manual_stop",
]);

const ACTIVE_RUNTIME_RUNS = new Map();

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

function normalizePositiveInteger(value, fallbackValue = 1) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.max(1, Math.floor(normalized));
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const deduped = new Set();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return [...deduped];
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegex(pattern) {
  const escaped = escapeRegex(pattern);
  const withDoubleWildcard = escaped.replace(/\\\*\\\*/g, ".*");
  const withSingleWildcard = withDoubleWildcard.replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${withSingleWildcard}$`, "i");
}

function matchWildcard(value, patterns = []) {
  const normalizedValue = normalizeString(value).replace(/\\/g, "/");
  if (!normalizedValue) {
    return false;
  }
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeString(pattern).replace(/\\/g, "/");
    if (!normalizedPattern) {
      return false;
    }
    return wildcardToRegex(normalizedPattern).test(normalizedValue);
  });
}

function buildRuntimeRunKey(sessionId, runId, targetPath) {
  return `${path.resolve(String(targetPath || "."))}::${normalizeString(sessionId)}::${normalizeString(runId)}`;
}

function normalizeScopeEnvelope(scopeEnvelope = {}) {
  const normalized = scopeEnvelope && typeof scopeEnvelope === "object" && !Array.isArray(scopeEnvelope)
    ? { ...scopeEnvelope }
    : {};
  const allowedTools = normalizeStringArray(normalized.allowedTools || normalized.allowed_tools || []);
  const allowedPaths = normalizeStringArray(normalized.allowedPaths || normalized.allowed_paths || []);
  const deniedPaths = normalizeStringArray(normalized.deniedPaths || normalized.denied_paths || []);

  if (allowedTools.length === 0) {
    throw new Error("scopeEnvelope.allowedTools (or allowed_tools) must include at least one tool.");
  }

  return {
    allowedTools,
    allowedPaths,
    deniedPaths,
  };
}

function normalizeBudgetEnvelope(budgetEnvelope = {}) {
  const normalized = budgetEnvelope && typeof budgetEnvelope === "object" && !Array.isArray(budgetEnvelope)
    ? { ...budgetEnvelope }
    : {};
  const maxTokens = normalizePositiveInteger(
    normalized.maxTokens ?? normalized.max_tokens,
    1
  );
  const maxCostUsd = normalizeNonNegativeNumber(
    normalized.maxCostUsd ?? normalized.max_cost_usd,
    0
  );
  const maxRuntimeMinutes = normalizePositiveInteger(
    normalized.maxRuntimeMinutes ?? normalized.max_runtime_minutes,
    1
  );
  const maxToolCalls = normalizePositiveInteger(
    normalized.maxToolCalls ?? normalized.max_tool_calls,
    1
  );
  const networkDomainAllowlist = normalizeStringArray(
    normalized.networkDomainAllowlist ?? normalized.network_domain_allowlist ?? []
  );

  if (maxCostUsd <= 0) {
    throw new Error("budgetEnvelope.maxCostUsd (or max_cost_usd) must be > 0.");
  }

  return {
    maxTokens,
    maxCostUsd,
    maxRuntimeMinutes,
    maxToolCalls,
    networkDomainAllowlist,
  };
}

function createInitialUsage(nowIso) {
  return {
    tokensUsed: 0,
    costUsd: 0,
    runtimeMs: 0,
    toolCalls: 0,
    pathOutOfScopeHits: 0,
    networkDomainViolations: 0,
    lastHeartbeatAt: normalizeIsoTimestamp(nowIso, nowIso),
  };
}

function copyUsage(usage = {}, fallbackIso = new Date().toISOString()) {
  return {
    tokensUsed: normalizeNonNegativeNumber(usage.tokensUsed, 0),
    costUsd: Number(normalizeNonNegativeNumber(usage.costUsd, 0).toFixed(6)),
    runtimeMs: normalizeNonNegativeNumber(usage.runtimeMs, 0),
    toolCalls: normalizeNonNegativeNumber(usage.toolCalls, 0),
    pathOutOfScopeHits: normalizeNonNegativeNumber(usage.pathOutOfScopeHits, 0),
    networkDomainViolations: normalizeNonNegativeNumber(usage.networkDomainViolations, 0),
    lastHeartbeatAt: normalizeIsoTimestamp(usage.lastHeartbeatAt, fallbackIso),
  };
}

function mergeUsage(stateUsage = {}, usageUpdate = {}, nowIso = new Date().toISOString()) {
  const usage = copyUsage(stateUsage, nowIso);
  const update = usageUpdate && typeof usageUpdate === "object" && !Array.isArray(usageUpdate)
    ? usageUpdate
    : {};
  const delta = update.delta && typeof update.delta === "object" && !Array.isArray(update.delta)
    ? update.delta
    : {};

  const absolutePairs = [
    "tokensUsed",
    "costUsd",
    "runtimeMs",
    "toolCalls",
    "pathOutOfScopeHits",
    "networkDomainViolations",
  ];
  for (const key of absolutePairs) {
    if (update[key] !== undefined) {
      usage[key] = Math.max(usage[key], normalizeNonNegativeNumber(update[key], usage[key]));
    }
  }
  for (const key of absolutePairs) {
    if (delta[key] !== undefined) {
      usage[key] += normalizeNonNegativeNumber(delta[key], 0);
    }
  }

  usage.costUsd = Number(normalizeNonNegativeNumber(usage.costUsd, 0).toFixed(6));
  usage.lastHeartbeatAt = normalizeIsoTimestamp(
    update.lastHeartbeatAt || update.last_heartbeat_at || nowIso,
    nowIso
  );
  return usage;
}

function isPathInScope(candidatePath, scopeEnvelope = {}) {
  const normalizedPath = normalizeString(candidatePath).replace(/\\/g, "/");
  if (!normalizedPath) {
    return true;
  }
  if (matchWildcard(normalizedPath, scopeEnvelope.deniedPaths)) {
    return false;
  }
  if (!Array.isArray(scopeEnvelope.allowedPaths) || scopeEnvelope.allowedPaths.length === 0) {
    return true;
  }
  return matchWildcard(normalizedPath, scopeEnvelope.allowedPaths);
}

function isDomainAllowed(candidateDomain, budgetEnvelope = {}) {
  const normalizedDomain = normalizeString(candidateDomain).toLowerCase();
  if (!normalizedDomain) {
    return true;
  }
  if (
    !Array.isArray(budgetEnvelope.networkDomainAllowlist) ||
    budgetEnvelope.networkDomainAllowlist.length === 0
  ) {
    return true;
  }
  return budgetEnvelope.networkDomainAllowlist.some((allowedPattern) => {
    const normalizedPattern = normalizeString(allowedPattern).toLowerCase();
    if (!normalizedPattern) {
      return false;
    }
    if (normalizedPattern.startsWith("*.")) {
      const suffix = normalizedPattern.slice(1);
      return normalizedDomain.endsWith(suffix);
    }
    return normalizedDomain === normalizedPattern;
  });
}

function evaluateStopPredicate(runtimeState, nowIso) {
  const usage = runtimeState.usage;
  const budget = runtimeState.budgetEnvelope;
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  const startedEpoch = Date.parse(normalizeIsoTimestamp(runtimeState.startedAt, nowIso));
  const elapsedMs =
    Number.isFinite(nowEpoch) && Number.isFinite(startedEpoch)
      ? Math.max(0, nowEpoch - startedEpoch)
      : usage.runtimeMs;
  usage.runtimeMs = Math.max(usage.runtimeMs, elapsedMs);

  if (usage.pathOutOfScopeHits >= 1) {
    return {
      shouldStop: true,
      stopClass: "blocked_by_policy",
      stopCode: "PATH_OUT_OF_SCOPE",
      reason: "Path access attempted outside allowed scope envelope.",
    };
  }
  if (usage.networkDomainViolations >= 1) {
    return {
      shouldStop: true,
      stopClass: "blocked_by_policy",
      stopCode: "NETWORK_DOMAIN_VIOLATION",
      reason: "Network domain attempted outside allowlist.",
    };
  }
  if (usage.tokensUsed >= budget.maxTokens) {
    return {
      shouldStop: true,
      stopClass: "budget_exhausted",
      stopCode: "MAX_TOKENS_EXCEEDED",
      reason: "Token ceiling reached.",
    };
  }
  if (usage.costUsd >= budget.maxCostUsd) {
    return {
      shouldStop: true,
      stopClass: "budget_exhausted",
      stopCode: "MAX_COST_EXCEEDED",
      reason: "Cost ceiling reached.",
    };
  }
  if (usage.runtimeMs >= budget.maxRuntimeMinutes * 60_000) {
    return {
      shouldStop: true,
      stopClass: "budget_exhausted",
      stopCode: "MAX_RUNTIME_EXCEEDED",
      reason: "Runtime ceiling reached.",
    };
  }
  if (usage.toolCalls >= budget.maxToolCalls) {
    return {
      shouldStop: true,
      stopClass: "budget_exhausted",
      stopCode: "MAX_TOOL_CALLS_EXCEEDED",
      reason: "Tool-call ceiling reached.",
    };
  }
  return {
    shouldStop: false,
    stopClass: "clean",
    stopCode: "NONE",
    reason: "",
  };
}

function toRuntimeSnapshot(runtimeState) {
  return {
    sessionId: runtimeState.sessionId,
    runId: runtimeState.runId,
    workItemId: runtimeState.workItemId,
    targetPath: runtimeState.targetPath,
    startedAt: runtimeState.startedAt,
    stoppedAt: runtimeState.stoppedAt,
    running: runtimeState.running,
    stopClass: runtimeState.stopClass,
    stopCode: runtimeState.stopCode,
    stopReason: runtimeState.stopReason,
    scopeEnvelope: runtimeState.scopeEnvelope,
    budgetEnvelope: runtimeState.budgetEnvelope,
    usage: copyUsage(runtimeState.usage, runtimeState.startedAt),
    runtimePath: runtimeState.runtimePath,
  };
}

async function persistRuntimeState(runtimeState) {
  const payload = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    ...toRuntimeSnapshot(runtimeState),
  };
  await fsp.mkdir(path.dirname(runtimeState.runtimePath), { recursive: true });
  await fsp.writeFile(runtimeState.runtimePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function emitRuntimeEvent(
  sessionId,
  event,
  payload = {},
  { targetPath = process.cwd(), workItemId = "", nowIso = new Date().toISOString() } = {}
) {
  const envelope = createAgentEvent({
    event,
    agentId: RUNTIME_BRIDGE_AGENT_ID,
    sessionId,
    workItemId: normalizeString(workItemId) || undefined,
    ts: normalizeIsoTimestamp(nowIso, new Date().toISOString()),
    payload,
  });
  await appendToStream(sessionId, envelope, {
    targetPath,
  });
  return envelope;
}

function clearHeartbeatTimer(runtimeState) {
  if (runtimeState.heartbeatTimer) {
    clearInterval(runtimeState.heartbeatTimer);
    runtimeState.heartbeatTimer = null;
  }
}

function resolveRuntimeState(sessionId, runId, targetPath) {
  const key = buildRuntimeRunKey(sessionId, runId, targetPath);
  const runtimeState = ACTIVE_RUNTIME_RUNS.get(key);
  if (!runtimeState) {
    throw new Error(`Runtime run '${normalizeString(runId)}' was not found in session '${normalizeString(sessionId)}'.`);
  }
  return runtimeState;
}

function validateStopClass(value) {
  const normalized = normalizeString(value);
  if (!STOP_CLASSES.includes(normalized)) {
    throw new Error(`stopClass must be one of: ${STOP_CLASSES.join(", ")}.`);
  }
  return normalized;
}

function normalizePathAccesses(pathAccesses = []) {
  if (!Array.isArray(pathAccesses)) {
    return [];
  }
  return pathAccesses
    .map((entry) => {
      if (typeof entry === "string") {
        return { path: normalizeString(entry) };
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      return {
        path: normalizeString(entry.path || entry.file || entry.filePath),
      };
    })
    .filter((entry) => entry && entry.path);
}

function normalizeNetworkDomains(networkDomains = []) {
  if (!Array.isArray(networkDomains)) {
    return [];
  }
  return networkDomains
    .map((entry) => normalizeString(entry).toLowerCase())
    .filter(Boolean);
}

export async function createRuntimeRun({
  sessionId,
  workItemId,
  scopeEnvelope,
  budgetEnvelope,
  targetPath = ".",
  runId = "",
  autoHeartbeat = false,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }

  const normalizedScope = normalizeScopeEnvelope(scopeEnvelope);
  const normalizedBudget = normalizeBudgetEnvelope(budgetEnvelope);
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedRunId = normalizeString(runId) || `runtime-${randomUUID()}`;
  const runtimeKey = buildRuntimeRunKey(normalizedSessionId, normalizedRunId, normalizedTargetPath);
  if (ACTIVE_RUNTIME_RUNS.has(runtimeKey)) {
    return toRuntimeSnapshot(ACTIVE_RUNTIME_RUNS.get(runtimeKey));
  }

  const nowIso = new Date().toISOString();
  const sessionPaths = resolveSessionPaths(normalizedSessionId, {
    targetPath: normalizedTargetPath,
  });
  const runtimePath = path.join(sessionPaths.runtimeRunsDir, `${normalizedRunId}.json`);
  const runtimeState = {
    sessionId: normalizedSessionId,
    runId: normalizedRunId,
    workItemId: normalizedWorkItemId,
    targetPath: normalizedTargetPath,
    startedAt: nowIso,
    stoppedAt: null,
    running: true,
    stopClass: "clean",
    stopCode: "NONE",
    stopReason: "",
    usage: createInitialUsage(nowIso),
    scopeEnvelope: normalizedScope,
    budgetEnvelope: normalizedBudget,
    runtimePath,
    heartbeatTimer: null,
  };

  ACTIVE_RUNTIME_RUNS.set(runtimeKey, runtimeState);
  await persistRuntimeState(runtimeState);
  await emitRuntimeEvent(
    normalizedSessionId,
    "runtime_run_started",
    {
      runId: normalizedRunId,
      workItemId: normalizedWorkItemId,
      scopeEnvelope: normalizedScope,
      budgetEnvelope: normalizedBudget,
      stopClass: "clean",
      stopCode: "NONE",
    },
    {
      targetPath: normalizedTargetPath,
      workItemId: normalizedWorkItemId,
      nowIso,
    }
  );

  if (autoHeartbeat) {
    const intervalMs = normalizePositiveInteger(heartbeatMs, DEFAULT_HEARTBEAT_MS);
    runtimeState.heartbeatTimer = setInterval(() => {
      void heartbeatRuntimeRun(normalizedSessionId, normalizedRunId, {
        targetPath: normalizedTargetPath,
      }).catch(() => {});
    }, intervalMs);
    if (typeof runtimeState.heartbeatTimer.unref === "function") {
      runtimeState.heartbeatTimer.unref();
    }
  }

  return toRuntimeSnapshot(runtimeState);
}

export async function heartbeatRuntimeRun(
  sessionId,
  runId,
  {
    targetPath = ".",
    nowIso = new Date().toISOString(),
    usage = {},
    pathAccesses = [],
    networkDomains = [],
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedRunId = normalizeString(runId);
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const runtimeState = resolveRuntimeState(normalizedSessionId, normalizedRunId, normalizedTargetPath);
  if (!runtimeState.running) {
    return toRuntimeSnapshot(runtimeState);
  }

  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedPathAccesses = normalizePathAccesses(pathAccesses);
  const normalizedDomains = normalizeNetworkDomains(networkDomains);

  for (const access of normalizedPathAccesses) {
    if (!isPathInScope(access.path, runtimeState.scopeEnvelope)) {
      runtimeState.usage.pathOutOfScopeHits += 1;
    }
  }
  for (const domain of normalizedDomains) {
    if (!isDomainAllowed(domain, runtimeState.budgetEnvelope)) {
      runtimeState.usage.networkDomainViolations += 1;
    }
  }

  runtimeState.usage = mergeUsage(runtimeState.usage, usage, normalizedNow);
  const predicate = evaluateStopPredicate(runtimeState, normalizedNow);
  if (predicate.shouldStop) {
    runtimeState.running = false;
    runtimeState.stoppedAt = normalizedNow;
    runtimeState.stopClass = validateStopClass(predicate.stopClass);
    runtimeState.stopCode = normalizeString(predicate.stopCode) || "STOP_TRIGGERED";
    runtimeState.stopReason = normalizeString(predicate.reason) || "Runtime stop predicate triggered.";
    clearHeartbeatTimer(runtimeState);
    await persistRuntimeState(runtimeState);
    await emitRuntimeEvent(
      normalizedSessionId,
      "runtime_run_stop",
      {
        runId: runtimeState.runId,
        workItemId: runtimeState.workItemId,
        stopClass: runtimeState.stopClass,
        stopCode: runtimeState.stopCode,
        reason: runtimeState.stopReason,
        usage: copyUsage(runtimeState.usage, normalizedNow),
      },
      {
        targetPath: normalizedTargetPath,
        workItemId: runtimeState.workItemId,
        nowIso: normalizedNow,
      }
    );
    return toRuntimeSnapshot(runtimeState);
  }

  await persistRuntimeState(runtimeState);
  await emitRuntimeEvent(
    normalizedSessionId,
    "runtime_run_heartbeat",
    {
      runId: runtimeState.runId,
      workItemId: runtimeState.workItemId,
      usage: copyUsage(runtimeState.usage, normalizedNow),
      predicateState: {
        pathOutOfScopeHits: runtimeState.usage.pathOutOfScopeHits,
        networkDomainViolations: runtimeState.usage.networkDomainViolations,
      },
    },
    {
      targetPath: normalizedTargetPath,
      workItemId: runtimeState.workItemId,
      nowIso: normalizedNow,
    }
  );
  return toRuntimeSnapshot(runtimeState);
}

export async function stopRuntimeRun(
  sessionId,
  runId,
  {
    targetPath = ".",
    reason = "manual_stop",
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedRunId = normalizeString(runId);
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const runtimeState = resolveRuntimeState(normalizedSessionId, normalizedRunId, normalizedTargetPath);
  if (!runtimeState.running) {
    return toRuntimeSnapshot(runtimeState);
  }

  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  runtimeState.running = false;
  runtimeState.stoppedAt = normalizedNow;
  runtimeState.stopClass = "manual_stop";
  runtimeState.stopCode = "MANUAL_STOP";
  runtimeState.stopReason = normalizeString(reason) || "Runtime run manually stopped.";
  clearHeartbeatTimer(runtimeState);
  await persistRuntimeState(runtimeState);
  await emitRuntimeEvent(
    normalizedSessionId,
    "runtime_run_stop",
    {
      runId: runtimeState.runId,
      workItemId: runtimeState.workItemId,
      stopClass: runtimeState.stopClass,
      stopCode: runtimeState.stopCode,
      reason: runtimeState.stopReason,
      usage: copyUsage(runtimeState.usage, normalizedNow),
    },
    {
      targetPath: normalizedTargetPath,
      workItemId: runtimeState.workItemId,
      nowIso: normalizedNow,
    }
  );
  return toRuntimeSnapshot(runtimeState);
}

export async function stopRuntimeRunsForSession(
  sessionId,
  {
    targetPath = ".",
    reason = "manual_stop",
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("sessionId is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const stoppedRuns = [];

  for (const runtimeState of ACTIVE_RUNTIME_RUNS.values()) {
    if (
      runtimeState.sessionId !== normalizedSessionId ||
      runtimeState.targetPath !== normalizedTargetPath ||
      runtimeState.running !== true
    ) {
      continue;
    }
    const stopped = await stopRuntimeRun(normalizedSessionId, runtimeState.runId, {
      targetPath: normalizedTargetPath,
      reason,
      nowIso,
    });
    stoppedRuns.push(stopped);
  }

  return {
    sessionId: normalizedSessionId,
    targetPath: normalizedTargetPath,
    stoppedCount: stoppedRuns.length,
    runs: stoppedRuns,
  };
}

export function getRuntimeRun(
  sessionId,
  runId,
  {
    targetPath = ".",
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedRunId = normalizeString(runId);
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const key = buildRuntimeRunKey(normalizedSessionId, normalizedRunId, normalizedTargetPath);
  const runtimeState = ACTIVE_RUNTIME_RUNS.get(key);
  return runtimeState ? toRuntimeSnapshot(runtimeState) : null;
}

export function listRuntimeRuns({
  sessionId = "",
  targetPath = ".",
  includeStopped = true,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const runs = [];
  for (const runtimeState of ACTIVE_RUNTIME_RUNS.values()) {
    if (runtimeState.targetPath !== normalizedTargetPath) {
      continue;
    }
    if (normalizedSessionId && runtimeState.sessionId !== normalizedSessionId) {
      continue;
    }
    if (!includeStopped && runtimeState.running !== true) {
      continue;
    }
    runs.push(toRuntimeSnapshot(runtimeState));
  }
  runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return runs;
}

export function validateScopeEnvelope(scopeEnvelope = {}) {
  try {
    normalizeScopeEnvelope(scopeEnvelope);
    return true;
  } catch {
    return false;
  }
}

export function validateBudgetEnvelope(budgetEnvelope = {}) {
  try {
    normalizeBudgetEnvelope(budgetEnvelope);
    return true;
  } catch {
    return false;
  }
}

export {
  DEFAULT_HEARTBEAT_MS,
  RUNTIME_BRIDGE_AGENT_ID,
  STOP_CLASSES,
};
