import fs from "node:fs";
import path from "node:path";
import { collectCodebaseIngest, generateCodebaseIngest } from "../ingest/engine.js";
import { createAgentEvent } from "../events/schema.js";

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
 * @param {string} targetPath
 * @param {object} [options]
 * @param {number} [options.maxDurationMs] - Max refresh time (default 30s)
 * @param {function} [options.onEvent] - Event callback
 * @returns {Promise<{ refreshed: boolean, reason: string, durationMs: number }>}
 */
export async function refreshIngestIfNeeded(targetPath, options = {}) {
  const maxDurationMs = options.maxDurationMs || DEFAULT_MAX_DURATION_MS;
  const drift = detectIngestDrift(targetPath);

  if (!drift.changed) {
    return { refreshed: false, reason: "no_drift", durationMs: 0, ...drift };
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

    if (options.onEvent) {
      options.onEvent(createAgentEvent({
        event: "ingest_refresh_complete",
        agentId: "daemon-ingest-refresh",
        payload: {
          durationMs,
          filesScanned: ingest?.summary?.filesScanned || 0,
          delta: drift.delta,
        },
      }));
    }

    return {
      refreshed: true,
      reason: "drift_detected",
      durationMs,
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
