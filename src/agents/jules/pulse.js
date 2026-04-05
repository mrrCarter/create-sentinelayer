import { randomUUID } from "node:crypto";
import { PERSONA_VISUALS } from "./config/definition.js";

/**
 * Pulse — SentinelLayer Internal Daemon Monitor
 *
 * Monitors running agent health, routes errors to the right persona,
 * detects stuck/idle agents, and sends alerts on state changes.
 * NOT called Kairos — Pulse monitors the heartbeat of all agents.
 */

// ── Stuck Detection ──────────────────────────────────────────────────

const STUCK_THRESHOLDS = Object.freeze({
  noToolCallSeconds: 90,
  noProgressTurns: 5,
  sameFileReadCount: 3,
  budgetConsumedNoOutput: 0.5,
  maxIdleBeforeEscalate: 300,
  maxIdleBeforeKill: 600,
});

/**
 * Detect if an agent is stuck based on its current state.
 *
 * @param {object} agentState
 * @param {number} agentState.lastToolCallAt - Epoch ms
 * @param {number} agentState.lastTurnProgressAt - Epoch ms
 * @param {number} agentState.sameFileReadCount - Consecutive reads of same file
 * @param {string} [agentState.lastFileRead] - Path of last file read
 * @param {number} agentState.budgetConsumedPct - 0-100
 * @param {number} agentState.findingCount
 * @param {number} [agentState.turnsSinceLastProgress]
 * @returns {{ stuck: boolean, reason?: string, idleSeconds?: number, file?: string, budgetPct?: number }}
 */
export function detectStuckState(agentState) {
  const now = Date.now();

  // No tool calls for threshold period
  if (agentState.lastToolCallAt) {
    const idleMs = now - agentState.lastToolCallAt;
    if (idleMs > STUCK_THRESHOLDS.noToolCallSeconds * 1000) {
      return { stuck: true, reason: "no_tool_calls", idleSeconds: Math.floor(idleMs / 1000) };
    }
  }

  // Same file read repeatedly (loop detection)
  if (agentState.sameFileReadCount >= STUCK_THRESHOLDS.sameFileReadCount) {
    return { stuck: true, reason: "loop_detected", file: agentState.lastFileRead };
  }

  // High budget consumption with no findings
  if (
    agentState.budgetConsumedPct > STUCK_THRESHOLDS.budgetConsumedNoOutput * 100 &&
    agentState.findingCount === 0
  ) {
    return { stuck: true, reason: "inefficient", budgetPct: agentState.budgetConsumedPct };
  }

  // No turn progress
  if (agentState.turnsSinceLastProgress >= STUCK_THRESHOLDS.noProgressTurns) {
    return { stuck: true, reason: "no_progress", turns: agentState.turnsSinceLastProgress };
  }

  return { stuck: false };
}

/**
 * Determine recovery action based on idle duration.
 *
 * @param {number} idleSeconds
 * @returns {"hint" | "escalate" | "kill"}
 */
export function determineRecoveryAction(idleSeconds) {
  if (idleSeconds >= STUCK_THRESHOLDS.maxIdleBeforeKill) return "kill";
  if (idleSeconds >= STUCK_THRESHOLDS.maxIdleBeforeEscalate) return "escalate";
  return "hint";
}

// ── Error-to-Persona Routing ─────────────────────────────────────────

const ROUTING_RULES = [
  // Stack trace patterns (most reliable)
  { test: (w) => /\.(tsx|jsx|vue|svelte):\d+/.test(w.stackTrace || ""), persona: "frontend" },
  { test: (w) => /React|Next|Vite|Webpack|hydrat/i.test(w.stackTrace || ""), persona: "frontend" },
  { test: (w) => /\.py:\d+/.test(w.stackTrace || ""), persona: "backend" },
  { test: (w) => /\.go:\d+/.test(w.stackTrace || ""), persona: "backend" },

  // Endpoint patterns
  { test: (w) => /\.(html|css|js|png|svg|woff)$/.test(w.endpoint || ""), persona: "frontend" },
  { test: (w) => /\/api\/v\d+\/auth/.test(w.endpoint || ""), persona: "security" },
  { test: (w) => /\/api\//.test(w.endpoint || ""), persona: "backend" },

  // Error code patterns
  { test: (w) => /HYDRATION|RENDER|DOM|CSR|SSR/i.test(w.errorCode || ""), persona: "frontend" },
  { test: (w) => /AUTH|TOKEN|SESSION|PERMISSION/i.test(w.errorCode || ""), persona: "security" },
  { test: (w) => /TIMEOUT|ECONNREFUSED|DNS|SOCKET/i.test(w.errorCode || ""), persona: "infrastructure" },
  { test: (w) => /QUERY|MIGRATION|CONSTRAINT|DEADLOCK/i.test(w.errorCode || ""), persona: "data" },
];

/**
 * Route an error work item to the appropriate persona.
 *
 * @param {object} workItem - Error queue item
 * @returns {string} Persona ID (e.g., "frontend", "backend", "security")
 */
export function routeErrorToPersona(workItem) {
  for (const rule of ROUTING_RULES) {
    if (rule.test(workItem)) return rule.persona;
  }
  return "backend"; // default fallback
}

// ── Alert Building ───────────────────────────────────────────────────

/**
 * Build a concise alert payload for Slack/Telegram.
 *
 * @param {object} config
 * @param {string} config.agentId - Persona ID
 * @param {string} config.event - Alert event type
 * @param {object} config.state - Agent state snapshot
 * @param {string} [config.workItemId]
 * @param {string} [config.jiraIssueKey]
 * @returns {{ headline, body, severity }}
 */
export function buildAlertPayload({ agentId, event, state, workItemId, jiraIssueKey }) {
  const visual = PERSONA_VISUALS[agentId] || { avatar: "", fullName: agentId, color: "white" };
  const avatar = visual.avatar;
  const name = visual.fullName;

  const lines = [];
  lines.push(`${avatar} ${name} \u2014 ${formatAlertEvent(event)}`);
  lines.push("\u2501".repeat(30));

  if (workItemId) lines.push(`Work Item: ${workItemId}`);
  if (jiraIssueKey) lines.push(`Jira: ${jiraIssueKey}`);

  if (state) {
    if (state.durationMs) lines.push(`Duration: ${formatDuration(state.durationMs)}`);
    if (state.budgetPct !== undefined) lines.push(`Budget: ${state.budgetPct.toFixed(0)}%`);
    if (state.turnsCompleted !== undefined) lines.push(`Turns: ${state.turnsCompleted}/${state.turnsMax || "?"}`);
    if (state.findingCount !== undefined) lines.push(`Findings: ${state.findingCount}`);
    if (state.lastAction) lines.push(`Last: ${state.lastAction}`);
    if (state.costUsd !== undefined) lines.push(`Cost: $${state.costUsd.toFixed(2)}`);
    if (state.prNumber) lines.push(`PR: #${state.prNumber}`);
  }

  const severity = event.includes("stuck") || event.includes("kill") ? "warning" :
    event.includes("merged") || event.includes("complete") ? "success" : "info";

  lines.push("");
  lines.push(`\u2014 ${name}, SentinelLayer`);

  return {
    headline: `${avatar} ${name}: ${formatAlertEvent(event)}`,
    body: lines.join("\n"),
    severity,
  };
}

function formatAlertEvent(event) {
  const map = {
    agent_stuck: "Agent Stuck",
    agent_recovered: "Agent Recovered",
    budget_warning: "Budget Warning",
    budget_exhausted: "Budget Exhausted",
    pr_merged: "PR Merged",
    audit_complete: "Audit Complete",
    fix_complete: "Fix Complete",
    kill_switch: "Kill Switch Activated",
    error_intake: "Error Received",
    jira_resolved: "Jira Resolved",
  };
  return map[event] || event;
}

function formatDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

// ── Health Summary ───────────────────────────────────────────────────

/**
 * Build a periodic health summary for Slack/Telegram.
 *
 * @param {object[]} agentStates - Current states of all running agents
 * @returns {{ headline, body } | null} null if nothing to report
 */
export function buildHealthSummary(agentStates) {
  if (!agentStates || agentStates.length === 0) return null;

  const active = agentStates.filter(a => a.status === "active");
  const stuck = agentStates.filter(a => a.stuck);
  const completed = agentStates.filter(a => a.status === "completed");

  if (active.length === 0 && stuck.length === 0 && completed.length === 0) return null;

  const lines = [];
  lines.push("\u{1F4CA} Pulse Health Summary");
  lines.push("\u2501".repeat(30));
  lines.push(`Active: ${active.length} | Stuck: ${stuck.length} | Completed: ${completed.length}`);

  for (const a of active.slice(0, 5)) {
    const visual = PERSONA_VISUALS[a.agentId] || {};
    lines.push(`  ${visual.avatar || ""} ${visual.shortName || a.agentId}: ${a.findingCount || 0} findings, $${(a.costUsd || 0).toFixed(2)}`);
  }

  if (stuck.length > 0) {
    lines.push("");
    lines.push("\u26A0\uFE0F Stuck agents:");
    for (const s of stuck) {
      const visual = PERSONA_VISUALS[s.agentId] || {};
      lines.push(`  ${visual.avatar || ""} ${visual.shortName || s.agentId}: ${s.reason || "unknown"} (${s.idleSeconds || 0}s idle)`);
    }
  }

  return {
    headline: `Pulse: ${active.length} active, ${stuck.length} stuck, ${completed.length} done`,
    body: lines.join("\n"),
  };
}

export { STUCK_THRESHOLDS };
