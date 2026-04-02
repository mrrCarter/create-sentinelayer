import fsp from "node:fs/promises";
import path from "node:path";

const REGISTRY_SCHEMA_VERSION = "1.0.0";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSiteRecord(record = {}) {
  return {
    siteId: normalizeString(record.siteId),
    projectId: normalizeString(record.projectId) || null,
    identityId: normalizeString(record.identityId) || null,
    domainId: normalizeString(record.domainId) || null,
    host: normalizeString(record.host) || null,
    callbackPath: normalizeString(record.callbackPath) || null,
    callbackUrl: normalizeString(record.callbackUrl) || null,
    status: normalizeString(record.status) || "UNKNOWN",
    dnsCleanupStatus: normalizeString(record.dnsCleanupStatus) || "UNKNOWN",
    expiresAt: normalizeString(record.expiresAt) || null,
    teardownReason: normalizeString(record.teardownReason) || null,
    teardownAt: normalizeString(record.teardownAt) || null,
    createdAt: normalizeString(record.createdAt) || new Date().toISOString(),
    lastUpdatedAt: normalizeString(record.lastUpdatedAt) || new Date().toISOString(),
    dnsCleanupContract:
      record.dnsCleanupContract && typeof record.dnsCleanupContract === "object"
        ? record.dnsCleanupContract
        : {},
    metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : {},
  };
}

export function resolveSiteRegistryPath({ outputRoot } = {}) {
  const resolvedOutputRoot = path.resolve(String(outputRoot || "."));
  return path.join(resolvedOutputRoot, "aidenid", "site-registry.json");
}

async function loadRegistryInternal(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const sites = Array.isArray(parsed.sites)
      ? parsed.sites.map((item) => normalizeSiteRecord(item)).filter((item) => item.siteId)
      : [];
    return {
      schemaVersion: normalizeString(parsed.schemaVersion) || REGISTRY_SCHEMA_VERSION,
      generatedAt: normalizeString(parsed.generatedAt) || new Date().toISOString(),
      sites,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        sites: [],
      };
    }
    throw error;
  }
}

async function writeRegistryInternal(filePath, registry = {}) {
  const normalized = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sites: Array.isArray(registry.sites) ? registry.sites.map(normalizeSiteRecord) : [],
  };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

export async function listSites({ outputRoot, identityId = "" } = {}) {
  const registryPath = resolveSiteRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  const normalizedIdentityId = normalizeString(identityId);
  const filteredSites = normalizedIdentityId
    ? registry.sites.filter((item) => item.identityId === normalizedIdentityId)
    : registry.sites;
  return {
    registryPath,
    sites: filteredSites,
  };
}

export async function recordTemporarySite({
  outputRoot,
  site = {},
  context = {},
} = {}) {
  const siteId = normalizeString(site.id || context.siteId);
  if (!siteId) {
    throw new Error("Cannot record temporary site without site.id.");
  }

  const registryPath = resolveSiteRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  const nowIso = new Date().toISOString();
  const nextRecord = normalizeSiteRecord({
    siteId,
    projectId: site.projectId || context.projectId,
    identityId: site.identityId || context.identityId,
    domainId: site.domainId || context.domainId,
    host: site.host,
    callbackPath: site.callbackPath,
    callbackUrl: site.callbackUrl,
    status: site.status,
    dnsCleanupStatus: site.dnsCleanupStatus,
    expiresAt: site.expiresAt,
    teardownReason: site.teardownReason,
    teardownAt: site.teardownAt,
    createdAt: nowIso,
    lastUpdatedAt: nowIso,
    dnsCleanupContract: site.dnsCleanupContract,
    metadata: {
      ...(site.metadata && typeof site.metadata === "object" ? site.metadata : {}),
      source: normalizeString(context.source) || "site-create",
      idempotencyKey: context.idempotencyKey || null,
    },
  });

  const index = registry.sites.findIndex((item) => item.siteId === siteId);
  if (index >= 0) {
    const existing = registry.sites[index];
    registry.sites[index] = normalizeSiteRecord({
      ...existing,
      ...nextRecord,
      createdAt: existing.createdAt || nextRecord.createdAt,
      metadata: {
        ...existing.metadata,
        ...nextRecord.metadata,
      },
    });
  } else {
    registry.sites.push(nextRecord);
  }

  const saved = await writeRegistryInternal(registryPath, registry);
  const savedSite = saved.sites.find((item) => item.siteId === siteId) || null;
  return {
    registryPath,
    site: savedSite,
  };
}
