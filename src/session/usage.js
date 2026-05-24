/**
 * Session usage emitter — records every LLM interaction inside a session
 * as a `session_usage` event so consumers (web dashboard, transcript
 * download, telemetry sync) can surface live, accurate token + cost
 * counters per-agent + session-wide.
 *
 * Senti orchestrator philosophy: "tokens on point every time any LLM
 * interacts." Every persona / Jules / Codex / Claude call inside a
 * session should land here so the running tally is authoritative.
 *
 * Event shape:
 *
 *   {
 *     event: "session_usage",
 *     ts: ISO8601,
 *     agent: { id, model },
 *     payload: {
 *       interactionId,           // stable id for the LLM call
 *       agentId, model, role,
 *       inputTokens, outputTokens, totalTokens,
 *       costUsd,
 *       durationMs,              // wall-clock duration of the call
 *       prompt: { tokens, chars },
 *       response: { tokens, chars, text? },
 *       usage: {                 // mirrors transcript.js payload.usage
 *         totalTokens,
 *         costUsd,
 *         inputTokens,
 *         outputTokens,
 *       },
 *     }
 *   }
 *
 * Design choice: emit BOTH the convenient flat fields AND a
 * `payload.usage` block, so transcript.js's existing usage roll-up
 * picks it up without changes, while web UIs can display the structured
 * fields directly without re-parsing.
 */

import process from "node:process";
import { randomUUID } from "node:crypto";

import { createAgentEvent } from "../events/schema.js";
import { estimateModelCost } from "../cost/tracker.js";
import {
  DEFAULT_PRICE_BOOK_VERSION,
  buildSessionUsageLedger,
  createSessionUsageLedgerId,
} from "./pricing-ledger.js";
import { resolveSessionPaths } from "./paths.js";
import { appendToStream } from "./stream.js";

const SESSION_USAGE_EVENT = "session_usage";

function n(value) {
  return String(value == null ? "" : value).trim();
}

function num(value) {
  const v = Number(value);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function money(value) {
  return Math.round(num(value) * 1_000_000) / 1_000_000;
}

function clipText(text, max = 4000) {
  const s = n(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function computedCost({ model, inputTokens, outputTokens }) {
  try {
    return {
      costUsd: estimateModelCost({ modelId: model, inputTokens, outputTokens }),
      unpriced: false,
    };
  } catch {
    return { costUsd: 0, unpriced: inputTokens + outputTokens > 0 };
  }
}

/**
 * Emit a `session_usage` event into the session's NDJSON stream.
 *
 * @param {string} sessionId
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} [params.agentModel]
 * @param {string} [params.role]
 * @param {number} [params.inputTokens]
 * @param {number} [params.outputTokens]
 * @param {number} [params.costUsd]
 * @param {number} [params.customerCostUsd]
 * @param {number} [params.durationMs]
 * @param {string} [params.action]
 * @param {string} [params.provider]
 * @param {string} [params.billingTier]
 * @param {string} [params.priceBookVersion]
 * @param {string} [params.prompt]            full prompt text (clipped)
 * @param {string} [params.response]          full response text (clipped)
 * @param {string} [params.interactionId]     opaque id for cross-event correlation
 * @param {string} [params.targetPath]        workspace path (default cwd)
 * @returns {Promise<{ event: string, interactionId: string, totalTokens: number, costUsd: number }>}
 */
export async function emitLLMInteraction(
  sessionId,
  {
    agentId,
    agentModel = "",
    role = "",
    inputTokens = 0,
    outputTokens = 0,
    costUsd = undefined,
    customerCostUsd = undefined,
    durationMs = 0,
    action = "agent_message",
    provider = "",
    billingTier = "unknown",
    priceBookVersion = DEFAULT_PRICE_BOOK_VERSION,
    prompt = "",
    response = "",
    interactionId = "",
    targetPath = process.cwd(),
  } = {},
) {
  const sid = n(sessionId);
  if (!sid) throw new Error("sessionId is required.");
  const aid = n(agentId);
  if (!aid) throw new Error("agentId is required.");

  const paths = resolveSessionPaths(sid, { targetPath });
  const ts = new Date().toISOString();
  const id = n(interactionId) || randomUUID();
  const inT = Math.floor(num(inputTokens));
  const outT = Math.floor(num(outputTokens));
  const totalT = inT + outT;
  const model = n(agentModel) || "unknown";
  const providedCost = costUsd != null && costUsd !== "";
  const estimate = providedCost
    ? { costUsd: num(costUsd), unpriced: false }
    : computedCost({ model, inputTokens: inT, outputTokens: outT });
  const cost = money(estimate.costUsd);
  const customerCost = customerCostUsd == null || customerCostUsd === "" ? null : money(customerCostUsd);
  const actionName = n(action) || "agent_message";
  const tier = n(billingTier) || "unknown";
  const priceBook = n(priceBookVersion) || DEFAULT_PRICE_BOOK_VERSION;
  const ledgerEntryId = createSessionUsageLedgerId({
    sessionId: paths.sessionId,
    agentId: aid,
    action: actionName,
    idempotencyKey: id,
  });

  const promptText = clipText(prompt);
  const responseText = clipText(response);

  const payload = {
    interactionId: id,
    idempotencyKey: id,
    ledgerEntryId,
    agentId: aid,
    model,
    role: n(role) || "observer",
    action: actionName,
    provider: n(provider) || undefined,
    billingTier: tier,
    priceBookVersion: priceBook,
    inputTokens: inT,
    outputTokens: outT,
    totalTokens: totalT,
    costUsd: cost,
    providerCostUsd: cost,
    customerCostUsd: customerCost ?? undefined,
    unpriced: estimate.unpriced,
    durationMs: Math.max(0, Math.floor(num(durationMs))),
    prompt: { tokens: inT, chars: promptText.length },
    response: {
      tokens: outT,
      chars: responseText.length,
      text: responseText || undefined,
    },
    // Mirror into payload.usage so transcript.js + telemetry sync pick
    // it up via the same code path used for ad-hoc agent_response usage.
    usage: {
      totalTokens: totalT,
      costUsd: cost,
      providerCostUsd: cost,
      customerCostUsd: customerCost ?? undefined,
      inputTokens: inT,
      outputTokens: outT,
      action: actionName,
      provider: n(provider) || undefined,
      billingTier: tier,
      priceBookVersion: priceBook,
      ledgerEntryId,
      idempotencyKey: id,
      unpriced: estimate.unpriced,
    },
  };

  const envelope = createAgentEvent({
    event: SESSION_USAGE_EVENT,
    agentId: aid,
    agentModel: model,
    sessionId: paths.sessionId,
    payload,
    ts,
  });

  await appendToStream(paths.sessionId, envelope, { targetPath });
  return {
    event: SESSION_USAGE_EVENT,
    interactionId: id,
    ledgerEntryId,
    totalTokens: totalT,
    costUsd: cost,
  };
}

/**
 * Aggregate `session_usage` events into a per-agent + global tally.
 * Pure helper for renderers that want a snapshot at a point in time.
 *
 * @param {Array<object>} events
 * @returns {{
 *   perAgent: Map<string, { agentId, model, totalTokens, inputTokens, outputTokens, costUsd, interactions }>,
 *   totals: { totalTokens, inputTokens, outputTokens, costUsd, interactions },
 * }}
 */
export function aggregateSessionUsage(events = []) {
  const ledger = buildSessionUsageLedger(events);
  const perAgent = new Map();
  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    interactions: 0,
  };
  for (const entry of ledger.entries) {
    const { agentId, model, inputTokens, outputTokens, totalTokens, providerCostUsd } = entry;
    if (!perAgent.has(agentId)) {
      perAgent.set(agentId, {
        agentId,
        model,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        interactions: 0,
      });
    }
    const record = perAgent.get(agentId);
    if (record.model === "unknown" && model !== "unknown") {
      record.model = model;
    }
    record.totalTokens += totalTokens;
    record.inputTokens += inputTokens;
    record.outputTokens += outputTokens;
    record.costUsd += providerCostUsd;
    record.interactions += 1;

    totals.totalTokens += totalTokens;
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.costUsd += providerCostUsd;
    totals.interactions += 1;
  }
  totals.costUsd = Math.round(totals.costUsd * 1_000_000) / 1_000_000;
  for (const record of perAgent.values()) {
    record.costUsd = Math.round(record.costUsd * 1_000_000) / 1_000_000;
  }
  return { perAgent, totals };
}

export const SESSION_USAGE_EVENT_KIND = SESSION_USAGE_EVENT;
