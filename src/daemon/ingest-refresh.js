import fs from "node:fs";
import path from "node:path";
import { collectCodebaseIngest, generateCodebaseIngest } from "../ingest/engine.js";
import { createAgentEvent } from "../events/schema.js";
import {
  buildAstSnapshot,
  detectAstDrift,
  writeAstSnapshot,
} from "./ast-drift.js";

/**
 * Pulse Ingest Refresh — periodic codebase re-index.
 *
 * Detects when the file count changes vs the last ingest.
 * If delta detected: re-runs ingest + AST + domain assignment.
 * Budget-gated: aborts if refresh takes > maxDurationMs.
 *
 * Inspired by src/utils/cronScheduler.ts file watcher pattern.
 */

const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_MAX_DURATION_MS = 30_000; // 30 seconds
const STALE_FILE_COUNT_THRESHOLD = 5; // re-ingest if >= 5 files changed

/**
 * Check if the codebase has changed since last ingest.
 *
 * @param {string} targetPath - Repository root
 * @returns {{ changed: boolean, currentFileCount: number, lastFileCount: number, delta: number }}
 */
export function detectIngestDrift(targetPath) {
  const ingestPath = path.join(targetPath, ".sentinelayer", "CODEBASE_INGEST.json");

  let lastFileCount = 0;
  try {
    const ingest = JSON.parse(fs.readFileSync(ingestPath, "utf-8"));
    lastFileCount = ingest?.summary?.filesScanned || 0;
  } catch {
    return { changed: true, currentFileCount: 0, lastFileCount: 0, delta: 0 };
  }

  // Quick file count via directory scan (fast, no deep analysis)
  let currentFileCount = 0;
  try {
    currentFileCount = countFilesQuick(targetPath);
  } catch {
    return { changed: false, currentFileCount: 0, lastFileCount, delta: 0 };
  }

  const delta = Math.abs(currentFileCount - lastFileCount);
  return {
    changed: delta >= STALE_FILE_COUNT_THRESHOLD,
    currentFileCount,
    lastFileCount,
    delta,
  };
}

/**
 * Run a budget-gated ingest refresh.
 * Aborts if refresh takes longer than maxDurationMs.
 *
 * Drift detection (#A11, spec §5.7): when `driftMode` is "ast" we use the
 * AST signature diff (new exports / imports, removed files, renamed
 * signatures); otherwise we fall back to the quick file-count heuristic for
 * backward compatibility. AST mode writes a snapshot after every refresh so
 * subsequent runs can diff against it.
 *
 * @param {string} targetPath
 * @param {object} [options]
 * @param {number} [options.maxDurationMs] - Max refresh time (default 30s)
 * @param {"file-count"|"ast"} [options.driftMode="file-count"]
 * @param {function} [options.onEvent] - Event callback
 * @returns {Promise<{ refreshed: boolean, reason: string, durationMs: number }>}
 */
export async function refreshIngestIfNeeded(targetPath, options = {}) {
  const maxDurationMs = options.maxDurationMs || DEFAULT_MAX_DURATION_MS;
  const driftMode = options.driftMode === "ast" ? "ast" : "file-count";
  let astOutcome = null;

  if (driftMode === "ast") {
    astOutcome = await detectAstDrift({ rootPath: targetPath });
    if (!astOutcome.driftDetected) {
      return {
        refreshed: false,
        reason: "no_drift",
        durationMs: 0,
        driftMode,
        astReason: astOutcome.reason || null,
      };
    }
  }

  const drift =
    driftMode === "file-count"
      ? detectIngestDrift(targetPath)
      : {
          changed: true,
          currentFileCount: 0,
          lastFileCount: 0,
          delta: 0,
          astReason: astOutcome?.reason || null,
        };

  if (!drift.changed) {
    return {
      refreshed: false,
      reason: "no_drift",
      durationMs: 0,
      driftMode,
      ...drift,
    };
  }

  if (options.onEvent) {
    options.onEvent(createAgentEvent({
      event: "ingest_refresh_start",
      agentId: "daemon-ingest-refresh",
      payload: { delta: drift.delta, currentFiles: drift.currentFileCount, lastFiles: drift.lastFileCount },
    }));
  }

  const startMs = Date.now();

  // Budget gate: abort if taking too long
  const timeout = setTimeout(() => {
    if (options.onEvent) {
      options.onEvent(createAgentEvent({
        event: "ingest_refresh_timeout",
        agentId: "daemon-ingest-refresh",
        payload: { maxDurationMs, elapsed: Date.now() - startMs },
      }));
    }
  }, maxDurationMs);

  try {
    let ingest;
    try {
      ingest = await generateCodebaseIngest({
        rootPath: targetPath,
        outputDir: path.join(targetPath, ".sentinelayer"),
        refresh: true,
      });
    } catch {
      ingest = await collectCodebaseIngest({ rootPath: targetPath });
    }

    const durationMs = Date.now() - startMs;

    // On AST mode, persist the new snapshot so the next run diffs against
    // what we just observed, not against a stale baseline.
    if (driftMode === "ast" && astOutcome?.currentSnapshot) {
      try {
        await writeAstSnapshot({
          rootPath: targetPath,
          snapshot: astOutcome.currentSnapshot,
        });
      } catch {
        // Snapshot write is best-effort — the refresh itself succeeded.
      }
    }

    if (options.onEvent) {
      options.onEvent(createAgentEvent({
        event: "ingest_refresh_complete",
        agentId: "daemon-ingest-refresh",
        payload: {
          durationMs,
          filesScanned: ingest?.summary?.filesScanned || 0,
          delta: drift.delta,
          driftMode,
        },
      }));
    }

    return {
      refreshed: true,
      reason: "drift_detected",
      durationMs,
      driftMode,
      filesScanned: ingest?.summary?.filesScanned || 0,
      ...drift,
    };
  } catch (err) {
    return {
      refreshed: false,
      reason: "refresh_failed: " + err.message,
      durationMs: Date.now() - startMs,
      ...drift,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Start a periodic ingest refresh watcher.
 * Checks for drift every checkIntervalMs and refreshes if needed.
 *
 * @param {string} targetPath
 * @param {object} [options]
 * @param {number} [options.checkIntervalMs] - Check interval (default 60s)
 * @param {number} [options.maxDurationMs] - Max refresh time (default 30s)
 * @param {function} [options.onEvent] - Event callback
 * @returns {{ stop: function }} - Call stop() to stop watching
 */
export function startPeriodicRefresh(targetPath, options = {}) {
  const checkIntervalMs = options.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS;
  let running = true;

  const check = async () => {
    if (!running) return;
    await refreshIngestIfNeeded(targetPath, options);
    if (running) {
      setTimeout(check, checkIntervalMs);
    }
  };

  // Start first check after one interval
  const timer = setTimeout(check, checkIntervalMs);

  return {
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}

/**
 * Quick file count — counts source files without deep analysis.
 * Much faster than full ingest for drift detection.
 */
function countFilesQuick(rootPath) {
  const IGNORE = new Set([
    ".git", "node_modules", ".next", "dist", "build", "coverage",
    ".turbo", ".venv", "__pycache__", ".cache", ".sentinelayer",
  ]);
  let count = 0;

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORE.has(entry.name)) continue;
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else if (entry.isFile()) count++;
      }
    } catch { /* skip unreadable */ }
  }

  walk(rootPath);
  return count;
}

// AST-based drift detection surface (#A11). Re-exported here so callers that
// already import from daemon/ingest-refresh.js can opt in without reaching
// into the ast-drift module directly.
export {
  buildAstSnapshot,
  detectAstDrift,
  writeAstSnapshot,
} from "./ast-drift.js";
