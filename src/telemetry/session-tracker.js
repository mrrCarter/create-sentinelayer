import pc from "picocolors";
import process from "node:process";

/**
 * Session Tracker — tracks tokens, tool calls, cost, and time per CLI run.
 *
 * Inspired by src/bootstrap/state.ts and src/cost-tracker.ts patterns:
 * - Single global session state initialized once
 * - Accumulator functions for each metric
 * - Summary getter for final report
 * - Print summary on completion
 */

let SESSION = null;

/**
 * Initialize a new tracking session.
 * Call this at the start of any auditable command.
 */
export function startSession(command) {
  SESSION = {
    command: command || "unknown",
    startedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    llmCalls: 0,
    findings: { P0: 0, P1: 0, P2: 0, P3: 0 },
  };
  return SESSION;
}

/**
 * Record token usage from an LLM call.
 */
export function recordLlmUsage({ inputTokens = 0, outputTokens = 0, costUsd = 0 } = {}) {
  if (!SESSION) return;
  SESSION.inputTokens += inputTokens;
  SESSION.outputTokens += outputTokens;
  SESSION.costUsd += costUsd;
  SESSION.llmCalls += 1;
}

/**
 * Record a tool call.
 */
export function recordToolCall() {
  if (!SESSION) return;
  SESSION.toolCalls += 1;
}

/**
 * Record findings.
 */
export function recordFindings(summary) {
  if (!SESSION) return;
  if (summary?.P0) SESSION.findings.P0 += summary.P0;
  if (summary?.P1) SESSION.findings.P1 += summary.P1;
  if (summary?.P2) SESSION.findings.P2 += summary.P2;
  if (summary?.P3) SESSION.findings.P3 += summary.P3;
}

/**
 * Get the current session summary.
 */
export function getSessionSummary() {
  if (!SESSION) return null;
  const durationMs = Date.now() - SESSION.startedAt;
  return {
    command: SESSION.command,
    durationMs,
    inputTokens: SESSION.inputTokens,
    outputTokens: SESSION.outputTokens,
    totalTokens: SESSION.inputTokens + SESSION.outputTokens,
    costUsd: SESSION.costUsd,
    toolCalls: SESSION.toolCalls,
    llmCalls: SESSION.llmCalls,
    findings: { ...SESSION.findings },
  };
}

/**
 * Print the session summary to stderr.
 * Called at the end of any auditable command.
 */
export function printSessionSummary() {
  const summary = getSessionSummary();
  if (!summary) return;

  const duration = summary.durationMs < 60000
    ? (summary.durationMs / 1000).toFixed(1) + "s"
    : (summary.durationMs / 60000).toFixed(1) + "m";

  const tokens = summary.totalTokens > 1000
    ? (summary.totalTokens / 1000).toFixed(1) + "K"
    : String(summary.totalTokens);

  const parts = [];
  parts.push(pc.gray("Run complete:"));
  parts.push(pc.white(tokens + " tokens"));
  parts.push(pc.white(summary.toolCalls + " tools"));
  if (summary.costUsd > 0) parts.push(pc.white("$" + summary.costUsd.toFixed(2)));
  parts.push(pc.white(duration));

  const findingParts = [];
  if (summary.findings.P0 > 0) findingParts.push(pc.red("P0=" + summary.findings.P0));
  if (summary.findings.P1 > 0) findingParts.push(pc.yellow("P1=" + summary.findings.P1));
  if (summary.findings.P2 > 0) findingParts.push(pc.cyan("P2=" + summary.findings.P2));
  if (summary.findings.P3 > 0) findingParts.push(pc.gray("P3=" + summary.findings.P3));

  process.stderr.write("\n" + parts.join(" · "));
  if (findingParts.length > 0) {
    process.stderr.write(" | " + findingParts.join(" "));
  }
  process.stderr.write("\n");

  return summary;
}
