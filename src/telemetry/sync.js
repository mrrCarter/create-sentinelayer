import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveActiveAuthSession } from "../auth/service.js";

// Read CLI version from package.json at module load
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = resolve(__dirname, "../../package.json");
let CLI_VERSION = "0.0.0";
try {
  CLI_VERSION = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
} catch { /* fallback */ }

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
 * @param {object} [runData.usage] - { tokens, inputTokens, outputTokens, costUsd, durationMs, toolCalls }
 * @param {string} [runData.stopReason] - e.g., "completed", "budget_exhausted"
 * @param {string} [runData.framework] - e.g., "next.js"
 * @param {object} [runData.reconciliation] - baseline reconciliation summary
 * @param {object} [runData.runtime] - runtime audit summary (lighthouse scores, headers)
 * @returns {Promise<{ synced: boolean, reason?: string, runId?: string }>}
 */
export async function syncRunToDashboard(runData) {
  // Circuit breaker: skip if too many consecutive failures
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { synced: false, reason: "circuit_breaker_open" };
  }

  let session;
  try {
    session = await resolveActiveAuthSession({
      cwd: process.cwd(),
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return { synced: false, reason: "no_session" };
  }

  if (!session || !session.token) {
    return { synced: false, reason: "not_authenticated" };
  }

  const apiUrl = session.apiUrl || "https://api.sentinelayer.com";
  const runId = randomUUID();

  try {
    const payload = {
      schema_version: "1.0",
      tier: 2,
      run: {
        run_id: runId,
        timestamp_utc: new Date().toISOString(),
        duration_ms: runData.usage?.durationMs || 0,
        state: runData.stopReason || "passed",
      },
      repo: {
        owner: detectRepoOwner(),
        name: detectRepoName(),
        branch: detectGitRef(),
      },
      scan: {
        mode: mapCommandToMode(runData.command),
        tokens_in: runData.usage?.inputTokens || runData.usage?.tokens || 0,
        tokens_out: runData.usage?.outputTokens || 0,
        cost_estimate_usd: runData.usage?.costUsd || 0,
        model_used: runData.persona || "deterministic",
      },
      findings: {
        counts: {
          P0: runData.summary?.P0 || 0,
          P1: runData.summary?.P1 || 0,
          P2: runData.summary?.P2 || 0,
          P3: runData.summary?.P3 || 0,
        },
      },
      gate: {
        result: runData.summary?.blocking ? "blocked" : "passed",
        severity_threshold: "P1",
      },
      meta: {
        source: "cli",
        command: runData.command,
        persona: runData.persona || null,
        framework: runData.framework || null,
        cli_version: CLI_VERSION,
      },
    };

    const response = await fetchWithTimeout(apiUrl + "/api/v1/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.token,
      },
      body: JSON.stringify(payload),
    }, SYNC_TIMEOUT_MS);

    if (!response.ok) {
      consecutiveFailures++;
      return { synced: false, reason: "api_" + response.status };
    }

    consecutiveFailures = 0; // reset on success
    return { synced: true, runId };
  } catch (err) {
    consecutiveFailures++;
    return { synced: false, reason: err.message };
  }
}

function mapCommandToMode(command) {
  if (!command) return "quick_scan";
  const lower = String(command).toLowerCase();
  if (lower.includes("omargate")) return "deep_scan";
  if (lower.includes("review")) return "quick_scan";
  if (lower.includes("audit") && lower.includes("frontend")) return "audit_frontend";
  if (lower.includes("audit")) return "audit_full";
  if (lower.includes("fix")) return "edit_gated";
  return "quick_scan";
}

function detectRepoOwner() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // Match owner from patterns like:
    //   https://github.com/owner/repo.git
    //   git@github.com:owner/repo.git
    const httpsMatch = remote.match(/(?:github\.com|gitlab\.com)[/:]([^/]+)\//);
    if (httpsMatch) return httpsMatch[1];
    return "unknown";
  } catch {
    return "unknown";
  }
}

function detectRepoName() {
  try {
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
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim() || "main";
  } catch {
    return "main";
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
}
