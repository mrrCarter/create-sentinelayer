import fsp from "node:fs/promises";
import path from "node:path";

const REGISTRY_SCHEMA_VERSION = "1.0.0";
const TERMINAL_IDENTITY_STATUSES = new Set(["SQUASHED"]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeUpper(value) {
  return normalizeString(value).toUpperCase();
}

function normalizeTagList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set();
  for (const item of value) {
    const normalized = normalizeString(item);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

function normalizeLegalHoldStatus(value) {
  const normalized = normalizeUpper(value);
  if (!normalized) {
    return "NONE";
  }
  if (normalized === "HOLD" || normalized === "NONE" || normalized === "UNKNOWN") {
    return normalized;
  }
  return normalized;
}

function normalizeMetadata(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...source,
    tags: normalizeTagList(source.tags),
    legalHoldStatus: normalizeLegalHoldStatus(source.legalHoldStatus),
  };
}

function normalizeIdentityRecord(record = {}) {
  const metadata = normalizeMetadata(record.metadata);
  const legalHoldStatus = normalizeLegalHoldStatus(record.legalHoldStatus || metadata.legalHoldStatus);
  return {
    identityId: normalizeString(record.identityId),
    parentIdentityId: normalizeString(record.parentIdentityId) || null,
    emailAddress: normalizeString(record.emailAddress) || null,
    status: normalizeString(record.status) || "UNKNOWN",
    projectId: normalizeString(record.projectId) || null,
    orgId: normalizeString(record.orgId) || null,
    apiUrl: normalizeString(record.apiUrl) || null,
    createdAt: normalizeString(record.createdAt) || new Date().toISOString(),
    lastUpdatedAt: normalizeString(record.lastUpdatedAt) || new Date().toISOString(),
    expiresAt: normalizeString(record.expiresAt) || null,
    revokedAt: normalizeString(record.revokedAt) || null,
    squashedAt: normalizeString(record.squashedAt) || null,
    legalHoldStatus,
    metadata,
  };
}

export function resolveIdentityRegistryPath({ outputRoot } = {}) {
  const resolvedOutputRoot = path.resolve(String(outputRoot || "."));
  return path.join(resolvedOutputRoot, "aidenid", "identity-registry.json");
}

async function loadRegistryInternal(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const identities = Array.isArray(parsed.identities)
      ? parsed.identities.map((item) => normalizeIdentityRecord(item)).filter((item) => item.identityId)
      : [];
    return {
      schemaVersion: normalizeString(parsed.schemaVersion) || REGISTRY_SCHEMA_VERSION,
      generatedAt: normalizeString(parsed.generatedAt) || new Date().toISOString(),
      identities,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        identities: [],
      };
    }
    throw error;
  }
}

async function writeRegistryInternal(filePath, registry = {}) {
  const normalized = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    identities: Array.isArray(registry.identities) ? registry.identities.map(normalizeIdentityRecord) : [],
  };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

export async function listIdentities({ outputRoot } = {}) {
  const registryPath = resolveIdentityRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  return {
    registryPath,
    identities: registry.identities,
  };
}

export async function getIdentityById({ outputRoot, identityId } = {}) {
  const normalizedIdentityId = normalizeString(identityId);
  if (!normalizedIdentityId) {
    throw new Error("identityId is required.");
  }
  const { registryPath, identities } = await listIdentities({ outputRoot });
  const identity = identities.find((item) => item.identityId === normalizedIdentityId) || null;
  return {
    registryPath,
    identity,
  };
}

export async function recordProvisionedIdentity({
  outputRoot,
  response = {},
  context = {},
} = {}) {
  const registryPath = resolveIdentityRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  const identityId = normalizeString(response.id);
  if (!identityId) {
    throw new Error("Cannot record identity without response.id.");
  }

  const nowIso = new Date().toISOString();
  const source = normalizeString(context.source) || "provision-email";
  const nextRecord = normalizeIdentityRecord({
    identityId,
    parentIdentityId: response.parentIdentityId || context.parentIdentityId || null,
    emailAddress: response.emailAddress,
    status: response.status || "ACTIVE",
    projectId: response.projectId || context.projectId,
    orgId: context.orgId,
    apiUrl: context.apiUrl,
    createdAt: nowIso,
    lastUpdatedAt: nowIso,
    expiresAt: response.expiresAt || null,
    legalHoldStatus: response.legalHoldStatus || context.legalHoldStatus || "NONE",
    metadata: {
      source,
      idempotencyKey: context.idempotencyKey || null,
      eventBudget: context.eventBudget ?? null,
      tags: normalizeTagList(context.tags || response.tags || []),
      legalHoldStatus: response.legalHoldStatus || context.legalHoldStatus || "NONE",
    },
  });

  const index = registry.identities.findIndex((item) => item.identityId === identityId);
  if (index >= 0) {
    const existing = registry.identities[index];
    registry.identities[index] = normalizeIdentityRecord({
      ...existing,
      ...nextRecord,
      createdAt: existing.createdAt || nextRecord.createdAt,
      metadata: {
        ...existing.metadata,
        ...nextRecord.metadata,
      },
    });
  } else {
    registry.identities.push(nextRecord);
  }

  const saved = await writeRegistryInternal(registryPath, registry);
  const identity = saved.identities.find((item) => item.identityId === identityId) || null;
  return {
    registryPath,
    identity,
  };
}

export async function updateIdentityStatus({
  outputRoot,
  identityId,
  status,
  revokedAt = "",
  squashedAt = "",
  metadataPatch = {},
} = {}) {
  const normalizedIdentityId = normalizeString(identityId);
  if (!normalizedIdentityId) {
    throw new Error("identityId is required.");
  }
  const nextStatus = normalizeString(status);
  if (!nextStatus) {
    throw new Error("status is required.");
  }

  const registryPath = resolveIdentityRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  const index = registry.identities.findIndex((item) => item.identityId === normalizedIdentityId);
  if (index < 0) {
    throw new Error(`Identity '${normalizedIdentityId}' was not found in local registry.`);
  }

  const existing = registry.identities[index];
  registry.identities[index] = normalizeIdentityRecord({
    ...existing,
    status: nextStatus,
    revokedAt: normalizeString(revokedAt) || existing.revokedAt || null,
    squashedAt: normalizeString(squashedAt) || existing.squashedAt || null,
    legalHoldStatus: metadataPatch?.legalHoldStatus || existing.legalHoldStatus || "NONE",
    lastUpdatedAt: new Date().toISOString(),
    metadata: {
      ...existing.metadata,
      ...(metadataPatch && typeof metadataPatch === "object" ? metadataPatch : {}),
    },
  });

  const saved = await writeRegistryInternal(registryPath, registry);
  return {
    registryPath,
    identity: saved.identities[index],
  };
}

export function filterIdentitiesByTags(identities = [], tags = []) {
  const requestedTags = normalizeTagList(tags);
  if (requestedTags.length === 0) {
    return [...identities];
  }
  const required = new Set(requestedTags);
  return identities.filter((identity) => {
    const identityTags = normalizeTagList(identity?.metadata?.tags);
    if (identityTags.length === 0) {
      return false;
    }
    return [...required].every((tag) => identityTags.includes(tag));
  });
}

export async function findStaleIdentities({ outputRoot, nowIso = new Date().toISOString() } = {}) {
  const { registryPath, identities } = await listIdentities({ outputRoot });
  const nowMs = new Date(nowIso).getTime();
  const stale = identities.filter((identity) => {
    const status = normalizeUpper(identity.status);
    if (TERMINAL_IDENTITY_STATUSES.has(status)) {
      return false;
    }
    const expiresAtMs = new Date(identity.expiresAt || "").getTime();
    if (!Number.isFinite(expiresAtMs)) {
      return false;
    }
    return expiresAtMs <= nowMs;
  });
  return {
    registryPath,
    identities,
    stale,
  };
}
