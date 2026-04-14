import { randomUUID } from "node:crypto";
import { createAgentContext, dispatchTool, isReadOnlyTool, BudgetExhaustedError } from "../tools/dispatch.js";
import { createMultiProviderApiClient } from "../../../ai/client.js";

/**
 * JulesSubAgent — lightweight isolated agent for parallel audit work.
 *
 * Each sub-agent gets:
 * - Own conversation context (no parent history)
 * - Own tool access (subset of Jules' tools)
 * - Own budget slice (clamped to parent allocation)
 * - Shared blackboard (append-only)
 * - Own telemetry session
 * - AbortController linked to parent (kill propagation)
 *
 * Sub-agents are NOT full Jules instances. They are focused workers:
 * - FileScanner: reads file batches, extracts structured summaries
 * - PatternHunter: searches for specific issue classes
 */

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TEMPERATURE = 0;

export class JulesSubAgent {
  /**
   * @param {object} config
   * @param {string} config.id - Unique identifier (e.g., "file-scanner-dashboard")
   * @param {string} config.role - "FileScanner" | "PatternHunter" | "custom"
   * @param {string} config.systemPrompt - System instruction for this sub-agent
   * @param {string[]} config.allowedTools - Tool names this agent can use
   * @param {object} config.scope - { files: string[], patterns: string[] }
   * @param {object} config.budget - Budget slice { maxCostUsd, maxOutputTokens, maxRuntimeMs, maxToolCalls }
   * @param {object} config.blackboard - Shared blackboard instance (appendEntry, query)
   * @param {object} [config.provider] - { provider, model, apiKey } overrides
   * @param {number} [config.maxTurns] - Max agentic loop iterations
   * @param {AbortController} [config.parentAbort] - Linked to parent for kill propagation
   * @param {function} [config.onEvent] - Streaming event callback
   */
  constructor(config) {
    this.id = config.id || `subagent-${randomUUID().slice(0, 8)}`;
    this.role = config.role;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = new Set(config.allowedTools || ["FileRead", "Grep", "Glob", "FrontendAnalyze"]);
    this.scope = config.scope || {};
    this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    this.blackboard = config.blackboard;
    this.onEvent = config.onEvent;

    // Isolated context
    this.conversation = [];
    this.findings = [];
    this.turnCount = 0;

    // Budget-gated agent context
    this.ctx = createAgentContext({
      agentIdentity: {
        id: this.id,
        persona: `Jules Sub-Agent (${this.role})`,
        parentId: "frontend",
      },
      budget: config.budget || {
        maxCostUsd: 1.0,
        maxOutputTokens: 4000,
        maxRuntimeMs: 120000,
        maxToolCalls: 50,
      },
      sessionId: randomUUID(),
      runId: `sub-${this.id}-${Date.now()}`,
      onEvent: config.onEvent,
    });

    // LLM client
    this.client = createMultiProviderApiClient(config.provider || {});

    // Abort linkage
    this.abortController = new AbortController();
    if (config.parentAbort) {
      config.parentAbort.signal.addEventListener("abort", () => {
        this.abortController.abort();
      }, { once: true });
    }
  }

  /**
   * Execute the sub-agent's task.
   * Runs an agentic loop: LLM → tool_use → execute → feed back → repeat.
   * Returns structured results.
   */
  async execute() {
    this.emitEvent("agent_start", { role: this.role, scope: this.scope });

    // Build initial messages
    const messages = [
      { role: "user", content: this.buildTaskPrompt() },
    ];

    try {
      while (this.turnCount < this.maxTurns) {
        if (this.abortController.signal.aborted) {
          this.emitEvent("agent_abort", { reason: "parent_killed" });
          break;
        }

        this.turnCount++;

        // Call LLM
        const response = await this.client.invoke({
          systemPrompt: this.systemPrompt,
          messages,
          temperature: DEFAULT_TEMPERATURE,
        });

        // Track cost
        this.ctx.usage.outputTokens += estimateTokens(response.text);
        this.ctx.usage.costUsd += estimateCost(response.text);

        // Parse tool_use blocks from response
        const toolCalls = parseToolCalls(response.text);

        if (toolCalls.length === 0) {
          // No more tool calls — sub-agent is done
          const structured = parseStructuredOutput(response.text);
          if (structured.findings) {
            for (const finding of structured.findings) {
              this.findings.push(finding);
              if (this.blackboard) {
                await this.blackboard.appendEntry({
                  agentId: this.id,
                  source: this.role,
                  ...finding,
                });
              }
            }
          }
          messages.push({ role: "assistant", content: response.text });
          break;
        }

        // Execute tool calls
        const toolResults = [];
        for (const call of toolCalls) {
          if (!this.allowedTools.has(call.tool)) {
            toolResults.push({ tool: call.tool, error: `Tool ${call.tool} not allowed for this sub-agent` });
            continue;
          }
          try {
            const result = await dispatchTool(call.tool, call.input, this.ctx);
            toolResults.push({ tool: call.tool, result });
          } catch (err) {
            if (err instanceof BudgetExhaustedError) {
              this.emitEvent("budget_stop", { reason: err.message });
              return this.buildResult("budget_exhausted");
            }
            toolResults.push({ tool: call.tool, error: err.message });
          }
        }

        // Feed results back to conversation
        messages.push({ role: "assistant", content: response.text });
        messages.push({
          role: "user",
          content: formatToolResults(toolResults),
        });
      }
    } catch (err) {
      this.emitEvent("agent_error", { error: err.message });
      return this.buildResult("error", err.message);
    }

    this.emitEvent("agent_complete", {
      findings: this.findings.length,
      turns: this.turnCount,
      toolCalls: this.ctx.usage.toolCalls,
    });

    return this.buildResult("completed");
  }

  buildTaskPrompt() {
    const parts = [];
    if (this.scope.files && this.scope.files.length > 0) {
      parts.push(`Files in your scope:\n${this.scope.files.join("\n")}`);
    }
    if (this.scope.patterns && this.scope.patterns.length > 0) {
      parts.push(`Patterns to search for:\n${this.scope.patterns.join("\n")}`);
    }
    parts.push("Return your findings as a JSON array in a ```json code block.");
    return parts.join("\n\n");
  }

  buildResult(status, error) {
    return {
      agentId: this.id,
      role: this.role,
      status,
      error: error || null,
      findings: this.findings,
      usage: {
        turns: this.turnCount,
        toolCalls: this.ctx.usage.toolCalls,
        costUsd: this.ctx.usage.costUsd,
        outputTokens: this.ctx.usage.outputTokens,
        durationMs: Date.now() - this.ctx.startedAt,
        filesRead: [...(this.ctx.usage.filesRead || [])],
      },
    };
  }

  emitEvent(event, payload) {
    if (this.onEvent) {
      this.onEvent({
        stream: "sl_event",
        event,
        agent: { id: this.id, persona: `Jules Sub-Agent (${this.role})`, parentId: "frontend" },
        payload,
        usage: {
          costUsd: this.ctx.usage.costUsd,
          toolCalls: this.ctx.usage.toolCalls,
          durationMs: Date.now() - this.ctx.startedAt,
        },
      });
    }
  }
}

/**
 * Run a batch of sub-agents with concurrency control.
 */
export async function runSubAgentBatch(agents, { maxConcurrent = 4 } = {}) {
  const results = [];
  const queue = [...agents];

  async function runNext() {
    while (queue.length > 0) {
      const agent = queue.shift();
      const result = await agent.execute();
      results.push(result);
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrent, agents.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseToolCalls(text) {
  // Parse tool_use blocks from LLM response
  // Format: ```tool_use\n{"tool":"FileRead","input":{...}}\n```
  const calls = [];
  const regex = /```tool_use\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool && parsed.input) {
        calls.push(parsed);
      }
    } catch { /* skip malformed */ }
  }
  return calls;
}

function parseStructuredOutput(text) {
  // Parse JSON findings from LLM response
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (Array.isArray(parsed)) {
        return { findings: parsed };
      }
      if (parsed.findings && Array.isArray(parsed.findings)) {
        return parsed;
      }
    } catch { /* skip malformed */ }
  }
  return { findings: [] };
}

function formatToolResults(results) {
  return results.map(r => {
    if (r.error) return `Tool ${r.tool} failed: ${r.error}`;
    const summary = typeof r.result === "string" ? r.result :
      JSON.stringify(r.result).slice(0, 2000);
    return `Tool ${r.tool} result:\n${summary}`;
  }).join("\n\n");
}

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function estimateCost(text) {
  // Rough: $15/M output tokens for Claude Sonnet
  const tokens = estimateTokens(text);
  return (tokens / 1_000_000) * 15;
}

export class SubAgentError extends Error {
  constructor(message) {
    super(message);
    this.name = "SubAgentError";
  }
}
