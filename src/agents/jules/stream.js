import { PERSONA_VISUALS, resolvePersonaVisual } from "./config/definition.js";

/**
 * Jules Tanaka — Streaming Event Formatter
 *
 * Formats NDJSON events for external agent consumption and terminal display.
 * Universal envelope: every event carries agent identity, usage snapshot, timestamp.
 */

const SCHEMA_VERSION = 1;

/**
 * Build an NDJSON event envelope.
 *
 * @param {string} event - Event type (agent_start, tool_call, finding, heartbeat, etc.)
 * @param {object} agentIdentity - { id, persona, color?, avatar? }
 * @param {object} payload - Event-specific data
 * @param {object} [usage] - Running usage totals
 * @param {string} [runId] - Run identifier
 * @returns {object} Complete event envelope
 */
export function buildStreamEvent(event, agentIdentity, payload, usage, runId) {
  const visual = resolvePersonaVisual(agentIdentity?.id) || {};
  return {
    stream: "sl_event",
    version: SCHEMA_VERSION,
    command: "audit.deep",
    runId: runId || null,
    timestamp: new Date().toISOString(),
    agent: {
      id: agentIdentity?.id || "unknown",
      persona: agentIdentity?.persona || visual.fullName || "unknown",
      color: agentIdentity?.color || visual.color || "white",
      avatar: agentIdentity?.avatar || visual.avatar || "",
    },
    event,
    payload: payload || {},
    usage: usage || {},
  };
}

/**
 * Create a streaming emitter bound to a specific agent and run.
 *
 * @param {object} config
 * @param {object} config.agentIdentity - { id, persona }
 * @param {string} config.runId
 * @param {function} [config.onEvent] - Callback for each event
 * @param {boolean} [config.stdoutNdjson] - Also write to stdout as NDJSON
 * @returns {{ emit(event, payload, usage), close() }}
 */
export function createStreamEmitter({ agentIdentity, runId, onEvent, stdoutNdjson = false }) {
  let closed = false;
  const usageRef = { costUsd: 0, outputTokens: 0, toolCalls: 0, durationMs: 0 };

  return {
    /**
     * Emit a streaming event.
     */
    emit(event, payload, usage) {
      if (closed) return;
      const merged = { ...usageRef, ...usage };
      Object.assign(usageRef, merged);
      const evt = buildStreamEvent(event, agentIdentity, payload, merged, runId);
      if (onEvent) onEvent(evt);
      if (stdoutNdjson) console.log(JSON.stringify(evt));
      return evt;
    },

    /**
     * Update accumulated usage without emitting.
     */
    updateUsage(delta) {
      if (delta.costUsd !== undefined) usageRef.costUsd = delta.costUsd;
      if (delta.outputTokens !== undefined) usageRef.outputTokens = delta.outputTokens;
      if (delta.toolCalls !== undefined) usageRef.toolCalls = delta.toolCalls;
      if (delta.durationMs !== undefined) usageRef.durationMs = delta.durationMs;
    },

    /**
     * Mark emitter as closed (no more events).
     */
    close() {
      closed = true;
    },

    /**
     * Get current usage snapshot.
     */
    getUsage() {
      return { ...usageRef };
    },
  };
}

/**
 * Format a terminal display line for a persona event (non-JSON mode).
 *
 * @param {object} evt - Stream event
 * @returns {string} Formatted line for stderr
 */
export function formatTerminalLine(evt) {
  const agent = evt.agent || {};
  const avatar = agent.avatar || "";
  const name = agent.persona || agent.id || "Agent";
  const p = evt.payload || {};

  switch (evt.event) {
    case "agent_start":
      return `${avatar} ${name} starting (mode: ${p.mode || "primary"})...`;

    case "progress":
      return `${avatar} ${name}: ${p.message || p.phase || "working..."}`;

    case "tool_call":
      return `${avatar} ${name} [${p.tool}] ${formatToolInput(p.input)}`;

    case "tool_result":
      return `${avatar} ${name} [${p.tool}] ${p.durationMs || 0}ms ${p.success === false ? "FAILED" : "ok"}`;

    case "finding": {
      const sev = p.severity || "P3";
      const sevColor = sev === "P0" ? "!!!" : sev === "P1" ? "!!" : sev === "P2" ? "!" : "";
      return `${avatar} [${sev}${sevColor}] ${p.file || ""}:${p.line || ""} ${p.title || ""}`;
    }

    case "reasoning":
      return `${avatar} ${name}: ${(p.summary || "").slice(0, 120)}`;

    case "heartbeat": {
      const h = p;
      const budgetPct = h.budgetRemaining?.pct?.toFixed(0) || "?";
      return `${avatar} ${name} [${h.turnsCompleted || 0}/${h.turnsMax || "?"} turns, ${budgetPct}% budget, ${h.findingsSoFar || 0} findings]`;
    }

    case "budget_warning":
      return `${avatar} ${name} BUDGET WARNING: ${(p.warnings || []).map(w => w.code).join(", ")}`;

    case "budget_stop":
      return `${avatar} ${name} BUDGET STOP: ${(p.reasons || []).map(r => r.code || r).join(", ")}`;

    case "swarm_start":
      return `${avatar} ${name} spawning sub-agents (${p.scannerCount || 0} scanners, ${p.hunterCount || 0} hunters)...`;

    case "swarm_complete":
      return `${avatar} ${name} swarm complete: ${p.totalFindings || 0} findings from ${p.totalAgents || 0} agents ($${(p.totalCostUsd || 0).toFixed(2)})`;

    case "phase_start":
      return `${avatar} ${name} phase: ${p.phase || "unknown"}`;

    case "agent_complete": {
      const s = p;
      return `${avatar} ${name} complete: ${s.total || 0} findings (P0=${s.P0 || 0} P1=${s.P1 || 0} P2=${s.P2 || 0}) $${(s.costUsd || 0).toFixed(2)} ${s.durationMs ? (s.durationMs / 1000).toFixed(1) + "s" : ""}`;
    }

    case "agent_abort":
      return `${avatar} ${name} ABORTED: ${p.reason || "unknown"}`;

    default:
      return `${avatar} ${name} [${evt.event}]`;
  }
}

function formatToolInput(input) {
  if (!input) return "";
  if (input.file_path) return input.file_path;
  if (input.pattern) return `/${input.pattern}/`;
  if (input.operation) return input.operation;
  if (input.command) return input.command.slice(0, 60);
  return "";
}

/**
 * List all valid event types.
 */
export const EVENT_TYPES = Object.freeze([
  "agent_start", "agent_complete", "agent_abort", "agent_error",
  "progress", "heartbeat",
  "tool_call", "tool_result",
  "finding", "reasoning",
  "budget_warning", "budget_stop",
  "swarm_start", "swarm_complete",
  "phase_start", "phase_complete",
  "convergence_expansion", "coverage_gap",
  "llm_error",
]);
