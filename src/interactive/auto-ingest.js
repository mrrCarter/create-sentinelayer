import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";

import { collectCodebaseIngest, generateCodebaseIngest } from "../ingest/engine.js";

/**
 * Auto-ingest with live progress output.
 *
 * Checks if CODEBASE_INGEST.json exists and is fresh.
 * If stale or missing, runs ingest with real-time status updates.
 * Returns the ingest result.
 */

const STALE_THRESHOLD_MS = 300_000; // 5 minutes

/**
 * Check if ingest exists and is fresh enough.
 *
 * @param {string} targetPath - Repository root
 * @returns {{ exists: boolean, stale: boolean, age: number|null, path: string }}
 */
export function checkIngestFreshness(targetPath) {
  const ingestPath = path.join(targetPath, ".sentinelayer", "CODEBASE_INGEST.json");
  if (!fs.existsSync(ingestPath)) {
    return { exists: false, stale: true, age: null, path: ingestPath };
  }

  try {
    const stat = fs.statSync(ingestPath);
    const age = Date.now() - stat.mtimeMs;
    return {
      exists: true,
      stale: age > STALE_THRESHOLD_MS,
      age,
      path: ingestPath,
    };
  } catch {
    return { exists: false, stale: true, age: null, path: ingestPath };
  }
}

/**
 * Run auto-ingest with live progress output to stderr.
 * If ingest exists and is fresh, reads from cache.
 * Otherwise runs full ingest with status updates.
 *
 * @param {string} targetPath
 * @param {object} [options]
 * @param {boolean} [options.force] - Force re-ingest even if fresh
 * @param {boolean} [options.quiet] - Suppress progress output
 * @returns {Promise<object>} Ingest result
 */
export async function autoIngestWithProgress(targetPath, options = {}) {
  const freshness = checkIngestFreshness(targetPath);

  if (freshness.exists && !freshness.stale && !options.force) {
    if (!options.quiet) {
      const ageSec = Math.floor((freshness.age || 0) / 1000);
      process.stderr.write(pc.gray("Using cached ingest (" + ageSec + "s old)\n"));
    }
    try {
      const cached = JSON.parse(fs.readFileSync(freshness.path, "utf-8"));
      return cached;
    } catch { /* fall through to re-ingest */ }
  }

  // Run ingest with progress
  if (!options.quiet) {
    process.stderr.write(pc.cyan("⟳") + " Indexing codebase...\n");
  }

  const startMs = Date.now();

  if (!options.quiet) {
    process.stderr.write(pc.gray("  ├─ Scanning files and directories\n"));
  }

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

  if (!options.quiet) {
    const files = ingest?.summary?.filesScanned || 0;
    const loc = ingest?.summary?.totalLoc || 0;
    const surfaces = (ingest?.riskSurfaces || []).length;
    const frameworks = (ingest?.frameworks || []).join(", ") || "none";

    process.stderr.write(pc.gray("  ├─ Building AST + import graph\n"));
    process.stderr.write(pc.gray("  ├─ Assigning domain surfaces\n"));
    process.stderr.write(pc.gray("  └─ ") + pc.green("Done") + pc.gray(" (" + (durationMs / 1000).toFixed(1) + "s)\n"));
    process.stderr.write("\n");
    process.stderr.write(pc.bold("  Codebase Summary\n"));
    process.stderr.write(pc.gray("  Files: ") + pc.white(String(files)) + "\n");
    process.stderr.write(pc.gray("  LOC: ") + pc.white(String(loc)) + "\n");
    process.stderr.write(pc.gray("  Frameworks: ") + pc.white(frameworks) + "\n");
    process.stderr.write(pc.gray("  Risk surfaces: ") + pc.white(String(surfaces)) + "\n");
    process.stderr.write("\n");
  }

  return ingest;
}
