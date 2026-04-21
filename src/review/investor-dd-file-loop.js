/**
 * Per-file agentic review loop for investor-DD.
 *
 * Given a persona config, a list of files in scope, and an LLM-backed client,
 * iterate file-by-file, running a bounded multi-turn tool-using loop per file.
 * Emits structured events for session streaming and accumulates structured
 * findings plus coverage proof (every file visited, how many turns, which
 * tools were invoked).
 *
 * No fix-cycle path — review personas never mutate source. Tools are
 * constrained to the caller-supplied list; the library does not import any
 * edit/write tools.
 *
 * Budget: caller supplies a shared budget accumulator that is decremented
 * on every tool call and LLM call. When the budget trips, the loop stops
 * cleanly at the current file boundary so a partial-report generator can
 * still emit what was finished.
 */

import { runEnvelopeLoop } from "../agents/envelope/index.js";

export const INVESTOR_DD_DEFAULT_MAX_TURNS_PER_FILE = 6;
export const INVESTOR_DD_DEFAULT_STUCK_THRESHOLD = 2;

/**
 * @typedef {object} InvestorDdBudgetState
 * @property {number} spentUsd     - Running USD spend.
 * @property {number} maxUsd       - Hard cap.
 * @property {number} startedAtMs  - Epoch ms when the run began.
 * @property {number} maxRuntimeMs - Hard cap on runtime.
 * @property {number} toolCalls    - Running count of tool invocations.
 * @property {number} llmCalls     - Running count of LLM invocations.
 */

/**
 * @typedef {object} InvestorDdFileLoopEvent
 * @property {string}  type
 * @property {string}  personaId
 * @property {string}  file
 * @property {number}  [turn]
 * @property {string}  [tool]
 * @property {object}  [finding]
 * @property {string}  [stopReason]
 * @property {number}  [turnsUsed]
 */

/**
 * @typedef {object} InvestorDdFileLoopResult
 * @property {string}   personaId
 * @property {Array<{file: string, findings: Array<object>, turnsUsed: number, stopReason: string|null, toolInvocations: Array<object>}>} perFile
 * @property {Array<object>} findings                 - Flat list of all findings.
 * @property {Array<string>} visited                  - Files the loop actually visited.
 * @property {Array<string>} skipped                  - Files skipped because budget was exhausted.
 * @property {"ok"|"budget-cost-exhausted"|"budget-runtime-exhausted"|"client-error"} terminationReason
 */

/**
 * Check whether the shared budget still permits further work. When false,
 * the loop stops at the current file boundary and reports the remaining
 * files as `skipped` so the caller can emit a partial report.
 *
 * @param {InvestorDdBudgetState} budget
 * @returns {{ ok: true } | { ok: false, reason: "budget-cost-exhausted" | "budget-runtime-exhausted" }}
 */
export function checkBudget(budget) {
  if (!budget) return { ok: true };
  if (Number.isFinite(budget.maxUsd) && budget.spentUsd >= budget.maxUsd) {
    return { ok: false, reason: "budget-cost-exhausted" };
  }
  if (Number.isFinite(budget.maxRuntimeMs) && Number.isFinite(budget.startedAtMs)) {
    const elapsed = Date.now() - budget.startedAtMs;
    if (elapsed >= budget.maxRuntimeMs) {
      return { ok: false, reason: "budget-runtime-exhausted" };
    }
  }
  return { ok: true };
}

/**
 * Instantiate a fresh budget state from caller-supplied caps.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxUsd]
 * @param {number} [opts.maxRuntimeMs]
 * @returns {InvestorDdBudgetState}
 */
export function createBudgetState({ maxUsd = Infinity, maxRuntimeMs = Infinity } = {}) {
  return {
    spentUsd: 0,
    maxUsd,
    startedAtMs: Date.now(),
    maxRuntimeMs,
    toolCalls: 0,
    llmCalls: 0,
  };
}

/**
 * Wrap the caller's tool array so every invocation increments the shared
 * budget counters. The wrapping does not alter tool contract; it only
 * observes + accounts.
 *
 * @param {Array<{name: string, invoke: Function, costUsd?: number}>} tools
 * @param {InvestorDdBudgetState} budget
 * @param {Function} onToolCall - (name, input) => void
 */
function meterTools(tools, budget, onToolCall) {
  return tools.map((tool) => ({
    ...tool,
    invoke: async (input) => {
      budget.toolCalls += 1;
      if (Number.isFinite(tool.costUsd)) {
        budget.spentUsd += tool.costUsd;
      }
      try {
        onToolCall(tool.name, input);
      } catch {
        // observer errors never break review
      }
      return tool.invoke(input);
    },
  }));
}

/**
 * Wrap the caller's LLM client so every generatePlan call increments the
 * llmCalls counter. Cost accounting for LLM calls is the client's
 * responsibility (it knows the model and tokens), so the client adds to
 * `budget.spentUsd` directly.
 *
 * @param {object} client
 * @param {InvestorDdBudgetState} budget
 */
function meterClient(client, budget) {
  return {
    ...client,
    generatePlan: async (messages, options) => {
      budget.llmCalls += 1;
      return client.generatePlan(messages, options);
    },
  };
}

/**
 * Run the per-file agentic review loop for a single persona.
 *
 * @param {object} params
 * @param {string} params.personaId
 * @param {Array<string>} params.files                - Files in scope for this persona.
 * @param {object} params.client                      - Must implement generatePlan().
 * @param {(file: string) => Array<{name: string, invoke: Function, costUsd?: number}>} params.buildTools
 *        Factory that returns the tool list scoped to a single file. Called once per file.
 * @param {(file: string) => Array<object>} params.buildInitialMessages
 *        Factory that returns the LLM messages to seed the loop for this file.
 * @param {InvestorDdBudgetState} params.budget       - Shared budget state.
 * @param {(event: InvestorDdFileLoopEvent) => void} [params.onEvent] - Event sink.
 * @param {object} [params.options]
 * @param {number} [params.options.maxTurnsPerFile]
 * @param {number} [params.options.stuckThreshold]
 * @returns {Promise<InvestorDdFileLoopResult>}
 */
export async function runPerFileReviewLoop({
  personaId,
  files,
  client,
  buildTools,
  buildInitialMessages,
  budget,
  onEvent = () => {},
  options = {},
} = {}) {
  if (!personaId || typeof personaId !== "string") {
    throw new TypeError("runPerFileReviewLoop requires a personaId string");
  }
  if (!Array.isArray(files)) {
    throw new TypeError("runPerFileReviewLoop requires a files array");
  }
  if (typeof buildTools !== "function") {
    throw new TypeError("runPerFileReviewLoop requires buildTools(file) factory");
  }
  if (typeof buildInitialMessages !== "function") {
    throw new TypeError("runPerFileReviewLoop requires buildInitialMessages(file) factory");
  }
  if (!client || typeof client.generatePlan !== "function") {
    throw new TypeError("runPerFileReviewLoop requires a client with generatePlan()");
  }

  const maxTurns = Number.isInteger(options.maxTurnsPerFile)
    ? options.maxTurnsPerFile
    : INVESTOR_DD_DEFAULT_MAX_TURNS_PER_FILE;
  const stuckThreshold = Number.isInteger(options.stuckThreshold)
    ? options.stuckThreshold
    : INVESTOR_DD_DEFAULT_STUCK_THRESHOLD;

  const safeBudget = budget || createBudgetState();
  const meteredClient = meterClient(client, safeBudget);

  const perFile = [];
  const allFindings = [];
  const visited = [];
  const skipped = [];
  let terminationReason = "ok";

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // sinks never break review
    }
  };

  for (const file of files) {
    const budgetCheck = checkBudget(safeBudget);
    if (!budgetCheck.ok) {
      terminationReason = budgetCheck.reason;
      skipped.push(file);
      emit({ type: "persona_file_skipped", personaId, file, stopReason: budgetCheck.reason });
      continue;
    }

    emit({ type: "persona_file_start", personaId, file });

    const fileTools = buildTools(file);
    const meteredTools = meterTools(fileTools, safeBudget, (tool, input) => {
      emit({ type: "persona_file_tool_call", personaId, file, tool, input });
    });
    const initialMessages = buildInitialMessages(file);

    let loopResult;
    try {
      loopResult = await runEnvelopeLoop({
        client: meteredClient,
        initialMessages,
        tools: meteredTools,
        options: {
          maxTurns,
          stuckThreshold,
          shouldAllowCall: () => {
            const check = checkBudget(safeBudget);
            return { allow: check.ok };
          },
          onTurn: ({ turn, plan }) => {
            emit({
              type: "persona_file_turn",
              personaId,
              file,
              turn,
              stopReason: plan?.stopReason ?? null,
            });
            const findings = Array.isArray(plan?.findings) ? plan.findings : [];
            for (const f of findings) {
              const decorated = { ...f, personaId, file };
              allFindings.push(decorated);
              emit({ type: "persona_finding", personaId, file, finding: decorated });
            }
          },
        },
      });
    } catch (err) {
      terminationReason = "client-error";
      emit({
        type: "persona_file_error",
        personaId,
        file,
        stopReason: err instanceof Error ? err.message : String(err),
      });
      perFile.push({
        file,
        findings: [],
        turnsUsed: 0,
        stopReason: "client-error",
        toolInvocations: [],
      });
      continue;
    }

    visited.push(file);
    perFile.push({
      file,
      findings: Array.isArray(loopResult.findings) ? loopResult.findings : [],
      turnsUsed: loopResult.turnsUsed ?? 0,
      stopReason: loopResult.stuckReason ?? null,
      toolInvocations: Array.isArray(loopResult.toolInvocations) ? loopResult.toolInvocations : [],
    });

    emit({
      type: "persona_file_complete",
      personaId,
      file,
      turnsUsed: loopResult.turnsUsed ?? 0,
      stopReason: loopResult.stuckReason ?? null,
    });
  }

  return {
    personaId,
    perFile,
    findings: allFindings,
    visited,
    skipped,
    terminationReason,
  };
}
