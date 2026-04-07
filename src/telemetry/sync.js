import { readStoredSession } from "../auth/session-store.js";

// Simple circuit breaker: skip sync after 3 consecutive failures
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Telemetry Sync — uploads CLI run results to sentinelayer-api.
 *
 * Called after audit, review, omargate commands complete.
 * Fire-and-forget: never blocks the CLI, never crashes on failure.
 * The API stores this data and the web dashboard renders it.
 *
 * What syncs:
 * - Run metadata (command, persona, mode, framework detected)
 * - Findings summary (P0/P1/P2/P3 counts, blocking status)
 * - Usage telemetry (tokens, cost, duration, tool calls)
 * - Stop reason (budget exhausted, max turns, completed, etc.)
 *
 * What stays local:
 * - Full finding details (file:line evidence) — too large for sync
 * - Ingest artifacts — regenerated locally
 * - Spec/prompt/guide files — project artifacts
 */

const SYNC_TIMEOUT_MS = 10000;

/**
 * Sync a CLI run to the user's sentinelayer dashboard.
 *
 * @param {object} runData
 * @param {string} runData.command - e.g., "audit frontend", "omargate deep", "review scan"
 * @param {string} [runData.persona] - e.g., "Jules Tanaka"
 * @param {string} [runData.mode] - e.g., "primary", "deep", "diff"
 * @param {object} [runData.summary] - { total, P0, P1, P2, P3, blocking }
 * @param {object} [runData.usage] - { tokens, costUsd, durationMs, toolCalls }
 * @param {string} [runData.stopReason] - e.g., "completed", "budget_exhausted"
 * @param {string} [runData.framework] - e.g., "next.js"
 * @param {object} [runData.reconciliation] - baseline reconciliation summary
 * @param {object} [runData.runtime] - runtime audit summary (lighthouse scores, headers)
 * @returns {Promise<{ synced: boolean, reason?: string }>}
 */
export async function syncRunToDashboard(runData) {
  let session;
  // Circuit breaker: skip if too many consecutive failures
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { synced: false, reason: "circuit_breaker_open" };
  }

  try {
    session = await readStoredSession();
  } catch {
    return { synced: false, reason: "no_session" };
  }

  if (!session || !session.token) {
    return { synced: false, reason: "not_authenticated" };
  }

  const apiUrl = session.apiUrl || "https://api.sentinelayer.com";

  try {
    // Create a run record
    const response = await fetch(apiUrl + "/api/v1/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + session.token,
      },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      body: JSON.stringify({
        mode: mapCommandToMode(runData.command),
        runtime_profile: "cli_local",
        repo: detectRepoName(),
        ref: detectGitRef(),
        orchestrator_model: runData.persona || "cli",
        subagent_model: "deterministic",
        budget: {
          max_cost_usd: runData.usage?.maxCostUsd || 5.0,
          max_iterations: runData.usage?.maxTurns || 25,
        },
        max_iterations: 1,
      }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { synced: false, reason: "api_" + response.status };
    }

    const created = await response.json();
    const runId = created.run_id;

    // Post a completion event with telemetry
    if (runId) {
      await fetch(apiUrl + "/api/v1/runs/" + runId + "/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.token,
        },
        body: JSON.stringify({
          exit_reason: runData.stopReason || "completed",
          stop_class: runData.summary?.blocking ? "BLOCKING_FINDINGS" : "CLEAN",
          summary: {
            command: runData.command,
            persona: runData.persona || null,
            mode: runData.mode || null,
            framework: runData.framework || null,
            findings: runData.summary || { total: 0, P0: 0, P1: 0, P2: 0, P3: 0 },
            usage: {
              token_usage: runData.usage?.tokens || runData.usage?.outputTokens || 0,
              cost_usd: runData.usage?.costUsd || 0,
              duration_ms: runData.usage?.durationMs || 0,
              tool_calls: runData.usage?.toolCalls || 0,
            },
            reconciliation: runData.reconciliation || null,
            runtime: runData.runtime || null,
          },
        }),
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      }).catch(() => {}); // completion event is best-effort
    }

    consecutiveFailures = 0; // reset on success
    return { synced: true, runId };
  } catch (err) {
    consecutiveFailures++;
    return { synced: false, reason: err.message };
  }
}

function mapCommandToMode(command) {
  if (!command) return "audit_readonly";
  const lower = String(command).toLowerCase();
  if (lower.includes("review")) return "audit_readonly";
  if (lower.includes("omargate")) return "audit_readonly";
  if (lower.includes("audit")) return "audit_readonly";
  if (lower.includes("fix")) return "edit_gated";
  return "audit_readonly";
}

function detectRepoName() {
  try {
    const { execFileSync } = require("node:child_process");
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : "unknown";
  } catch {
    return "local";
  }
}

function detectGitRef() {
  try {
    const { execFileSync } = require("node:child_process");
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim() || "main";
  } catch {
    return "main";
  }
}
