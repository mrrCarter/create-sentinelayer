/**
 * Multi-turn agent loop (#A8 — the core of the envelope).
 *
 * Runs a plan → tool-calls → observe → continue/stop cycle with a hard
 * maxTurns guard, stuck detection via pulse.detectStuck, and per-turn
 * budget checks supplied by the caller.
 *
 * The loop is LLM-client-agnostic: callers pass a `client` that implements
 * `async client.generatePlan(messages, options) -> plan`.
 *
 * A plan has shape:
 *   {
 *     stopReason:   "end-turn" | "tool-use" | null,
 *     content:      string,   // may include reasoning / narration
 *     toolCalls:    [{ name, input }],
 *     findings:     [...],    // optional per-turn findings
 *   }
 */

import { detectStuck } from "./pulse.js";

export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_STUCK_THRESHOLD = 2;

/**
 * @param {object} params
 * @param {object} params.client
 * @param {Array}  params.initialMessages
 * @param {Array}  params.tools            - list of { name, invoke(input) => Promise }
 * @param {object} [params.options]
 * @param {number} [params.options.maxTurns]
 * @param {number} [params.options.stuckThreshold]
 * @param {Function} [params.options.shouldAllowCall] - gate invoked before each LLM call
 * @param {Function} [params.options.onTurn]          - callback per turn
 */
export async function runEnvelopeLoop({
  client,
  initialMessages = [],
  tools = [],
  options = {},
} = {}) {
  if (!client || typeof client.generatePlan !== "function") {
    throw new TypeError("runEnvelopeLoop requires a client with generatePlan()");
  }

  const maxTurns = Number.isInteger(options.maxTurns) ? options.maxTurns : DEFAULT_MAX_TURNS;
  const stuckThreshold = Number.isInteger(options.stuckThreshold)
    ? options.stuckThreshold
    : DEFAULT_STUCK_THRESHOLD;
  const shouldAllowCall = typeof options.shouldAllowCall === "function"
    ? options.shouldAllowCall
    : () => ({ allow: true });
  const onTurn = typeof options.onTurn === "function" ? options.onTurn : null;

  const messages = [...initialMessages];
  const findings = [];
  const toolInvocations = [];
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const turnStates = [];

  let turnsUsed = 0;
  let stuckReason = null;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const budgetDecision = shouldAllowCall({ turn, messages });
    if (budgetDecision && budgetDecision.allow === false) {
      stuckReason = "budget-exceeded";
      break;
    }

    let plan;
    try {
      plan = await client.generatePlan(messages, { turn, tools: tools.map((t) => t.name) });
    } catch (err) {
      messages.push({ role: "error", content: String(err) });
      stuckReason = "client-error";
      turnsUsed = turn;
      break;
    }

    const toolCalls = Array.isArray(plan?.toolCalls) ? plan.toolCalls : [];
    messages.push({ role: "assistant", content: plan?.content ?? "", toolCalls });
    if (Array.isArray(plan?.findings)) {
      findings.push(...plan.findings);
    }

    if (onTurn) {
      try {
        onTurn({ turn, plan });
      } catch {
        // onTurn is advisory; never let observer errors break the loop
      }
    }

    turnsUsed = turn;
    turnStates.push({ turn, hadToolCalls: toolCalls.length > 0 });

    if (detectStuck(turnStates, stuckThreshold)) {
      stuckReason = "no-tool-calls";
      break;
    }

    if (plan?.stopReason === "end-turn") {
      break;
    }

    // Execute tools.
    for (const call of toolCalls) {
      const tool = toolByName.get(call.name);
      if (!tool) {
        messages.push({
          role: "tool-result",
          toolName: call.name,
          error: `Unknown tool: ${call.name}`,
        });
        toolInvocations.push({ turn, tool: call.name, input: call.input, error: "unknown-tool" });
        continue;
      }
      try {
        const output = await tool.invoke(call.input);
        messages.push({
          role: "tool-result",
          toolName: call.name,
          output,
        });
        toolInvocations.push({ turn, tool: call.name, input: call.input, output });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        messages.push({
          role: "tool-result",
          toolName: call.name,
          error: errorMessage,
        });
        toolInvocations.push({ turn, tool: call.name, input: call.input, error: errorMessage });
      }
    }
  }

  if (!stuckReason && turnsUsed >= maxTurns) {
    stuckReason = "max-turns";
  }

  return {
    messages,
    findings,
    stuckReason,
    turnsUsed,
    toolInvocations,
  };
}
