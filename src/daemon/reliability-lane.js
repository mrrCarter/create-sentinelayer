import fsp from "node:fs/promises";
import path from "node:path";

import { appendAdminErrorEvent, resolveErrorDaemonStorage, runErrorDaemonWorker } from "./error-worker.js";

const RELIABILITY_SCHEMA_VERSION = "1.0.0";
const MAINTENANCE_SCHEMA_VERSION = "1.0.0";

export const RELIABILITY_CHECK_IDS = Object.freeze([
  "aidenid_password_reset_flow",
  "aidenid_invite_flow",
]);

function normalizeString(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function normalizeIsoTimestamp(value, fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallbackIso;
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    return fallbackIso;
  }
  return new Date(epoch).toISOString();
}

function normalizeBoolean(value, fallbackValue) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = normalizeString(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function normalizeCsv(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  const normalized = normalizeString(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeChecks(checkIds = []) {
  return normalizeCsv(checkIds)
    .map((item) => item.toLowerCase())
    .filter((item) => RELIABILITY_CHECK_IDS.includes(item));
}

function createReliabilityRunId(nowIso, region = "global") {
  const normalizedRegion = normalizeString(region).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `reliability-lane-${normalizedRegion}-${nowIso.replace(/[:.]/g, "-")}`;
}

function createDefaultBillboard(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    enabled: false,
    message: "",
    source: null,
    actor: null,
    openedAt: null,
    resolvedAt: null,
    lastUpdatedAt: normalizeIsoTimestamp(nowIso, nowIso),
  };
}

function normalizeBillboard(raw = {}, nowIso = new Date().toISOString()) {
  return {
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(raw.generatedAt, nowIso),
    enabled: normalizeBoolean(raw.enabled, false),
    message: normalizeString(raw.message),
    source: normalizeString(raw.source) || null,
    actor: normalizeString(raw.actor) || null,
    openedAt: raw.openedAt ? normalizeIsoTimestamp(raw.openedAt, nowIso) : null,
    resolvedAt: raw.resolvedAt ? normalizeIsoTimestamp(raw.resolvedAt, nowIso) : null,
    lastUpdatedAt: raw.lastUpdatedAt
      ? normalizeIsoTimestamp(raw.lastUpdatedAt, nowIso)
      : normalizeIsoTimestamp(nowIso, nowIso),
  };
}

function createDefaultConfig(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: RELIABILITY_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    enabled: true,
    schedule: {
      cron: "0 0 * * *",
      timezone: "UTC",
      regions: ["us-east-1"],
    },
    checks: RELIABILITY_CHECK_IDS,
  };
}

function normalizeConfig(raw = {}, nowIso = new Date().toISOString()) {
  const checks = normalizeChecks(raw.checks);
  return {
    schemaVersion: RELIABILITY_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(raw.generatedAt, nowIso),
    enabled: normalizeBoolean(raw.enabled, true),
    schedule: {
      cron: normalizeString(raw.schedule?.cron) || "0 0 * * *",
      timezone: normalizeString(raw.schedule?.timezone) || "UTC",
      regions: normalizeCsv(raw.schedule?.regions).length
        ? normalizeCsv(raw.schedule?.regions)
        : ["us-east-1"],
    },
    checks: checks.length > 0 ? checks : [...RELIABILITY_CHECK_IDS],
  };
}

async function readJsonFile(filePath, defaultFactory) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return defaultFactory();
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function appendJsonLine(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

async function listRunArtifacts(runsDir, outputRoot) {
  try {
    const entries = await fsp.readdir(runsDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(runsDir, entry.name));
    const payloads = await Promise.all(
      files.map(async (filePath) => {
        const payload = await readJsonFile(filePath, () => null);
        if (!payload || typeof payload !== "object") {
          return null;
        }
        return {
          runId: normalizeString(payload.runId) || path.basename(filePath, ".json"),
          generatedAt: normalizeIsoTimestamp(payload.generatedAt, new Date().toISOString()),
          overallStatus: normalizeString(payload.overallStatus) || "UNKNOWN",
          failureCount: Number(payload.failureCount || 0),
          path: normalizeString(path.relative(outputRoot, filePath)).replace(/\\/g, "/"),
        };
      })
    );
    return payloads
      .filter(Boolean)
      .sort((left, right) => (Date.parse(String(right.generatedAt || "")) || 0) - (Date.parse(String(left.generatedAt || "")) || 0));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function resolveReliabilityLaneStorage({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const daemonStorage = await resolveErrorDaemonStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const reliabilityDir = path.join(daemonStorage.baseDir, "reliability");
  return {
    ...daemonStorage,
    reliabilityDir,
    configPath: path.join(reliabilityDir, "lane-config.json"),
    billboardPath: path.join(reliabilityDir, "maintenance-billboard.json"),
    eventsPath: path.join(reliabilityDir, "reliability-events.ndjson"),
    runsDir: path.join(reliabilityDir, "runs"),
  };
}

export async function setMaintenanceBillboard({
  targetPath = ".",
  outputDir = "",
  enabled,
  message = "",
  source = "manual",
  actor = "omar-operator",
  reason = "",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const storage = await resolveReliabilityLaneStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const current = normalizeBillboard(
    await readJsonFile(storage.billboardPath, () => createDefaultBillboard(normalizedNow)),
    normalizedNow
  );
  const nextEnabled = normalizeBoolean(enabled, current.enabled);
  const normalizedMessage = normalizeString(message);
  const normalizedSource = normalizeString(source) || "manual";
  const normalizedActor = normalizeString(actor) || "omar-operator";
  const normalizedReason = normalizeString(reason) || null;

  const next = {
    ...current,
    generatedAt: normalizedNow,
    enabled: nextEnabled,
    message: normalizedMessage || current.message || "",
    source: normalizedSource,
    actor: normalizedActor,
    openedAt: nextEnabled ? current.openedAt || normalizedNow : current.openedAt,
    resolvedAt: nextEnabled ? null : normalizedNow,
    lastUpdatedAt: normalizedNow,
  };

  await Promise.all([
    writeJsonFile(storage.billboardPath, next),
    appendJsonLine(storage.eventsPath, {
      timestamp: normalizedNow,
      eventType: "maintenance_update",
      enabled: next.enabled,
      source: normalizedSource,
      actor: normalizedActor,
      reason: normalizedReason,
      message: next.message,
    }),
  ]);

  return {
    ...storage,
    billboard: next,
  };
}

export async function getReliabilityLaneStatus({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
  limit = 10,
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const storage = await resolveReliabilityLaneStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const [configRaw, billboardRaw, runs] = await Promise.all([
    readJsonFile(storage.configPath, () => createDefaultConfig(normalizedNow)),
    readJsonFile(storage.billboardPath, () => createDefaultBillboard(normalizedNow)),
    listRunArtifacts(storage.runsDir, storage.outputRoot),
  ]);
  const normalizedLimit = Math.max(1, Math.floor(Number(limit || 10)));
  return {
    ...storage,
    config: normalizeConfig(configRaw, normalizedNow),
    billboard: normalizeBillboard(billboardRaw, normalizedNow),
    runCount: runs.length,
    recentRuns: runs.slice(0, normalizedLimit),
  };
}

export async function runReliabilityLane({
  targetPath = ".",
  outputDir = "",
  region = "us-east-1",
  timezone = "UTC",
  simulateFailures = [],
  checks = [],
  autoOpenMaintenance = true,
  clearMaintenanceOnPass = true,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const storage = await resolveReliabilityLaneStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });

  const [configRaw, billboardRaw] = await Promise.all([
    readJsonFile(storage.configPath, () => createDefaultConfig(normalizedNow)),
    readJsonFile(storage.billboardPath, () => createDefaultBillboard(normalizedNow)),
  ]);
  const config = normalizeConfig(configRaw, normalizedNow);
  const currentBillboard = normalizeBillboard(billboardRaw, normalizedNow);
  const selectedChecks = normalizeChecks(checks);
  const checksToRun = selectedChecks.length > 0 ? selectedChecks : config.checks;
  const failureSet = new Set(normalizeChecks(simulateFailures));

  const checkResults = checksToRun.map((checkId, index) => {
    const failed = failureSet.has(checkId);
    return {
      checkId,
      status: failed ? "FAIL" : "PASS",
      durationMs: 1200 + index * 250,
      message: failed
        ? `Synthetic check '${checkId}' failed in ${region}.`
        : `Synthetic check '${checkId}' passed in ${region}.`,
    };
  });
  const failureResults = checkResults.filter((check) => check.status === "FAIL");
  const overallStatus = failureResults.length > 0 ? "FAIL" : "PASS";

  const autoQueueFailures = failureResults.length > 0;
  let workerRun = null;
  if (autoQueueFailures) {
    for (const failure of failureResults) {
      await appendAdminErrorEvent({
        targetPath,
        outputDir,
        event: {
          source: "reliability_lane",
          service: "aidenid-synthetic",
          endpoint: `/synthetic/${failure.checkId}`,
          errorCode: `${failure.checkId.toUpperCase()}_FAILED`,
          severity: "P1",
          message: failure.message,
          metadata: {
            region,
            timezone,
            checkId: failure.checkId,
            lane: "midnight",
          },
        },
        env,
        homeDir,
      });
    }
    workerRun = await runErrorDaemonWorker({
      targetPath,
      outputDir,
      maxEvents: Math.max(20, failureResults.length * 5),
      env,
      homeDir,
      nowIso: normalizedNow,
    });
  }

  let billboard = currentBillboard;
  if (overallStatus === "FAIL" && autoOpenMaintenance) {
    billboard = normalizeBillboard(
      {
        ...currentBillboard,
        enabled: true,
        message:
          currentBillboard.message ||
          "Scheduled midnight reliability lane detected failures. Maintenance is active while remediation is in progress.",
        source: "reliability_lane",
        actor: "omar-daemon",
        openedAt: currentBillboard.openedAt || normalizedNow,
        resolvedAt: null,
        lastUpdatedAt: normalizedNow,
      },
      normalizedNow
    );
  }
  if (
    overallStatus === "PASS" &&
    clearMaintenanceOnPass &&
    currentBillboard.enabled &&
    normalizeString(currentBillboard.source) === "reliability_lane"
  ) {
    billboard = normalizeBillboard(
      {
        ...currentBillboard,
        enabled: false,
        resolvedAt: normalizedNow,
        lastUpdatedAt: normalizedNow,
      },
      normalizedNow
    );
  }

  const runId = createReliabilityRunId(normalizedNow, region);
  const runPath = path.join(storage.runsDir, `${runId}.json`);
  const runPayload = {
    schemaVersion: RELIABILITY_SCHEMA_VERSION,
    generatedAt: normalizedNow,
    runId,
    lane: "midnight_reliability",
    region: normalizeString(region) || "us-east-1",
    timezone: normalizeString(timezone) || "UTC",
    overallStatus,
    checkCount: checkResults.length,
    failureCount: failureResults.length,
    checks: checkResults,
    configSnapshot: config,
    maintenance: billboard,
    worker: workerRun
      ? {
          runId: workerRun.runId,
          runPath: path.relative(storage.outputRoot, workerRun.runPath).replace(/\\/g, "/"),
          processedCount: workerRun.processedCount,
          queuedCount: workerRun.queuedCount,
          dedupedCount: workerRun.dedupedCount,
          queueDepth: workerRun.queueDepth,
        }
      : null,
  };

  await fsp.mkdir(storage.runsDir, { recursive: true });
  await Promise.all([
    writeJsonFile(storage.configPath, config),
    writeJsonFile(storage.billboardPath, billboard),
    writeJsonFile(runPath, runPayload),
    appendJsonLine(storage.eventsPath, {
      timestamp: normalizedNow,
      eventType: "reliability_run",
      runId,
      region: runPayload.region,
      timezone: runPayload.timezone,
      overallStatus,
      checkCount: checkResults.length,
      failureCount: failureResults.length,
      maintenanceEnabled: billboard.enabled,
    }),
  ]);

  return {
    ...storage,
    runId,
    runPath,
    overallStatus,
    checkCount: checkResults.length,
    failureCount: failureResults.length,
    checks: checkResults,
    maintenance: billboard,
    worker: runPayload.worker,
  };
}
