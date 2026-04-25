import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildArtifactLineageIndex, verifyArtifactChain } from "../daemon/artifact-lineage.js";
import { collectCodebaseIngest } from "../ingest/engine.js";
import { computeSessionAnalytics } from "./analytics.js";
import { resolveSessionPaths, resolveSessionsRoot } from "./paths.js";
import { appendToStream } from "./stream.js";

const SESSION_SCHEMA_VERSION = "1.0.0";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const RENEWAL_SECONDS = 24 * 60 * 60;
const MAX_SESSION_LIFETIME_SECONDS = 72 * 60 * 60;
const SESSION_STATUS_ACTIVE = "active";
const SESSION_STATUS_EXPIRED = "expired";
const SESSION_STATUS_ARCHIVED = "archived";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Value must be a positive integer.");
  }
  return Math.floor(normalized);
}

function normalizeNonNegativeInteger(value, fallbackValue = 0) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallbackValue;
  }
  return Math.floor(normalized);
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

function toIsoAfterSeconds(nowIso, seconds) {
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso));
  return new Date(nowEpoch + seconds * 1000).toISOString();
}

function buildElapsedTimer(fromIso, nowIso = new Date().toISOString()) {
  const fromEpoch = Date.parse(normalizeIsoTimestamp(fromIso, nowIso));
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  if (!Number.isFinite(fromEpoch) || !Number.isFinite(nowEpoch) || nowEpoch <= fromEpoch) {
    return "0m";
  }
  const totalSeconds = Math.floor((nowEpoch - fromEpoch) / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return `${Math.max(0, minutes)}m`;
  }
  return `${hours}h ${minutes}m`;
}

async function readJsonFile(filePath, { allowMissing = true } = {}) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (
      allowMissing &&
      error &&
      typeof error === "object" &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  await fsp.rename(tmpPath, filePath);
}

function normalizeCodebaseContext(ingest = {}) {
  return {
    summary:
      ingest && typeof ingest.summary === "object" && ingest.summary
        ? {
            filesScanned: Number(ingest.summary.filesScanned || 0),
            directoriesScanned: Number(ingest.summary.directoriesScanned || 0),
            totalLoc: Number(ingest.summary.totalLoc || 0),
            totalBytes: Number(ingest.summary.totalBytes || 0),
          }
        : {
            filesScanned: 0,
            directoriesScanned: 0,
            totalLoc: 0,
            totalBytes: 0,
          },
    frameworks: Array.isArray(ingest.frameworks) ? [...ingest.frameworks] : [],
    entryPoints: Array.isArray(ingest.entryPoints) ? [...ingest.entryPoints] : [],
    riskSurfaces: Array.isArray(ingest.riskSurfaces) ? [...ingest.riskSurfaces] : [],
  };
}

function normalizeStringList(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value))
        .filter(Boolean)
    )
  );
}

function toPosixPath(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function toRelativePosix(baseDir, absolutePath) {
  if (!absolutePath) {
    return "";
  }
  return toPosixPath(path.relative(baseDir, absolutePath));
}

function normalizeDateKeyFromCloseoutPath(closeoutPath = "", fallbackIso = new Date().toISOString()) {
  const normalized = toPosixPath(closeoutPath);
  const match = /\/observability\/(\d{4}-\d{2}-\d{2})\//.exec(`/${normalized}`);
  if (match) {
    return match[1];
  }
  return normalizeIsoTimestamp(fallbackIso).slice(0, 10);
}

function normalizeSharedResources(raw = {}, { nowIso = new Date().toISOString() } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    provisionedIdentityIds: normalizeStringList(source.provisionedIdentityIds),
    provisioningTags: normalizeStringList(source.provisioningTags),
    provisionCount: normalizeNonNegativeInteger(source.provisionCount, 0),
    lastProvisionedAt: source.lastProvisionedAt
      ? normalizeIsoTimestamp(source.lastProvisionedAt, nowIso)
      : null,
    updatedAt: normalizeIsoTimestamp(source.updatedAt, nowIso),
  };
}

function normalizeTemplateAgent(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    role: normalizeString(source.role) || "agent",
    instructions: normalizeString(source.instructions) || "Follow session guidance.",
  };
}

function normalizeSessionTemplate(raw = null) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw;
  const id = normalizeString(source.id || source.name);
  if (!id) {
    return null;
  }
  const suggestedAgents = Array.isArray(source.suggestedAgents)
    ? source.suggestedAgents.map((agent) => normalizeTemplateAgent(agent))
    : [];
  const ttlHours = normalizePositiveInteger(source.ttlHours, 1);
  const normalizedAutoProvision =
    source.autoProvisionEmails === undefined || source.autoProvisionEmails === null
      ? null
      : normalizePositiveInteger(source.autoProvisionEmails, 1);

  return {
    id,
    version: normalizeString(source.version) || "1.0.0",
    registryVersion: normalizeString(source.registryVersion) || "1.0.0",
    description: normalizeString(source.description),
    daemonModel: normalizeString(source.daemonModel),
    ttlHours,
    autoProvisionEmails: normalizedAutoProvision,
    suggestedAgents,
  };
}

async function collectSessionCodebaseContext(targetPath) {
  const cachedIngestPath = path.join(targetPath, ".sentinelayer", "CODEBASE_INGEST.json");
  const cachedIngest = await readJsonFile(cachedIngestPath, { allowMissing: true });
  if (cachedIngest && typeof cachedIngest === "object") {
    return normalizeCodebaseContext(cachedIngest);
  }
  const ingest = await collectCodebaseIngest({ rootPath: targetPath });
  return normalizeCodebaseContext(ingest);
}

async function buildArchiveSidecars(
  sessionId,
  {
    targetPath,
    outputDir = "",
    env,
    homeDir,
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());

  const analytics = await computeSessionAnalytics(normalizedSessionId, {
    targetPath: normalizedTargetPath,
    outputDir,
    env,
    homeDir,
    nowIso: normalizedNow,
  });
  const lineage = await buildArtifactLineageIndex({
    targetPath: normalizedTargetPath,
    outputDir,
    env,
    homeDir,
    nowIso: normalizedNow,
  });

  const sessionWorkItems = Array.isArray(lineage.workItems)
    ? lineage.workItems.filter(
        (item) => normalizeString(item?.links?.sessionId) === normalizedSessionId
      )
    : [];
  const verification = [];

  for (const workItem of sessionWorkItems) {
    const workItemId = normalizeString(workItem.workItemId);
    if (!workItemId) {
      continue;
    }
    const closeoutPath = normalizeString(workItem?.artifacts?.closeoutPath);
    const dateKey = normalizeDateKeyFromCloseoutPath(closeoutPath, normalizedNow);
    const chain = await verifyArtifactChain({
      workItemId,
      date: dateKey,
      targetPath: normalizedTargetPath,
      outputDir,
      env,
      homeDir,
    });
    verification.push({
      workItemId,
      date: chain.date,
      closeoutPath: closeoutPath || null,
      closeoutAnchorSha256: normalizeString(workItem?.artifacts?.closeoutAnchorSha256) || null,
      valid: chain.valid,
      mismatchCount: Array.isArray(chain.mismatches) ? chain.mismatches.length : 0,
      mismatches: Array.isArray(chain.mismatches) ? chain.mismatches : [],
    });
    if (!chain.valid) {
      throw new Error(
        `Artifact chain verification failed for work item '${workItemId}' (${dateKey}).`
      );
    }
  }

  const analyticsSidecar = {
    schemaVersion: "1.0.0",
    generatedAt: normalizedNow,
    sessionId: normalizedSessionId,
    metrics: analytics,
  };
  const artifactChainSidecar = {
    schemaVersion: "1.0.0",
    generatedAt: normalizedNow,
    sessionId: normalizedSessionId,
    lineageRunId: normalizeString(lineage.lineageRunId) || null,
    lineageIndexPath: toRelativePosix(
      normalizedTargetPath,
      normalizeString(lineage.indexPath)
    ) || null,
    summary: {
      totalWorkItemsIndexed: Number(lineage?.summary?.totalWorkItemsIndexed || 0),
      sessionWorkItems: sessionWorkItems.length,
      verifiedWorkItems: verification.filter((item) => item.valid).length,
    },
    workItems: verification,
  };

  return {
    analyticsSidecar,
    artifactChainSidecar,
  };
}

function normalizeSessionStatus(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === SESSION_STATUS_EXPIRED) return SESSION_STATUS_EXPIRED;
  if (normalized === SESSION_STATUS_ARCHIVED) return SESSION_STATUS_ARCHIVED;
  return SESSION_STATUS_ACTIVE;
}

function normalizeMetadata(raw = {}, { sessionId, targetPath, nowIso } = {}) {
  const createdAt = normalizeIsoTimestamp(raw.createdAt, nowIso);
  const ttlSeconds = normalizePositiveInteger(raw.ttlSeconds, DEFAULT_TTL_SECONDS);
  const expiresAt = normalizeIsoTimestamp(raw.expiresAt, toIsoAfterSeconds(createdAt, ttlSeconds));
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: normalizeString(raw.sessionId) || sessionId,
    targetPath: path.resolve(normalizeString(raw.targetPath) || targetPath),
    createdAt,
    updatedAt: normalizeIsoTimestamp(raw.updatedAt, nowIso),
    expiresAt,
    ttlSeconds,
    renewalCount: Math.max(0, Number(raw.renewalCount || 0)),
    maxLifetimeSeconds: normalizePositiveInteger(raw.maxLifetimeSeconds, MAX_SESSION_LIFETIME_SECONDS),
    status: normalizeSessionStatus(raw.status),
    lastInteractionAt: normalizeIsoTimestamp(raw.lastInteractionAt, createdAt),
    expiredAt: raw.expiredAt ? normalizeIsoTimestamp(raw.expiredAt, nowIso) : null,
    archivedAt: raw.archivedAt ? normalizeIsoTimestamp(raw.archivedAt, nowIso) : null,
    s3Path: normalizeString(raw.s3Path) || null,
    archiveStatus: normalizeString(raw.archiveStatus) || "pending",
    codebaseContext: normalizeCodebaseContext(raw.codebaseContext || {}),
    sharedResources: normalizeSharedResources(raw.sharedResources || {}, { nowIso }),
    template: normalizeSessionTemplate(raw.template || null),
  };
}

function isExpired(metadata, nowIso = new Date().toISOString()) {
  if (!metadata || normalizeSessionStatus(metadata.status) === SESSION_STATUS_EXPIRED) {
    return true;
  }
  const expiryEpoch = Date.parse(normalizeIsoTimestamp(metadata.expiresAt, nowIso));
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  if (!Number.isFinite(expiryEpoch) || !Number.isFinite(nowEpoch)) {
    return false;
  }
  return nowEpoch >= expiryEpoch;
}

function buildSessionPayload(metadata, paths, nowIso = new Date().toISOString()) {
  return {
    sessionId: metadata.sessionId,
    sessionDir: paths.sessionDir,
    metadataPath: paths.metadataPath,
    streamPath: paths.streamPath,
    createdAt: metadata.createdAt,
    expiresAt: metadata.expiresAt,
    elapsedTimer: buildElapsedTimer(metadata.createdAt, nowIso),
    renewalCount: metadata.renewalCount,
    status: metadata.status,
    archivedAt: metadata.archivedAt,
    s3Path: metadata.s3Path,
    codebaseContext: metadata.codebaseContext,
    sharedResources: metadata.sharedResources,
    template: metadata.template,
  };
}

async function loadMetadata(sessionId, { targetPath = process.cwd() } = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const paths = resolveSessionPaths(sessionId, { targetPath: resolvedTargetPath });
  const nowIso = new Date().toISOString();
  const raw = await readJsonFile(paths.metadataPath, { allowMissing: true });
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const metadata = normalizeMetadata(raw, {
    sessionId: paths.sessionId,
    targetPath: resolvedTargetPath,
    nowIso,
  });
  return { metadata, paths, targetPath: resolvedTargetPath };
}

async function saveMetadata(metadata, paths) {
  const normalized = normalizeMetadata(metadata, {
    sessionId: paths.sessionId,
    targetPath: metadata.targetPath,
    nowIso: new Date().toISOString(),
  });
  await writeJsonFile(paths.metadataPath, normalized);
  return normalized;
}

export async function createSession({
  targetPath = process.cwd(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
  template = null,
} = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedTtlSeconds = normalizePositiveInteger(ttlSeconds, DEFAULT_TTL_SECONDS);
  const sessionId = randomUUID();
  const nowIso = new Date().toISOString();
  const paths = resolveSessionPaths(sessionId, { targetPath: resolvedTargetPath });
  const codebaseContext = await collectSessionCodebaseContext(resolvedTargetPath);

  const metadata = normalizeMetadata(
    {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId,
      targetPath: resolvedTargetPath,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: toIsoAfterSeconds(nowIso, normalizedTtlSeconds),
      ttlSeconds: normalizedTtlSeconds,
      renewalCount: 0,
      maxLifetimeSeconds: MAX_SESSION_LIFETIME_SECONDS,
      status: SESSION_STATUS_ACTIVE,
      lastInteractionAt: nowIso,
      expiredAt: null,
      archivedAt: null,
      s3Path: null,
      archiveStatus: "pending",
      codebaseContext,
      sharedResources: normalizeSharedResources({}, { nowIso }),
      template: normalizeSessionTemplate(template),
    },
    {
      sessionId,
      targetPath: resolvedTargetPath,
      nowIso,
    }
  );

  await fsp.mkdir(paths.agentsDir, { recursive: true });
  await saveMetadata(metadata, paths);
  await fsp.writeFile(paths.streamPath, "", { encoding: "utf-8", flag: "a" });

  return buildSessionPayload(metadata, paths, nowIso);
}

export async function getSession(sessionId, { targetPath = process.cwd() } = {}) {
  const loaded = await loadMetadata(sessionId, { targetPath });
  if (!loaded) {
    return null;
  }
  return buildSessionPayload(loaded.metadata, loaded.paths);
}

export async function listActiveSessions({ targetPath = process.cwd() } = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const sessionsRoot = resolveSessionsRoot({ targetPath: resolvedTargetPath });
  let entries = [];
  try {
    entries = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const loaded = await loadMetadata(entry.name, { targetPath: resolvedTargetPath });
    if (!loaded) continue;
    if (isExpired(loaded.metadata)) continue;
    if (loaded.metadata.status === SESSION_STATUS_ARCHIVED) continue;
    sessions.push(buildSessionPayload(loaded.metadata, loaded.paths));
  }

  sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return sessions;
}

/**
 * List every session known to the local cache. Unlike
 * `listActiveSessions`, this includes archived AND expired sessions so
 * the CLI can surface past conversations the way ChatGPT exposes its
 * left-rail history.
 *
 * Each entry carries `archiveStatus` (`"active"` | `"archived"` |
 * `"expired"`) so the consumer can group/filter without re-deriving
 * lifecycle from the raw timestamps.
 *
 * @param {{targetPath?: string}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function listAllSessions({ targetPath = process.cwd() } = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const sessionsRoot = resolveSessionsRoot({ targetPath: resolvedTargetPath });
  let entries = [];
  try {
    entries = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const loaded = await loadMetadata(entry.name, { targetPath: resolvedTargetPath });
    if (!loaded) continue;

    const payload = buildSessionPayload(loaded.metadata, loaded.paths);
    let archiveStatus = "active";
    if (loaded.metadata.status === SESSION_STATUS_ARCHIVED) {
      archiveStatus = "archived";
    } else if (isExpired(loaded.metadata)) {
      archiveStatus = "expired";
    }
    sessions.push({ ...payload, archiveStatus });
  }

  sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return sessions;
}

export async function renewSession(sessionId, { targetPath = process.cwd() } = {}) {
  const loaded = await loadMetadata(sessionId, { targetPath });
  if (!loaded) {
    throw new Error(`Session '${sessionId}' was not found.`);
  }

  const nowIso = new Date().toISOString();
  const createdEpoch = Date.parse(normalizeIsoTimestamp(loaded.metadata.createdAt, nowIso));
  const expiresEpoch = Date.parse(normalizeIsoTimestamp(loaded.metadata.expiresAt, nowIso));
  if (!Number.isFinite(createdEpoch) || !Number.isFinite(expiresEpoch)) {
    throw new Error(`Session '${sessionId}' has invalid timestamps.`);
  }

  const maxExpiryEpoch = createdEpoch + loaded.metadata.maxLifetimeSeconds * 1000;
  const nextExpiryEpoch = Math.min(expiresEpoch + RENEWAL_SECONDS * 1000, maxExpiryEpoch);
  if (nextExpiryEpoch <= expiresEpoch) {
    return buildSessionPayload(loaded.metadata, loaded.paths, nowIso);
  }

  loaded.metadata.expiresAt = new Date(nextExpiryEpoch).toISOString();
  loaded.metadata.renewalCount = Math.max(0, Number(loaded.metadata.renewalCount || 0)) + 1;
  loaded.metadata.updatedAt = nowIso;
  loaded.metadata.lastInteractionAt = nowIso;
  loaded.metadata.status = SESSION_STATUS_ACTIVE;
  loaded.metadata.expiredAt = null;

  const saved = await saveMetadata(loaded.metadata, loaded.paths);

  try {
    await appendToStream(
      loaded.paths.sessionId,
      {
        event: "daemon_alert",
        agentId: "senti",
        payload: {
          alert: "session_renewed",
          expiresAt: saved.expiresAt,
          renewalCount: saved.renewalCount,
        },
        ts: nowIso,
      },
      { targetPath: loaded.targetPath }
    );
  } catch {
    // Renewal should not fail if stream event persistence is unavailable.
  }

  return buildSessionPayload(saved, loaded.paths, nowIso);
}

export async function expireSession(sessionId, { targetPath = process.cwd() } = {}) {
  const loaded = await loadMetadata(sessionId, { targetPath });
  if (!loaded) {
    throw new Error(`Session '${sessionId}' was not found.`);
  }
  const nowIso = new Date().toISOString();
  loaded.metadata.status = SESSION_STATUS_EXPIRED;
  loaded.metadata.expiredAt = nowIso;
  loaded.metadata.updatedAt = nowIso;
  const saved = await saveMetadata(loaded.metadata, loaded.paths);
  return buildSessionPayload(saved, loaded.paths, nowIso);
}

export async function archiveSession(
  sessionId,
  {
    s3Bucket,
    s3Prefix = "",
    targetPath = process.cwd(),
    outputDir = "",
    env,
    homeDir,
  } = {}
) {
  const loaded = await loadMetadata(sessionId, { targetPath });
  if (!loaded) {
    throw new Error(`Session '${sessionId}' was not found.`);
  }
  const normalizedBucket = normalizeString(s3Bucket);
  if (!normalizedBucket) {
    throw new Error("archiveSession requires s3Bucket.");
  }
  const normalizedPrefix = normalizeString(s3Prefix).replace(/^\/+|\/+$/g, "");
  const prefixSegment = normalizedPrefix ? `${normalizedPrefix}/` : "";
  const s3Path = `s3://${normalizedBucket}/${prefixSegment}sessions/${loaded.paths.sessionId}/`;
  const nowIso = new Date().toISOString();
  const sidecars = await buildArchiveSidecars(loaded.paths.sessionId, {
    targetPath: loaded.targetPath,
    outputDir,
    env,
    homeDir,
    nowIso,
  });

  loaded.metadata.status = SESSION_STATUS_ARCHIVED;
  loaded.metadata.archivedAt = nowIso;
  loaded.metadata.updatedAt = nowIso;
  loaded.metadata.archiveStatus = "archived";
  loaded.metadata.s3Path = s3Path;
  const saved = await saveMetadata(loaded.metadata, loaded.paths);

  await Promise.all([
    writeJsonFile(path.join(loaded.paths.sessionDir, "analytics.json"), sidecars.analyticsSidecar),
    writeJsonFile(
      path.join(loaded.paths.sessionDir, "artifact-chain.json"),
      sidecars.artifactChainSidecar
    ),
  ]);
  await writeJsonFile(path.join(loaded.paths.sessionDir, "archive-manifest.json"), {
    sessionId: loaded.paths.sessionId,
    archivedAt: nowIso,
    s3Path,
    files: [
      "metadata.json",
      "stream.ndjson",
      "stream.1.ndjson",
      "agents/",
      "analytics.json",
      "artifact-chain.json",
    ],
  });

  return buildSessionPayload(saved, loaded.paths, nowIso);
}

// Emit analytics.json + artifact-chain.json for a live session without archiving.
// Callers should invoke this on a timer (spec §PR 10 line 1451: "S3 archive
// carries analytics.json sidecar" + line 1452-1453: closeout.json observability
// invariant — mid-flight observability requires the sidecar on disk too).
// Safe to call frequently; the payload is idempotent per (sessionId, nowIso).
export async function persistSessionSidecarsSnapshot(
  sessionId,
  {
    targetPath = process.cwd(),
    outputDir = "",
    env = process.env,
    homeDir,
    nowIso = new Date().toISOString(),
  } = {}
) {
  const loaded = await loadMetadata(sessionId, { targetPath });
  if (!loaded) {
    throw new Error(`Session '${sessionId}' was not found.`);
  }
  const sidecars = await buildArchiveSidecars(loaded.paths.sessionId, {
    targetPath: loaded.targetPath,
    outputDir,
    env,
    homeDir,
    nowIso,
  });
  await Promise.all([
    writeJsonFile(path.join(loaded.paths.sessionDir, "analytics.json"), sidecars.analyticsSidecar),
    writeJsonFile(
      path.join(loaded.paths.sessionDir, "artifact-chain.json"),
      sidecars.artifactChainSidecar
    ),
  ]);
  return {
    sessionId: loaded.paths.sessionId,
    analyticsSidecar: sidecars.analyticsSidecar,
    artifactChainSidecar: sidecars.artifactChainSidecar,
  };
}

export async function recordSessionProvisionedIdentities(
  sessionId,
  { targetPath = process.cwd(), identityIds = [], tags = [] } = {}
) {
  const loaded = await loadMetadata(sessionId, { targetPath });
  if (!loaded) {
    throw new Error(`Session '${sessionId}' was not found.`);
  }

  const nowIso = new Date().toISOString();
  const normalizedIdentityIds = normalizeStringList(identityIds);
  if (normalizedIdentityIds.length === 0) {
    return buildSessionPayload(loaded.metadata, loaded.paths, nowIso);
  }

  const existingSharedResources = normalizeSharedResources(loaded.metadata.sharedResources || {}, {
    nowIso,
  });
  const mergedIdentityIds = normalizeStringList([
    ...existingSharedResources.provisionedIdentityIds,
    ...normalizedIdentityIds,
  ]);
  const mergedTags = normalizeStringList([
    ...existingSharedResources.provisioningTags,
    ...normalizeStringList(tags),
  ]);

  loaded.metadata.sharedResources = normalizeSharedResources(
    {
      ...existingSharedResources,
      provisionedIdentityIds: mergedIdentityIds,
      provisioningTags: mergedTags,
      provisionCount:
        normalizeNonNegativeInteger(existingSharedResources.provisionCount, 0) +
        normalizedIdentityIds.length,
      lastProvisionedAt: nowIso,
      updatedAt: nowIso,
    },
    { nowIso }
  );
  loaded.metadata.updatedAt = nowIso;
  loaded.metadata.lastInteractionAt = nowIso;
  loaded.metadata.status = SESSION_STATUS_ACTIVE;

  const saved = await saveMetadata(loaded.metadata, loaded.paths);
  return buildSessionPayload(saved, loaded.paths, nowIso);
}

export {
  DEFAULT_TTL_SECONDS,
  MAX_SESSION_LIFETIME_SECONDS,
  RENEWAL_SECONDS,
};
