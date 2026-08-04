import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  SentinelayerApiError,
  requestJson,
  requestJsonMutation,
} from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { resolveSessionPaths } from "./paths.js";

const FILE_LEASE_CAPABILITY_SCHEMA_VERSION = "1.0.0";
const DEFAULT_FILE_LOCK_TTL_SECONDS = 300;
const MIN_FILE_LOCK_TTL_SECONDS = 15;
const MAX_FILE_LOCK_TTL_SECONDS = 3_600;
const DEFAULT_CAPABILITY_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_CAPABILITY_LOCK_STALE_MS = 30_000;
const DEFAULT_CAPABILITY_LOCK_POLL_MS = 25;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[/\\]/;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSessionId(value) {
  const normalized = normalizeString(value);
  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(
      "sessionId must be 1-64 repository-safe letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return normalized;
}

function normalizeAgentId(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!AGENT_ID_PATTERN.test(normalized)) {
    throw new Error("agentId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$.");
  }
  return normalized;
}

function normalizeTtlSeconds(value) {
  const normalized =
    value === undefined || value === null || normalizeString(value) === ""
      ? DEFAULT_FILE_LOCK_TTL_SECONDS
      : Number(value);
  if (
    !Number.isInteger(normalized) ||
    normalized < MIN_FILE_LOCK_TTL_SECONDS ||
    normalized > MAX_FILE_LOCK_TTL_SECONDS
  ) {
    throw new Error(
      `ttlSeconds must be an integer between ${MIN_FILE_LOCK_TTL_SECONDS} and ${MAX_FILE_LOCK_TTL_SECONDS}.`,
    );
  }
  return normalized;
}

function normalizeBoundedText(value, { field, maxLength }) {
  const normalized = normalizeString(value);
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${field} must not contain control characters.`);
  }
  return normalized;
}

function normalizeApiUrl(value) {
  const normalized = normalizeString(value).replace(/\/+$/u, "");
  if (!normalized) {
    throw new Error("Sentinelayer API URL is unavailable.");
  }
  return normalized;
}

function normalizeFilePath(filePath, { targetPath = process.cwd() } = {}) {
  const raw = normalizeString(filePath).normalize("NFC");
  if (!raw) {
    throw new Error("filePath is required.");
  }
  if (raw.length > 1_024) {
    throw new Error("filePath must be 1024 characters or fewer.");
  }
  if (/[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error("filePath must not contain control characters.");
  }

  const workspaceRoot = path.resolve(String(targetPath || "."));
  let candidate = raw;
  if (path.isAbsolute(raw)) {
    const relative = path.relative(workspaceRoot, path.resolve(raw));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("filePath must resolve to a file inside the workspace.");
    }
    candidate = relative;
  } else if (raw.startsWith(("/", "\\")) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(raw)) {
    throw new Error("filePath must be repository-relative.");
  }

  const segments = [];
  for (const segment of candidate.replace(/\\/gu, "/").split("/")) {
    const normalizedSegment = segment.normalize("NFC");
    if (!normalizedSegment || normalizedSegment === ".") {
      continue;
    }
    if (normalizedSegment === "..") {
      throw new Error("filePath must not traverse outside the workspace.");
    }
    segments.push(normalizedSegment);
  }
  const normalized = segments.join("/");
  if (!normalized) {
    throw new Error("filePath is required.");
  }
  if (normalized.length > 1_024) {
    throw new Error("normalized filePath must be 1024 characters or fewer.");
  }
  return normalized;
}

async function resolveRealPathThroughNearestAncestor(absolutePath) {
  let cursor = path.resolve(absolutePath);
  const missingSegments = [];
  while (true) {
    try {
      const realAncestor = await fsp.realpath(cursor);
      return path.join(realAncestor, ...missingSegments);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !["ENOENT", "ENOTDIR"].includes(error.code)
      ) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error("Unable to resolve filePath through an existing workspace ancestor.", {
          cause: error,
        });
      }
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function canonicalizeFilePath(
  filePath,
  { targetPath = process.cwd() } = {},
) {
  const workspaceRoot = path.resolve(String(targetPath || "."));
  const realWorkspaceRoot = await fsp.realpath(workspaceRoot);
  const lexicalPath = normalizeFilePath(filePath, { targetPath: workspaceRoot });
  const realCandidate = await resolveRealPathThroughNearestAncestor(
    path.join(workspaceRoot, ...lexicalPath.split("/")),
  );
  const relative = path.relative(realWorkspaceRoot, realCandidate);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      "filePath resolves through a symlink or junction outside the workspace.",
    );
  }
  return normalizeFilePath(relative, { targetPath: realWorkspaceRoot });
}

function pathKey(value) {
  return normalizeString(value).normalize("NFC").toLowerCase().replace(/\/+$/u, "");
}

function fileLeasePathCovers(leasePath, targetPath) {
  const lease = pathKey(leasePath);
  const target = pathKey(targetPath);
  return Boolean(lease && target && (target === lease || target.startsWith(`${lease}/`)));
}

function fileLeasePathsOverlap(leftPath, rightPath) {
  return fileLeasePathCovers(leftPath, rightPath) || fileLeasePathCovers(rightPath, leftPath);
}

function parseEpoch(value) {
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSince(fromIso, nowMs = Date.now()) {
  const fromMs = parseEpoch(fromIso);
  const deltaSeconds = Math.max(0, Math.floor((nowMs - fromMs) / 1_000));
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  return `${Math.floor(deltaHours / 24)}d ago`;
}

function presentLease(rawLease = {}) {
  const source = rawLease && typeof rawLease === "object" ? rawLease : {};
  const file = normalizeString(source.path || source.file || source.filePath);
  const agentId = normalizeString(source.holderId || source.agentId).toLowerCase();
  const lockedAt = normalizeString(source.acquiredAt || source.lockedAt);
  const ttlSeconds = Number(source.ttlSeconds);
  const revision = Number(source.revision);
  return {
    leaseId: normalizeString(source.leaseId || source.id) || null,
    sessionId: normalizeString(source.sessionId) || null,
    file,
    path: file,
    agentId,
    heldBy: agentId,
    intent: normalizeString(source.intent),
    status: normalizeString(source.status) || "active",
    lockedAt: lockedAt || null,
    acquiredAt: lockedAt || null,
    renewedAt: normalizeString(source.renewedAt) || null,
    expiresAt: normalizeString(source.expiresAt) || null,
    releasedAt: normalizeString(source.releasedAt) || null,
    releaseReason: normalizeString(source.releaseReason) || null,
    ttlSeconds: Number.isInteger(ttlSeconds) ? ttlSeconds : DEFAULT_FILE_LOCK_TTL_SECONDS,
    revision: Number.isInteger(revision) ? revision : 1,
    since: lockedAt ? formatSince(lockedAt) : null,
  };
}

function newCapabilityToken() {
  return randomBytes(32).toString("base64url");
}

function normalizeCapabilityClaim(raw, { sessionId } = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const leaseId = normalizeString(source.leaseId);
  const claimSessionId = normalizeSessionId(source.sessionId || sessionId);
  const holderId = normalizeAgentId(source.holderId);
  const claimPath = normalizeFilePath(source.path, { targetPath: "." });
  const leaseToken = normalizeString(source.leaseToken);
  if (!leaseId || !/^[0-9a-f-]{36}$/iu.test(leaseId)) {
    throw new Error("File-lease capability cache contains an invalid lease id.");
  }
  if (!LEASE_TOKEN_PATTERN.test(leaseToken)) {
    throw new Error("File-lease capability cache contains an invalid capability token.");
  }
  return {
    leaseId,
    sessionId: claimSessionId,
    path: claimPath,
    holderId,
    leaseToken,
    expiresAt: normalizeString(source.expiresAt) || null,
    ttlSeconds: normalizeTtlSeconds(source.ttlSeconds),
    revision: Math.max(1, Math.floor(Number(source.revision) || 1)),
    updatedAt: normalizeString(source.updatedAt) || new Date().toISOString(),
  };
}

function emptyCapabilityStore(sessionId) {
  return {
    schemaVersion: FILE_LEASE_CAPABILITY_SCHEMA_VERSION,
    authoritative: false,
    sessionId,
    updatedAt: new Date().toISOString(),
    claims: [],
  };
}

async function readCapabilityStore(sessionId, { targetPath = process.cwd() } = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const paths = resolveSessionPaths(normalizedSessionId, { targetPath });
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(paths.fileLeaseCapabilitiesPath, "utf-8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return emptyCapabilityStore(normalizedSessionId);
    }
    if (error instanceof SyntaxError) {
      throw new Error(
        "File-lease capability cache is corrupt; refusing to bypass the authoritative guard.",
        { cause: error },
      );
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("File-lease capability cache has an invalid root object.");
  }
  if (parsed.authoritative !== false) {
    throw new Error("File-lease capability cache must be explicitly non-authoritative.");
  }
  if (normalizeSessionId(parsed.sessionId) !== normalizedSessionId) {
    throw new Error("File-lease capability cache belongs to a different session.");
  }
  if (!Array.isArray(parsed.claims)) {
    throw new Error("File-lease capability cache claims must be an array.");
  }
  return {
    schemaVersion: FILE_LEASE_CAPABILITY_SCHEMA_VERSION,
    authoritative: false,
    sessionId: normalizedSessionId,
    updatedAt: normalizeString(parsed.updatedAt) || new Date().toISOString(),
    claims: parsed.claims.map((claim) =>
      normalizeCapabilityClaim(claim, { sessionId: normalizedSessionId }),
    ),
  };
}

async function writeCapabilityStore(paths, store) {
  await fsp.mkdir(paths.sessionDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${paths.fileLeaseCapabilitiesPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    schemaVersion: FILE_LEASE_CAPABILITY_SCHEMA_VERSION,
    authoritative: false,
    sessionId: paths.sessionId,
    updatedAt: new Date().toISOString(),
    claims: store.claims,
  };
  try {
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fsp.chmod(tmpPath, 0o600).catch(() => {});
    await fsp.rename(tmpPath, paths.fileLeaseCapabilitiesPath);
    await fsp.chmod(paths.fileLeaseCapabilitiesPath, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function acquireCapabilityMutex(
  lockPath,
  {
    timeoutMs = DEFAULT_CAPABILITY_LOCK_TIMEOUT_MS,
    staleMs = DEFAULT_CAPABILITY_LOCK_STALE_MS,
    pollMs = DEFAULT_CAPABILITY_LOCK_POLL_MS,
  } = {},
) {
  const startedAt = Date.now();
  while (true) {
    try {
      await fsp.mkdir(lockPath, { recursive: false, mode: 0o700 });
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - Number(stat.mtimeMs || 0) > staleMs) {
          await fsp.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("Timed out waiting for the local file-lease capability cache.");
      }
      await sleep(pollMs);
    }
  }
}

async function mutateCapabilityStore(
  sessionId,
  { targetPath = process.cwd() } = {},
  mutator = async () => {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const paths = resolveSessionPaths(normalizedSessionId, { targetPath });
  await fsp.mkdir(paths.sessionDir, { recursive: true, mode: 0o700 });
  await acquireCapabilityMutex(paths.fileLeaseCapabilitiesLockPath);
  try {
    const store = await readCapabilityStore(normalizedSessionId, { targetPath });
    const result = await mutator(store);
    await writeCapabilityStore(paths, store);
    return result;
  } finally {
    await fsp.rm(paths.fileLeaseCapabilitiesLockPath, {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
}

function findExactClaim(claims, holderId, filePath) {
  const holder = normalizeAgentId(holderId);
  const targetKey = pathKey(filePath);
  return (
    claims.find(
      (claim) =>
        normalizeAgentId(claim.holderId) === holder && pathKey(claim.path) === targetKey,
    ) || null
  );
}

function findCoveringClaim(claims, holderId, filePath) {
  const holder = normalizeAgentId(holderId);
  return (
    claims
      .filter(
        (claim) =>
          normalizeAgentId(claim.holderId) === holder &&
          fileLeasePathCovers(claim.path, filePath),
      )
      .sort((left, right) => pathKey(right.path).length - pathKey(left.path).length)[0] || null
  );
}

async function saveCapabilityClaim(sessionId, claim, { targetPath = process.cwd() } = {}) {
  const normalized = normalizeCapabilityClaim(claim, { sessionId });
  await mutateCapabilityStore(
    sessionId,
    { targetPath },
    async (store) => {
      store.claims = store.claims.filter(
        (existing) =>
          existing.leaseId !== normalized.leaseId &&
          !(
            normalizeAgentId(existing.holderId) === normalized.holderId &&
            pathKey(existing.path) === pathKey(normalized.path)
          ),
      );
      store.claims.push(normalized);
    },
  );
  return normalized;
}

async function removeCapabilityClaims(
  sessionId,
  predicate,
  { targetPath = process.cwd() } = {},
) {
  return mutateCapabilityStore(
    sessionId,
    { targetPath },
    async (store) => {
      const removed = store.claims.filter(predicate);
      store.claims = store.claims.filter((claim) => !predicate(claim));
      return removed;
    },
  );
}

async function resolveLeaseApi({
  targetPath = process.cwd(),
  resolveAuthSession = resolveActiveAuthSession,
} = {}) {
  const auth = await resolveAuthSession({
    cwd: targetPath,
    env: process.env,
    autoRotate: false,
  });
  if (!auth?.token || !auth?.apiUrl) {
    throw new Error(
      "Authoritative session file leases require Sentinelayer auth. Run `sl auth login` first.",
    );
  }
  return {
    apiUrl: normalizeApiUrl(auth.apiUrl),
    headers: { Authorization: `Bearer ${auth.token}` },
  };
}

function leaseCollectionUrl(apiUrl, sessionId) {
  return `${apiUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/file-leases`;
}

function leaseMemberUrl(apiUrl, sessionId, leaseId, action) {
  return `${leaseCollectionUrl(apiUrl, sessionId)}/${encodeURIComponent(leaseId)}/${action}`;
}

async function listRemoteLeases(
  sessionId,
  {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    request = requestJson,
  } = {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const { apiUrl, headers } = await resolveLeaseApi({ targetPath, resolveAuthSession });
  const response = await request(leaseCollectionUrl(apiUrl, normalizedSessionId), {
    method: "GET",
    headers,
  });
  if (response?.authoritative !== true || !Array.isArray(response?.leases)) {
    throw new Error("File-lease authority returned an invalid list response; refusing local fallback.");
  }
  return response.leases.map((lease) => presentLease(lease));
}

async function guardRemoteClaims(
  sessionId,
  holderId,
  paths,
  claims,
  {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedHolderId = normalizeAgentId(holderId);
  const { apiUrl, headers } = await resolveLeaseApi({ targetPath, resolveAuthSession });
  const response = await requestMutation(
    `${leaseCollectionUrl(apiUrl, normalizedSessionId)}/guard`,
    {
      method: "POST",
      operationName: "session-file-lease-guard",
      headers,
      body: {
        holderId: normalizedHolderId,
        claims: paths.map((file, index) => ({
          path: file,
          leaseId: claims[index]?.leaseId || null,
          leaseToken: claims[index]?.leaseToken || null,
        })),
      },
      maxRetries: 1,
    },
  );
  if (
    response?.authoritative !== true ||
    typeof response?.allowed !== "boolean" ||
    normalizeString(response?.sessionId) !== normalizedSessionId ||
    normalizeString(response?.holderId).toLowerCase() !== normalizedHolderId ||
    !Array.isArray(response?.guarded) ||
    !Array.isArray(response?.denials)
  ) {
    throw new Error("File-lease authority returned an invalid guard response; edit blocked.");
  }
  if (
    response.allowed &&
    (response.denials.length > 0 || response.guarded.length !== paths.length)
  ) {
    throw new Error("File-lease authority returned an inconsistent allow decision; edit blocked.");
  }
  return {
    ...response,
    files: paths,
  };
}

export async function guardFileLeases(
  sessionId,
  agentId,
  filePaths,
  {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedAgentId = normalizeAgentId(agentId);
  const files = await Promise.all(
    (Array.isArray(filePaths) ? filePaths : [filePaths]).map((file) =>
      canonicalizeFilePath(file, { targetPath }),
    ),
  );
  if (files.length === 0) {
    throw new Error("At least one file path is required for the file-lease guard.");
  }
  const store = await readCapabilityStore(normalizedSessionId, { targetPath });
  const claims = files.map((file) =>
    findCoveringClaim(store.claims, normalizedAgentId, file),
  );
  return guardRemoteClaims(normalizedSessionId, normalizedAgentId, files, claims, {
    targetPath,
    resolveAuthSession,
    requestMutation,
  });
}

export async function lockFile(
  sessionId,
  agentId,
  filePath,
  {
    intent = "",
    ttlSeconds = DEFAULT_FILE_LOCK_TTL_SECONDS,
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    request = requestJson,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedFilePath = await canonicalizeFilePath(filePath, { targetPath });
  const normalizedIntent = normalizeBoundedText(intent, {
    field: "intent",
    maxLength: 512,
  });
  const normalizedTtlSeconds = normalizeTtlSeconds(ttlSeconds);
  const store = await readCapabilityStore(normalizedSessionId, { targetPath });
  const coveringClaim = findCoveringClaim(
    store.claims,
    normalizedAgentId,
    normalizedFilePath,
  );
  const exactClaim = findExactClaim(
    store.claims,
    normalizedAgentId,
    normalizedFilePath,
  );

  if (coveringClaim && !exactClaim) {
    const guard = await guardRemoteClaims(
      normalizedSessionId,
      normalizedAgentId,
      [normalizedFilePath],
      [coveringClaim],
      { targetPath, resolveAuthSession, requestMutation },
    );
    if (guard.allowed) {
      const lease = presentLease(guard.guarded[0]?.lease || {});
      return {
        locked: true,
        duplicate: true,
        inheritedScope: true,
        file: normalizedFilePath,
        lock: lease,
        lease,
      };
    }
  }

  const leaseToken = exactClaim?.leaseToken || newCapabilityToken();
  const { apiUrl, headers } = await resolveLeaseApi({ targetPath, resolveAuthSession });
  let response;
  try {
    response = await requestMutation(
      leaseCollectionUrl(apiUrl, normalizedSessionId),
      {
        method: "POST",
        operationName: "session-file-lease-acquire",
        headers,
        body: {
          path: normalizedFilePath,
          holderId: normalizedAgentId,
          leaseToken,
          ttlSeconds: normalizedTtlSeconds,
          intent: normalizedIntent || null,
        },
      },
    );
  } catch (error) {
    if (
      error instanceof SentinelayerApiError &&
      error.code === "FILE_LEASE_CONFLICT"
    ) {
      const leases = await listRemoteLeases(normalizedSessionId, {
        targetPath,
        resolveAuthSession,
        request,
      });
      const conflict =
        leases.find((lease) => fileLeasePathsOverlap(lease.file, normalizedFilePath)) ||
        null;
      return {
        locked: false,
        file: normalizedFilePath,
        reason:
          conflict?.agentId === normalizedAgentId
            ? "holder_capability_unavailable"
            : "held_by_other_agent",
        heldBy: conflict?.agentId || null,
        since: conflict?.since || null,
        lock: conflict,
      };
    }
    throw error;
  }
  if (
    response?.ok !== true
    || response?.authoritative !== true
    || !response?.lease
  ) {
    throw new Error("File-lease authority returned an invalid acquire response.");
  }
  const lease = presentLease(response.lease);
  if (
    !lease.leaseId ||
    pathKey(lease.file) !== pathKey(normalizedFilePath) ||
    lease.agentId !== normalizedAgentId
  ) {
    throw new Error("File-lease authority returned a mismatched acquire response.");
  }

  try {
    await saveCapabilityClaim(
      normalizedSessionId,
      {
        leaseId: lease.leaseId,
        sessionId: normalizedSessionId,
        path: lease.file,
        holderId: normalizedAgentId,
        leaseToken,
        expiresAt: lease.expiresAt,
        ttlSeconds: lease.ttlSeconds,
        revision: lease.revision,
        updatedAt: new Date().toISOString(),
      },
      { targetPath },
    );
  } catch (cacheError) {
    let compensated = false;
    try {
      const release = await requestMutation(
        leaseMemberUrl(apiUrl, normalizedSessionId, lease.leaseId, "release"),
        {
          method: "POST",
          operationName: "session-file-lease-acquire-compensation",
          headers,
          body: {
            holderId: normalizedAgentId,
            leaseToken,
            reason: "capability_cache_write_failed",
          },
        },
      );
      compensated = Boolean(
        release?.authoritative === true
        && (release?.released || release?.alreadyReleased || release?.expired),
      );
    } catch {
      compensated = false;
    }
    throw new Error(
      compensated
        ? "File lease was released because its local capability could not be stored."
        : "File-lease capability storage failed; edit blocked and the lease will expire by TTL.",
      { cause: cacheError },
    );
  }

  return {
    locked: true,
    duplicate: Boolean(response.duplicate),
    file: normalizedFilePath,
    lock: lease,
    lease,
  };
}

async function findClaimForRelease(sessionId, agentId, filePath, { targetPath }) {
  const store = await readCapabilityStore(sessionId, { targetPath });
  return findExactClaim(store.claims, agentId, filePath);
}

async function releaseCapabilityClaim(
  sessionId,
  agentId,
  claim,
  {
    reason,
    targetPath,
    resolveAuthSession,
    requestMutation,
  },
) {
  const { apiUrl, headers } = await resolveLeaseApi({ targetPath, resolveAuthSession });
  let response;
  try {
    response = await requestMutation(
      leaseMemberUrl(apiUrl, sessionId, claim.leaseId, "release"),
      {
        method: "POST",
        operationName: "session-file-lease-release",
        headers,
        body: {
          holderId: agentId,
          leaseToken: claim.leaseToken,
          reason,
        },
      },
    );
  } catch (error) {
    if (
      error instanceof SentinelayerApiError &&
      error.code === "FILE_LEASE_NOT_FOUND"
    ) {
      response = {
        ok: true,
        authoritative: true,
        released: false,
        alreadyReleased: true,
      };
    } else {
      throw error;
    }
  }
  if (response?.ok !== true || response?.authoritative !== true) {
    throw new Error("File-lease authority returned an invalid release response.");
  }
  await removeCapabilityClaims(
    sessionId,
    (existing) => existing.leaseId === claim.leaseId,
    { targetPath },
  );
  return response;
}

export async function unlockFile(
  sessionId,
  agentId,
  filePath,
  {
    reason = "manual_release",
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    request = requestJson,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedFilePath = await canonicalizeFilePath(filePath, { targetPath });
  const normalizedReason =
    normalizeBoundedText(reason || "manual_release", {
      field: "reason",
      maxLength: 128,
    }) || "manual_release";
  const claim = await findClaimForRelease(
    normalizedSessionId,
    normalizedAgentId,
    normalizedFilePath,
    { targetPath },
  );
  if (!claim) {
    const leases = await listRemoteLeases(normalizedSessionId, {
      targetPath,
      resolveAuthSession,
      request,
    });
    const exact = leases.find(
      (lease) => pathKey(lease.file) === pathKey(normalizedFilePath),
    );
    const covering = leases.find((lease) =>
      fileLeasePathCovers(lease.file, normalizedFilePath),
    );
    if (covering && pathKey(covering.file) !== pathKey(normalizedFilePath)) {
      return {
        unlocked: false,
        file: normalizedFilePath,
        reason: "covered_by_parent_scope",
        heldBy: covering.agentId,
        lock: covering,
      };
    }
    if (!exact) {
      return {
        unlocked: false,
        file: normalizedFilePath,
        reason: "not_locked",
      };
    }
    return {
      unlocked: false,
      file: normalizedFilePath,
      reason:
        exact.agentId === normalizedAgentId
          ? "holder_capability_unavailable"
          : "held_by_other_agent",
      heldBy: exact.agentId,
      since: exact.since,
      lock: exact,
    };
  }

  const response = await releaseCapabilityClaim(
    normalizedSessionId,
    normalizedAgentId,
    claim,
    {
      reason: normalizedReason,
      targetPath,
      resolveAuthSession,
      requestMutation,
    },
  );
  const lease = response.lease ? presentLease(response.lease) : null;
  return {
    unlocked: Boolean(response.released),
    file: normalizedFilePath,
    reason: response.released
      ? "unlocked"
      : response.expired
        ? "expired"
        : "already_released",
    lock: lease,
  };
}

export async function renewFileLease(
  sessionId,
  agentId,
  filePath,
  {
    ttlSeconds = DEFAULT_FILE_LOCK_TTL_SECONDS,
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedFilePath = await canonicalizeFilePath(filePath, { targetPath });
  const normalizedTtlSeconds = normalizeTtlSeconds(ttlSeconds);
  const store = await readCapabilityStore(normalizedSessionId, { targetPath });
  const claim = findCoveringClaim(
    store.claims,
    normalizedAgentId,
    normalizedFilePath,
  );
  if (!claim) {
    return {
      renewed: false,
      file: normalizedFilePath,
      reason: "holder_capability_unavailable",
    };
  }

  const { apiUrl, headers } = await resolveLeaseApi({ targetPath, resolveAuthSession });
  const response = await requestMutation(
    leaseMemberUrl(apiUrl, normalizedSessionId, claim.leaseId, "renew"),
    {
      method: "POST",
      operationName: "session-file-lease-renew",
      headers,
      body: {
        holderId: normalizedAgentId,
        leaseToken: claim.leaseToken,
        ttlSeconds: normalizedTtlSeconds,
      },
    },
  );
  if (
    response?.ok !== true
    || response?.authoritative !== true
    || response?.renewed !== true
    || !response?.lease
  ) {
    throw new Error("File-lease authority returned an invalid renew response.");
  }
  const lease = presentLease(response.lease);
  await saveCapabilityClaim(
    normalizedSessionId,
    {
      ...claim,
      path: lease.file,
      expiresAt: lease.expiresAt,
      ttlSeconds: lease.ttlSeconds,
      revision: lease.revision,
      updatedAt: new Date().toISOString(),
    },
    { targetPath },
  );
  return {
    renewed: true,
    file: normalizedFilePath,
    lease,
    lock: lease,
  };
}

export async function checkFileLock(
  sessionId,
  filePath,
  {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    request = requestJson,
  } = {},
) {
  const normalizedFilePath = await canonicalizeFilePath(filePath, { targetPath });
  const leases = await listRemoteLeases(sessionId, {
    targetPath,
    resolveAuthSession,
    request,
  });
  return (
    leases.find((lease) => fileLeasePathCovers(lease.file, normalizedFilePath)) ||
    leases.find((lease) => fileLeasePathsOverlap(lease.file, normalizedFilePath)) ||
    null
  );
}

export async function listFileLocks(
  sessionId,
  {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    request = requestJson,
  } = {},
) {
  return listRemoteLeases(sessionId, {
    targetPath,
    resolveAuthSession,
    request,
  });
}

export async function releaseFileLocksForAgent(
  sessionId,
  agentId,
  {
    reason = "agent_killed",
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    request = requestJson,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedReason =
    normalizeBoundedText(reason || "agent_killed", {
      field: "reason",
      maxLength: 128,
    }) || "agent_killed";
  const store = await readCapabilityStore(normalizedSessionId, { targetPath });
  const claims = store.claims.filter(
    (claim) => normalizeAgentId(claim.holderId) === normalizedAgentId,
  );
  const released = [];
  const failures = [];
  for (const claim of claims) {
    try {
      const response = await releaseCapabilityClaim(
        normalizedSessionId,
        normalizedAgentId,
        claim,
        {
          reason: normalizedReason,
          targetPath,
          resolveAuthSession,
          requestMutation,
        },
      );
      if (response.released) {
        released.push(presentLease(response.lease || { path: claim.path }));
      }
    } catch (error) {
      failures.push({
        leaseId: claim.leaseId,
        file: claim.path,
        code: normalizeString(error?.code) || "release_failed",
      });
    }
  }

  let unresolved = [];
  let authority = {
    ok: true,
    authoritative: true,
    code: null,
  };
  try {
    const active = await listRemoteLeases(normalizedSessionId, {
      targetPath,
      resolveAuthSession,
      request,
    });
    unresolved = active.filter(
      (lease) => lease.agentId === normalizedAgentId,
    );
  } catch (error) {
    authority = {
      ok: false,
      authoritative: false,
      code: normalizeString(error?.code) || "FILE_LEASE_LIST_FAILED",
    };
  }
  return {
    releasedCount: released.length,
    released,
    failures,
    unresolved,
    unresolvedKnown: authority.ok,
    authority,
    events: [],
    expiredEvents: [],
  };
}

export {
  DEFAULT_FILE_LOCK_TTL_SECONDS,
  MAX_FILE_LOCK_TTL_SECONDS,
  MIN_FILE_LOCK_TTL_SECONDS,
  fileLeasePathCovers,
  fileLeasePathsOverlap,
  canonicalizeFilePath,
  normalizeFilePath,
};
