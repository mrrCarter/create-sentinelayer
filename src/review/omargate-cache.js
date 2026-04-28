import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";

const CACHE_SCHEMA_VERSION = "1.0.0";
const CACHE_KIND = "omargate-deterministic-cache";
const LATEST_INDEX_NAME = "latest-omargate.json";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeTargetPath(value) {
  return path.resolve(String(value || "."));
}

function normalizeSummary(value = {}) {
  const summary = value && typeof value === "object" ? value : {};
  const P0 = Math.max(0, Math.floor(Number(summary.P0 || 0)));
  const P1 = Math.max(0, Math.floor(Number(summary.P1 || 0)));
  const P2 = Math.max(0, Math.floor(Number(summary.P2 || 0)));
  const P3 = Math.max(0, Math.floor(Number(summary.P3 || 0)));
  return {
    P0,
    P1,
    P2,
    P3,
    blocking: summary.blocking === undefined ? P0 > 0 || P1 > 0 : Boolean(summary.blocking),
  };
}

function sanitizeRunId(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}

function isSafeRequestedRunId(requested, sanitized) {
  return Boolean(requested) && requested === sanitized && sanitized !== "." && sanitized !== "..";
}

function deterministicCachePath(outputRoot, runId) {
  return path.join(outputRoot, "runs", runId, "deterministic.json");
}

async function readJsonFile(filePath) {
  const content = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(content);
}

function isCacheForTarget(cache, normalizedTargetPath) {
  const cacheTarget = normalizeString(cache?.targetPath);
  if (!cacheTarget) {
    return false;
  }
  return path.resolve(cacheTarget) === normalizedTargetPath;
}

function buildMissingResult({ outputRoot, requested = "latest", reason = "not_found" } = {}) {
  return {
    found: false,
    requested,
    reason,
    outputRoot,
  };
}

async function loadCacheFile({ filePath, outputRoot, requested, normalizedTargetPath }) {
  let cache;
  try {
    cache = await readJsonFile(filePath);
  } catch {
    return buildMissingResult({
      outputRoot,
      requested,
      reason: "malformed_or_missing_cache",
    });
  }

  if (cache?.kind !== CACHE_KIND) {
    return buildMissingResult({
      outputRoot,
      requested,
      reason: "invalid_cache_kind",
    });
  }
  if (!isCacheForTarget(cache, normalizedTargetPath)) {
    return buildMissingResult({
      outputRoot,
      requested,
      reason: "target_mismatch",
    });
  }

  return {
    found: true,
    requested,
    runId: normalizeString(cache.runId),
    artifactPath: filePath,
    outputRoot,
    cache,
  };
}

async function loadLatestFromIndex({ outputRoot, normalizedTargetPath }) {
  const latestPath = path.join(outputRoot, "runs", LATEST_INDEX_NAME);
  let index;
  try {
    index = await readJsonFile(latestPath);
  } catch {
    return null;
  }

  const runId = sanitizeRunId(index?.runId);
  if (!runId || !isCacheForTarget(index, normalizedTargetPath)) {
    return null;
  }
  const artifactPath = normalizeString(index.artifactPath) || deterministicCachePath(outputRoot, runId);
  const loaded = await loadCacheFile({
    filePath: artifactPath,
    outputRoot,
    requested: "latest",
    normalizedTargetPath,
  });
  return loaded.found ? loaded : null;
}

async function loadLatestByScanning({ outputRoot, normalizedTargetPath }) {
  const runsDir = path.join(outputRoot, "runs");
  let entries = [];
  try {
    entries = await fsp.readdir(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runId = sanitizeRunId(entry.name);
    if (!isSafeRequestedRunId(entry.name, runId)) {
      continue;
    }
    const artifactPath = deterministicCachePath(outputRoot, runId);
    try {
      const stat = await fsp.stat(artifactPath);
      candidates.push({ runId, artifactPath, mtimeMs: Number(stat.mtimeMs || 0) });
    } catch {
      // Ignore incomplete run directories.
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    const loaded = await loadCacheFile({
      filePath: candidate.artifactPath,
      outputRoot,
      requested: "latest",
      normalizedTargetPath,
    });
    if (loaded.found) {
      return loaded;
    }
  }
  return null;
}

export async function writeOmarGateDeterministicCache({
  targetPath,
  outputDir = "",
  runId,
  deterministic = {},
  reportPath = "",
} = {}) {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  const outputRoot = await resolveOutputRoot({
    cwd: normalizedTargetPath,
    outputDirOverride: outputDir,
    env: process.env,
  });
  const normalizedRunId = sanitizeRunId(runId || deterministic?.runId);
  if (!normalizedRunId) {
    throw new Error("OmarGate deterministic cache requires a runId.");
  }

  const runDirectory = path.join(outputRoot, "runs", normalizedRunId);
  const artifactPath = path.join(runDirectory, "deterministic.json");
  const latestPath = path.join(outputRoot, "runs", LATEST_INDEX_NAME);
  await fsp.mkdir(runDirectory, { recursive: true });

  const cache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    kind: CACHE_KIND,
    runId: normalizedRunId,
    targetPath: normalizedTargetPath,
    generatedAt: new Date().toISOString(),
    deterministicRunId: normalizeString(deterministic?.runId),
    mode: normalizeString(deterministic?.mode) || "full",
    summary: normalizeSummary(deterministic?.summary),
    findings: Array.isArray(deterministic?.findings) ? deterministic.findings : [],
    scope: deterministic?.scope && typeof deterministic.scope === "object" ? deterministic.scope : {},
    layers: deterministic?.layers && typeof deterministic.layers === "object" ? deterministic.layers : {},
    metadata: deterministic?.metadata && typeof deterministic.metadata === "object" ? deterministic.metadata : {},
    artifacts: deterministic?.artifacts && typeof deterministic.artifacts === "object" ? deterministic.artifacts : {},
    source: {
      command: "/omargate deep",
      reportPath: normalizeString(reportPath),
    },
  };
  await fsp.writeFile(artifactPath, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
  await fsp.writeFile(
    latestPath,
    `${JSON.stringify(
      {
        schemaVersion: CACHE_SCHEMA_VERSION,
        kind: "omargate-latest-index",
        runId: normalizedRunId,
        targetPath: normalizedTargetPath,
        artifactPath,
        updatedAt: cache.generatedAt,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  return {
    runId: normalizedRunId,
    outputRoot,
    runDirectory,
    artifactPath,
    latestPath,
    cache,
  };
}

export async function loadOmarGateDeterministicCache({
  targetPath,
  outputDir = "",
  runIdOrLatest = "latest",
} = {}) {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  const outputRoot = await resolveOutputRoot({
    cwd: normalizedTargetPath,
    outputDirOverride: outputDir,
    env: process.env,
  });
  const requested = normalizeString(runIdOrLatest) || "latest";

  if (requested.toLowerCase() === "latest") {
    const latestFromIndex = await loadLatestFromIndex({
      outputRoot,
      normalizedTargetPath,
    });
    if (latestFromIndex) {
      return latestFromIndex;
    }
    const latestFromScan = await loadLatestByScanning({
      outputRoot,
      normalizedTargetPath,
    });
    return latestFromScan || buildMissingResult({ outputRoot, requested, reason: "not_found" });
  }

  const runId = sanitizeRunId(requested);
  if (!isSafeRequestedRunId(requested, runId)) {
    return buildMissingResult({
      outputRoot,
      requested,
      reason: "invalid_run_id",
    });
  }
  return loadCacheFile({
    filePath: deterministicCachePath(outputRoot, runId),
    outputRoot,
    requested,
    normalizedTargetPath,
  });
}
