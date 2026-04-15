import { randomUUID } from "node:crypto";
import { createMultiProviderApiClient } from "../../ai/client.js";
import { evaluateBudget } from "../../cost/budget.js";
import { dispatchTool, createAgentContext, BudgetExhaustedError } from "./tools/dispatch.js";
import { JULES_DEFINITION } from "./config/definition.js";
import { shouldSpawnSubAgents, runJulesSwarm } from "./swarm/orchestrator.js";
import { frontendAnalyze } from "./tools/frontend-analyze.js";

/**
 * Jules Tanaka — Agentic Loop
 *
 * Core state machine: LLM → tool_use → execute → result → LLM → repeat
 * With sub-agent swarm integration for large codebases.
 *
 * This loop is self-contained: it uses the existing ai/client.js for LLM calls,
 * the existing cost/budget.js for budget enforcement, and the Jules tool
 * dispatch for tool execution. No dependency on Batches O-Q.
 */

const DEFAULT_MAX_TURNS = 25;
const HEARTBEAT_INTERVAL_TURNS = 5;

/**
 * Run Jules' agentic audit loop.
 *
 * @param {object} config
 * @param {string} config.systemPrompt - Jules' full system prompt
 * @param {object} config.scopeMap - { primary, secondary, tertiary } file lists
 * @param {string} config.rootPath - Codebase root
 * @param {object} [config.omarBaseline] - Deterministic baseline findings (if available)
 * @param {object} [config.blackboard] - Shared blackboard for cross-agent findings
 * @param {object} [config.memory] - Memory index for cross-run recall
 * @param {object} [config.budget] - Budget overrides
 * @param {object} [config.provider] - LLM provider overrides
 * @param {string} [config.mode] - "primary" | "secondary" | "tertiary"
 * @param {number} [config.maxTurns] - Max loop iterations
 * @param {AbortController} [config.abortController]
 * @param {function} [config.onEvent] - Streaming event callback
 * @returns {AsyncGenerator<JulesEvent>} Yields events as they occur
 */
export async function* julesAuditLoop(config) {
  const {
    systemPrompt,
    scopeMap,
    rootPath,
    omarBaseline,
    blackboard,
    memory,
    provider,
    mode = "primary",
    maxTurns = DEFAULT_MAX_TURNS,
    abortController,
    onEvent,
  } = config;

  const budget = { ...JULES_DEFINITION.budget, ...config.budget };
  const runId = `jules-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const client = createMultiProviderApiClient(provider || {});

  const ctx = createAgentContext({
    agentIdentity: { id: JULES_DEFINITION.id, persona: JULES_DEFINITION.persona },
    budget,
    runId,
    onEvent,
  });

  const emit = (event, payload) => {
    const evt = {
      stream: "sl_event",
      event,
      agent: { id: JULES_DEFINITION.id, persona: JULES_DEFINITION.persona, color: JULES_DEFINITION.color, avatar: JULES_DEFINITION.avatar },
      payload,
      usage: {
        costUsd: ctx.usage.costUsd,
        outputTokens: ctx.usage.outputTokens,
        toolCalls: ctx.usage.toolCalls,
        durationMs: Date.now() - startedAt,
      },
    };
    if (onEvent) onEvent(evt);
    return evt;
  };

  yield emit("agent_start", { mode, runId, maxTurns, budget });

  // ── Phase 0: Prerequisites ────────────────────────────────────────

  yield emit("progress", { phase: "prerequisites", message: "Detecting framework..." });

  let framework = {};
  try {
    framework = frontendAnalyze({ operation: "detect_framework", path: rootPath });
    ctx.usage.toolCalls++;
    yield emit("tool_result", { tool: "FrontendAnalyze", operation: "detect_framework", result: { framework: framework.framework, componentCount: framework.componentCount } });
  } catch { /* proceed without */ }

  // ── Phase 1: Swarm or direct? ─────────────────────────────────────

  const spawnDecision = shouldSpawnSubAgents(scopeMap);
  let swarmFindings = [];

  if (spawnDecision.spawn && blackboard) {
    yield emit("progress", { phase: "swarm", message: `Large frontend (${spawnDecision.reason}). Spawning sub-agents...` });

    const swarmResult = await runJulesSwarm({
      scopeMap,
      rootPath,
      blackboard,
      budget: { ...budget, maxCostUsd: budget.maxCostUsd * 0.6 }, // 60% for swarm
      provider,
      parentAbort: abortController,
      onEvent,
    });

    swarmFindings = swarmResult.agentResults.flatMap(r => r.findings);
    ctx.usage.costUsd += swarmResult.usage.totalCostUsd;
    ctx.usage.toolCalls += swarmResult.usage.totalToolCalls;

    yield emit("swarm_complete", {
      totalFindings: swarmFindings.length,
      totalAgents: swarmResult.usage.totalAgents,
      totalCostUsd: swarmResult.usage.totalCostUsd,
    });
  }

  // ── Phase 2: Jules primary deep analysis (agentic LLM loop) ──────

  yield emit("progress", { phase: "deep_analysis", message: "Starting deep analysis..." });

  // Build context for LLM — BLIND-FIRST: no Omar baseline or swarm findings
  // in the initial context. Only codebase metadata and memory recall (past runs,
  // not current-run findings). Swarm/baseline reconciliation happens AFTER the
  // independent deep analysis completes.
  const contextParts = [];
  contextParts.push(`Framework: ${framework.framework || "unknown"}`);
  contextParts.push(`Mode: ${mode}`);
  contextParts.push(`Components: ${framework.componentCount || "unknown"}`);
  contextParts.push(`Scope: ${(scopeMap.primary || []).length} primary files`);

  if (memory) {
    try {
      const recalled = memory.query ? memory.query({
        files: (scopeMap.primary || []).map(f => f.path || f),
        limit: 10,
      }) : [];
      if (recalled.length > 0) {
        contextParts.push(`\nPrevious findings recalled from memory (${recalled.length}):`);
        for (const r of recalled) {
          contextParts.push(`- ${r.content || r.text || JSON.stringify(r).slice(0, 100)}`);
        }
      }
    } catch { /* memory recall failure is non-blocking */ }
  }

  const messages = [
    { role: "user", content: contextParts.join("\n") +
      "\n\nPerform your deep analysis now. Use FileRead, Grep, Glob, and FrontendAnalyze tools as needed. " +
      "Return your findings in a ```json code block as an array of { severity, file, line, title, evidence, rootCause, recommendedFix, trafficLight, reproduction, user_impact, confidence }." },
  ];

  const allFindings = [...swarmFindings];
  let turnCount = 0;

  while (turnCount < maxTurns) {
    if (abortController?.signal.aborted) {
      yield emit("agent_abort", { reason: "user_cancelled" });
      break;
    }

    // Budget check before LLM call
    const preCheck = evaluateBudget({
      sessionSummary: {
        costUsd: ctx.usage.costUsd,
        outputTokens: ctx.usage.outputTokens,
        durationMs: Date.now() - startedAt,
        toolCalls: ctx.usage.toolCalls,
      },
      ...budget,
    });

    if (preCheck.blocking) {
      yield emit("budget_stop", { reasons: preCheck.reasons });
      break;
    }

    if (preCheck.warnings.length > 0) {
      yield emit("budget_warning", { warnings: preCheck.warnings });
    }

    turnCount++;

    // Heartbeat
    if (turnCount % HEARTBEAT_INTERVAL_TURNS === 0) {
      yield emit("heartbeat", {
        turnsCompleted: turnCount,
        turnsMax: maxTurns,
        findingsSoFar: allFindings.length,
        budgetRemaining: {
          costUsd: Math.max(0, budget.maxCostUsd - ctx.usage.costUsd),
          pct: Math.max(0, 100 - (ctx.usage.costUsd / budget.maxCostUsd * 100)),
        },
      });
    }

    // Call LLM — format system prompt + messages into a single prompt
    // for the MultiProviderApiClient which uses a completions-style API
    let response;
    try {
      response = await client.invoke({
        prompt: formatPromptForClient(systemPrompt, messages),
      });
    } catch (err) {
      yield emit("llm_error", { error: err.message, turn: turnCount });
      break;
    }

    const responseText = response.text || "";
    ctx.usage.outputTokens += Math.ceil(responseText.length / 4);
    ctx.usage.costUsd += (Math.ceil(responseText.length / 4) / 1_000_000) * 15;

    yield emit("reasoning", {
      phase: "deep_analysis",
      turn: turnCount,
      summary: responseText.slice(0, 200),
    });

    // Parse tool_use blocks
    const toolCalls = parseToolUseBlocks(responseText);

    if (toolCalls.length === 0) {
      // No tools — extract findings from response
      const parsed = extractJsonFindings(responseText);
      for (const finding of parsed) {
        allFindings.push(finding);
        yield emit("finding", { ...finding });
        if (blackboard) {
          try {
            await blackboard.appendEntry({
              agentId: JULES_DEFINITION.id,
              source: "jules-primary",
              ...finding,
            });
          } catch { /* blackboard write failure non-blocking */ }
        }
      }
      messages.push({ role: "assistant", content: responseText });
      break; // LLM is done
    }

    // Execute tool calls
    const results = [];
    for (const call of toolCalls) {
      try {
        const result = await dispatchTool(call.tool, call.input, ctx);
        results.push({ tool: call.tool, result });
        yield emit("tool_call", { tool: call.tool, input: sanitizeForEvent(call.input) });
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          yield emit("budget_stop", { reason: err.message });
          break;
        }
        results.push({ tool: call.tool, error: err.message });
      }
    }

    // Feed results back
    messages.push({ role: "assistant", content: responseText });
    messages.push({
      role: "user",
      content: results.map(r =>
        r.error
          ? `Tool ${r.tool} failed: ${r.error}`
          : `Tool ${r.tool} result:\n${JSON.stringify(r.result).slice(0, 3000)}`,
      ).join("\n\n") + "\n\nContinue your analysis. If done, return findings in a ```json code block.",
    });
  }

  // ── Phase 2b: Reconciliation (post-blind-pass) ─────────────────────
  // Now that the independent analysis is complete, cross-reference with
  // swarm findings and Omar baseline. This preserves blind-first: the
  // persona formed its own opinion before seeing prior conclusions.

  const hasSwarmContext = swarmFindings.length > 0;
  const baselineFindings = omarBaseline
    ? (omarBaseline.findings || omarBaseline.summary || [])
    : [];
  const hasBaselineContext = Array.isArray(baselineFindings) && baselineFindings.length > 0;

  if (hasSwarmContext || hasBaselineContext) {
    yield emit("progress", { phase: "reconciliation", message: "Cross-referencing with sub-agent and baseline findings..." });

    const reconcileParts = [];
    reconcileParts.push("Your independent analysis is complete. Now cross-reference with the following prior findings.");
    reconcileParts.push("For each prior finding: confirm if your analysis agrees, dispute with evidence if you disagree, or flag as missed if you did not cover it.");

    if (hasSwarmContext) {
      reconcileParts.push(`\nYour sub-agents found ${swarmFindings.length} findings:`);
      for (const f of swarmFindings.slice(0, 30)) {
        reconcileParts.push(`- [${f.severity || "P3"}] ${f.file || ""}:${f.line || ""} ${f.title || f.type || ""}`);
      }
    }

    if (hasBaselineContext) {
      reconcileParts.push(`\nOmar baseline reported ${baselineFindings.length} findings:`);
      for (const f of baselineFindings.slice(0, 20)) {
        reconcileParts.push(`- [${f.severity || ""}] ${f.file || ""}:${f.line || ""} ${f.message || f.title || ""}`);
      }
    }

    reconcileParts.push("\nReturn any additional or revised findings as a JSON array in a ```json code block. If no changes, return an empty array [].");

    messages.push({ role: "user", content: reconcileParts.join("\n") });

    // Budget check before reconciliation turn
    const reconcilePreCheck = evaluateBudget({
      sessionSummary: {
        costUsd: ctx.usage.costUsd,
        outputTokens: ctx.usage.outputTokens,
        durationMs: Date.now() - startedAt,
        toolCalls: ctx.usage.toolCalls,
      },
      ...budget,
    });

    if (!reconcilePreCheck.blocking) {
      try {
        const reconcileResponse = await client.invoke({
          prompt: formatPromptForClient(systemPrompt, messages),
        });

        const reconcileText = reconcileResponse.text || "";
        ctx.usage.outputTokens += Math.ceil(reconcileText.length / 4);
        ctx.usage.costUsd += (Math.ceil(reconcileText.length / 4) / 1_000_000) * 15;

        yield emit("reasoning", { phase: "reconciliation", summary: reconcileText.slice(0, 200) });

        const reconcileFindings = extractJsonFindings(reconcileText);
        for (const finding of reconcileFindings) {
          allFindings.push(finding);
          yield emit("finding", { ...finding, source: "reconciliation" });
          if (blackboard) {
            try {
              await blackboard.appendEntry({
                agentId: JULES_DEFINITION.id,
                source: "jules-reconciliation",
                ...finding,
              });
            } catch { /* blackboard write failure non-blocking */ }
          }
        }

        messages.push({ role: "assistant", content: reconcileText });
      } catch (err) {
        yield emit("llm_error", { error: err.message, phase: "reconciliation" });
      }
    } else {
      yield emit("budget_stop", { reasons: reconcilePreCheck.reasons, phase: "reconciliation" });
    }
  }

  // ── Phase 3: Build final report ───────────────────────────────────

  const durationMs = Date.now() - startedAt;
  const severityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of allFindings) {
    const sev = (f.severity || "P3").toUpperCase();
    if (severityCounts[sev] !== undefined) severityCounts[sev]++;
    else severityCounts.P3++;
  }

  const report = {
    runId,
    persona: JULES_DEFINITION.persona,
    mode,
    framework: framework.framework || "unknown",
    status: "completed",
    findings: allFindings,
    summary: {
      total: allFindings.length,
      ...severityCounts,
      blocking: severityCounts.P0 > 0 || severityCounts.P1 > 0,
    },
    usage: {
      turns: turnCount,
      costUsd: ctx.usage.costUsd,
      outputTokens: ctx.usage.outputTokens,
      toolCalls: ctx.usage.toolCalls,
      durationMs,
    },
    signature: JULES_DEFINITION.signature,
  };

  yield emit("agent_complete", {
    ...report.summary,
    costUsd: ctx.usage.costUsd,
    durationMs,
    turns: turnCount,
  });

  return report;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseToolUseBlocks(text) {
  const calls = [];
  const regex = /```tool_use\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool && parsed.input) calls.push(parsed);
    } catch { /* skip malformed */ }
  }
  return calls;
}

function extractJsonFindings(text) {
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)```/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    if (Array.isArray(parsed)) return parsed;
    if (parsed.findings && Array.isArray(parsed.findings)) return parsed.findings;
  } catch { /* skip malformed */ }
  return [];
}

function sanitizeForEvent(input) {
  const sanitized = { ...input };
  if (typeof sanitized.content === "string" && sanitized.content.length > 200) {
    sanitized.content = `[${sanitized.content.length} chars]`;
  }
  return sanitized;
}

/**
 * Format system prompt + chat messages into a single prompt string
 * for MultiProviderApiClient which uses a completions-style API.
 */
function formatPromptForClient(systemPrompt, messages) {
  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "ASSISTANT" : "USER";
    parts.push(`\n${role}:\n${msg.content}`);
  }
  return parts.join("\n");
}
