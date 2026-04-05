import { randomUUID } from "node:crypto";
import { evaluateBudget } from "../../../cost/budget.js";
import {
  normalizeRunEvent,
  appendRunEvent,
} from "../../../telemetry/ledger.js";
import { fileRead } from "./file-read.js";
import { grep } from "./grep.js";
import { glob } from "./glob.js";
import { shell } from "./shell.js";
import { fileEdit } from "./file-edit.js";
import { frontendAnalyze } from "./frontend-analyze.js";
import { runtimeAudit } from "./runtime-audit.js";

/**
 * Central tool dispatcher for Jules agents.
 * Every tool call: budget check → telemetry emit → execute → telemetry result → return.
 */

const TOOL_MAP = {
  FileRead: fileRead,
  Grep: grep,
  Glob: glob,
  Shell: shell,
  FileEdit: fileEdit,
  FrontendAnalyze: frontendAnalyze,
  RuntimeAudit: runtimeAudit,
};

const READ_ONLY_TOOLS = new Set(["FileRead", "Grep", "Glob", "FrontendAnalyze", "RuntimeAudit"]);

const RESULT_PERSIST_THRESHOLD = 5000;

/**
 * @param {string} toolName
 * @param {object} input
 * @param {AgentContext} ctx
 * @returns {Promise<ToolResult>}
 */
export async function dispatchTool(toolName, input, ctx) {
  const handler = TOOL_MAP[toolName];
  if (!handler) {
    throw new ToolDispatchError(`Unknown tool: ${toolName}`);
  }

  // 1. Pre-flight budget check
  const budgetCheck = evaluateBudget({
    maxCostUsd: ctx.budget.maxCostUsd,
    maxOutputTokens: ctx.budget.maxOutputTokens,
    maxRuntimeMs: ctx.budget.maxRuntimeMs,
    maxToolCalls: ctx.budget.maxToolCalls,
    warningThresholdPercent: ctx.budget.warningThresholdPercent ?? 70,
    maxNoProgress: 0,
    sessionSummary: {
      costUsd: ctx.usage.costUsd,
      outputTokens: ctx.usage.outputTokens,
      durationMs: Date.now() - ctx.startedAt,
      toolCalls: ctx.usage.toolCalls + 1,
      noProgressStreak: 0,
    },
  });

  if (budgetCheck.blocking) {
    const stopEvent = {
      eventType: "run_stop",
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      stop: {
        stopClass: budgetCheck.reasons[0]?.code || "MAX_TOOL_CALLS_EXCEEDED",
        blocking: true,
        reasonCodes: budgetCheck.reasons.map((r) => r.code),
      },
      usage: snapshotUsage(ctx),
      metadata: { tool: toolName, phase: "pre_flight" },
    };
    await safeAppendEvent(ctx, stopEvent);

    if (ctx.onEvent) {
      ctx.onEvent({
        stream: "sl_event",
        event: "budget_stop",
        agent: ctx.agentIdentity,
        payload: {
          stopClass: stopEvent.stop.stopClass,
          reasons: budgetCheck.reasons,
        },
        usage: snapshotUsage(ctx),
      });
    }

    throw new BudgetExhaustedError(budgetCheck);
  }

  // Emit budget warnings
  if (budgetCheck.warnings.length > 0 && ctx.onEvent) {
    ctx.onEvent({
      stream: "sl_event",
      event: "budget_warning",
      agent: ctx.agentIdentity,
      payload: { warnings: budgetCheck.warnings },
      usage: snapshotUsage(ctx),
    });
  }

  // 2. Emit tool_call event
  const eventId = randomUUID();
  const callEvent = {
    eventType: "tool_call",
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    metadata: {
      eventId,
      tool: toolName,
      input: sanitizeInput(toolName, input),
      agentId: ctx.agentIdentity?.id,
      persona: ctx.agentIdentity?.persona,
    },
  };
  await safeAppendEvent(ctx, callEvent);

  if (ctx.onEvent) {
    ctx.onEvent({
      stream: "sl_event",
      event: "tool_call",
      agent: ctx.agentIdentity,
      payload: { tool: toolName, input: sanitizeInput(toolName, input) },
      usage: snapshotUsage(ctx),
    });
  }

  // 3. Execute
  const startMs = Date.now();
  let result;
  let error;
  try {
    result = handler(input);
  } catch (err) {
    error = err;
  }
  const durationMs = Date.now() - startMs;

  // 4. Update accumulated usage
  ctx.usage.toolCalls++;
  ctx.usage.runtimeMs = Date.now() - ctx.startedAt;
  ctx.lastToolCallAt = Date.now();
  ctx.lastToolName = toolName;

  // 5. Emit tool_result event
  const resultEvent = {
    eventType: "tool_call",
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    usage: {
      durationMs,
      toolCalls: 1,
    },
    metadata: {
      eventId,
      phase: "result",
      tool: toolName,
      success: !error,
      error: error?.message,
      agentId: ctx.agentIdentity?.id,
    },
  };
  await safeAppendEvent(ctx, resultEvent);

  if (ctx.onEvent) {
    ctx.onEvent({
      stream: "sl_event",
      event: "tool_result",
      agent: ctx.agentIdentity,
      payload: {
        tool: toolName,
        durationMs,
        success: !error,
        error: error?.message,
      },
      usage: snapshotUsage(ctx),
    });
  }

  if (error) throw error;

  // 6. Large result persistence
  const serialized = JSON.stringify(result);
  if (serialized.length > RESULT_PERSIST_THRESHOLD && ctx.artifactDir) {
    const refPath = `${ctx.artifactDir}/tool-results/${eventId}.json`;
    const fsp = await import("node:fs/promises");
    await fsp.mkdir(`${ctx.artifactDir}/tool-results`, { recursive: true });
    await fsp.writeFile(refPath, serialized, "utf-8");
    return {
      _persisted: true,
      _refPath: refPath,
      _summary: summarizeResult(toolName, result),
    };
  }

  return result;
}

/**
 * Register an additional tool (e.g., FrontendAnalyze from PR J-2).
 */
export function registerTool(name, handler, { readOnly = false } = {}) {
  TOOL_MAP[name] = handler;
  if (readOnly) READ_ONLY_TOOLS.add(name);
}

/**
 * Check if a tool is read-only (safe for concurrent execution).
 */
export function isReadOnlyTool(toolName) {
  return READ_ONLY_TOOLS.has(toolName);
}

/**
 * Get list of available tool names.
 */
export function listTools() {
  return Object.keys(TOOL_MAP);
}

/**
 * Create an agent context for tool dispatch.
 */
export function createAgentContext({
  agentIdentity,
  budget,
  sessionId,
  runId,
  artifactDir,
  onEvent,
}) {
  return {
    agentIdentity,
    budget: {
      maxCostUsd: budget?.maxCostUsd ?? 5.0,
      maxOutputTokens: budget?.maxOutputTokens ?? 12000,
      maxRuntimeMs: budget?.maxRuntimeMs ?? 300000,
      maxToolCalls: budget?.maxToolCalls ?? 150,
      warningThresholdPercent: budget?.warningThresholdPercent ?? 70,
    },
    usage: {
      costUsd: 0,
      outputTokens: 0,
      toolCalls: 0,
      runtimeMs: 0,
    },
    sessionId: sessionId || randomUUID(),
    runId: runId || `jules-${Date.now()}-${randomUUID().slice(0, 8)}`,
    artifactDir,
    startedAt: Date.now(),
    lastToolCallAt: Date.now(),
    lastToolName: null,
    onEvent,
  };
}

function snapshotUsage(ctx) {
  return {
    costUsd: ctx.usage.costUsd,
    outputTokens: ctx.usage.outputTokens,
    toolCalls: ctx.usage.toolCalls,
    durationMs: Date.now() - ctx.startedAt,
  };
}

function sanitizeInput(toolName, input) {
  // Strip file content from telemetry (only log metadata)
  const sanitized = { ...input };
  if (sanitized.content && sanitized.content.length > 200) {
    sanitized.content = `[${sanitized.content.length} chars]`;
  }
  return sanitized;
}

function summarizeResult(toolName, result) {
  if (toolName === "FileRead") {
    return `Read ${result.numLines} lines from ${result.filePath}`;
  }
  if (toolName === "Grep") {
    return `${result.numMatches} matches in ${result.numFiles} files`;
  }
  if (toolName === "Glob") {
    return `${result.numFiles} files matched`;
  }
  if (toolName === "Shell") {
    return `Exit ${result.exitCode} in ${result.durationMs}ms`;
  }
  return `${toolName} completed`;
}

async function safeAppendEvent(ctx, eventData) {
  try {
    const normalized = normalizeRunEvent({
      ...eventData,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
    });
    if (ctx.artifactDir) {
      await appendRunEvent(
        { targetPath: ctx.artifactDir, outputDir: ctx.artifactDir },
        normalized,
      );
    }
  } catch {
    // Telemetry failures must not block tool execution
  }
}

export class ToolDispatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolDispatchError";
  }
}

export class BudgetExhaustedError extends Error {
  constructor(budgetCheck) {
    super(`Budget exhausted: ${budgetCheck.reasons.map((r) => r.code).join(", ")}`);
    this.name = "BudgetExhaustedError";
    this.budgetCheck = budgetCheck;
  }
}
