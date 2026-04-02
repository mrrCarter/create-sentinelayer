import fsp from "node:fs/promises";
import path from "node:path";

const REGISTRY_SCHEMA_VERSION = "1.0.0";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeDomainRecord(record = {}) {
  return {
    domainId: normalizeString(record.domainId),
    domainName: normalizeString(record.domainName) || null,
    projectId: normalizeString(record.projectId) || null,
    verificationStatus: normalizeString(record.verificationStatus) || "UNKNOWN",
    freezeStatus: normalizeString(record.freezeStatus) || "UNKNOWN",
    trustClass: normalizeString(record.trustClass) || null,
    verificationMethod: normalizeString(record.verificationMethod) || null,
    challengeValue: normalizeString(record.challengeValue) || null,
    proofId: normalizeString(record.proofId) || null,
    proofStatus: normalizeString(record.proofStatus) || null,
    proofExpiresAt: normalizeString(record.proofExpiresAt) || null,
    createdAt: normalizeString(record.createdAt) || new Date().toISOString(),
    lastUpdatedAt: normalizeString(record.lastUpdatedAt) || new Date().toISOString(),
    metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : {},
  };
}

function normalizeTargetRecord(record = {}) {
  return {
    targetId: normalizeString(record.targetId),
    host: normalizeString(record.host) || null,
    domainId: normalizeString(record.domainId) || null,
    projectId: normalizeString(record.projectId) || null,
    verificationStatus: normalizeString(record.verificationStatus) || "UNKNOWN",
    status: normalizeString(record.status) || "UNKNOWN",
    freezeStatus: normalizeString(record.freezeStatus) || "UNKNOWN",
    challengeValue: normalizeString(record.challengeValue) || null,
    proofId: normalizeString(record.proofId) || null,
    proofStatus: normalizeString(record.proofStatus) || null,
    proofExpiresAt: normalizeString(record.proofExpiresAt) || null,
    policy:
      record.policy && typeof record.policy === "object"
        ? {
            allowedPaths: Array.isArray(record.policy.allowedPaths) ? record.policy.allowedPaths : [],
            allowedMethods: Array.isArray(record.policy.allowedMethods) ? record.policy.allowedMethods : [],
            allowedScenarios: Array.isArray(record.policy.allowedScenarios)
              ? record.policy.allowedScenarios
              : [],
            maxRps: Number.isFinite(Number(record.policy.maxRps)) ? Number(record.policy.maxRps) : null,
            maxConcurrency: Number.isFinite(Number(record.policy.maxConcurrency))
              ? Number(record.policy.maxConcurrency)
              : null,
            stopConditions:
              record.policy.stopConditions && typeof record.policy.stopConditions === "object"
                ? record.policy.stopConditions
                : {},
          }
        : {
            allowedPaths: [],
            allowedMethods: [],
            allowedScenarios: [],
            maxRps: null,
            maxConcurrency: null,
            stopConditions: {},
          },
    createdAt: normalizeString(record.createdAt) || new Date().toISOString(),
    lastUpdatedAt: normalizeString(record.lastUpdatedAt) || new Date().toISOString(),
    metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : {},
  };
}

export function resolveDomainTargetRegistryPath({ outputRoot } = {}) {
  const resolvedOutputRoot = path.resolve(String(outputRoot || "."));
  return path.join(resolvedOutputRoot, "aidenid", "domain-target-registry.json");
}

async function loadRegistryInternal(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const domains = Array.isArray(parsed.domains)
      ? parsed.domains.map((item) => normalizeDomainRecord(item)).filter((item) => item.domainId)
      : [];
    const targets = Array.isArray(parsed.targets)
      ? parsed.targets.map((item) => normalizeTargetRecord(item)).filter((item) => item.targetId)
      : [];
    return {
      schemaVersion: normalizeString(parsed.schemaVersion) || REGISTRY_SCHEMA_VERSION,
      generatedAt: normalizeString(parsed.generatedAt) || new Date().toISOString(),
      domains,
      targets,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        domains: [],
        targets: [],
      };
    }
    throw error;
  }
}

async function writeRegistryInternal(filePath, registry = {}) {
  const normalized = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    domains: Array.isArray(registry.domains) ? registry.domains.map(normalizeDomainRecord) : [],
    targets: Array.isArray(registry.targets) ? registry.targets.map(normalizeTargetRecord) : [],
  };
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

export async function listDomainTargetRecords({ outputRoot } = {}) {
  const registryPath = resolveDomainTargetRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  return {
    registryPath,
    domains: registry.domains,
    targets: registry.targets,
  };
}

export async function getDomainById({ outputRoot, domainId } = {}) {
  const normalizedDomainId = normalizeString(domainId);
  if (!normalizedDomainId) {
    throw new Error("domainId is required.");
  }
  const { registryPath, domains } = await listDomainTargetRecords({ outputRoot });
  const domain = domains.find((item) => item.domainId === normalizedDomainId) || null;
  return {
    registryPath,
    domain,
  };
}

export async function getTargetById({ outputRoot, targetId } = {}) {
  const normalizedTargetId = normalizeString(targetId);
  if (!normalizedTargetId) {
    throw new Error("targetId is required.");
  }
  const { registryPath, targets } = await listDomainTargetRecords({ outputRoot });
  const target = targets.find((item) => item.targetId === normalizedTargetId) || null;
  return {
    registryPath,
    target,
  };
}

export async function recordDomainProofResponse({
  outputRoot,
  domain = {},
  proof = {},
  context = {},
} = {}) {
  const domainId = normalizeString(domain.id || context.domainId);
  if (!domainId) {
    throw new Error("Cannot record domain without domain.id.");
  }
  const registryPath = resolveDomainTargetRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  const nowIso = new Date().toISOString();
  const nextRecord = normalizeDomainRecord({
    domainId,
    domainName: domain.domainName,
    projectId: domain.projectId || context.projectId,
    verificationStatus: domain.verificationStatus,
    freezeStatus: domain.freezeStatus,
    trustClass: domain.trustClass,
    verificationMethod: domain.verificationMethod,
    challengeValue: proof.challengeValue || context.challengeValue,
    proofId: proof.proofId,
    proofStatus: proof.proofStatus,
    proofExpiresAt: proof.proofExpiresAt,
    createdAt: nowIso,
    lastUpdatedAt: nowIso,
    metadata: {
      source: normalizeString(context.source) || "domain",
      idempotencyKey: context.idempotencyKey || null,
    },
  });

  const index = registry.domains.findIndex((item) => item.domainId === domainId);
  if (index >= 0) {
    const existing = registry.domains[index];
    registry.domains[index] = normalizeDomainRecord({
      ...existing,
      ...nextRecord,
      createdAt: existing.createdAt || nextRecord.createdAt,
      metadata: {
        ...existing.metadata,
        ...nextRecord.metadata,
      },
    });
  } else {
    registry.domains.push(nextRecord);
  }

  const saved = await writeRegistryInternal(registryPath, registry);
  const record = saved.domains.find((item) => item.domainId === domainId) || null;
  return {
    registryPath,
    domain: record,
  };
}

export async function recordTargetProofResponse({
  outputRoot,
  target = {},
  proof = {},
  context = {},
} = {}) {
  const targetId = normalizeString(target.id || context.targetId);
  if (!targetId) {
    throw new Error("Cannot record target without target.id.");
  }
  const registryPath = resolveDomainTargetRegistryPath({ outputRoot });
  const registry = await loadRegistryInternal(registryPath);
  const nowIso = new Date().toISOString();
  const nextRecord = normalizeTargetRecord({
    targetId,
    host: target.host,
    domainId: target.domainId || context.domainId || null,
    projectId: target.projectId || context.projectId || null,
    verificationStatus: target.verificationStatus,
    status: target.status,
    freezeStatus: target.freezeStatus,
    challengeValue: proof.challengeValue || context.challengeValue,
    proofId: proof.proofId,
    proofStatus: proof.proofStatus,
    proofExpiresAt: proof.proofExpiresAt,
    policy: target.policy || {},
    createdAt: nowIso,
    lastUpdatedAt: nowIso,
    metadata: {
      source: normalizeString(context.source) || "target",
      idempotencyKey: context.idempotencyKey || null,
    },
  });

  const index = registry.targets.findIndex((item) => item.targetId === targetId);
  if (index >= 0) {
    const existing = registry.targets[index];
    registry.targets[index] = normalizeTargetRecord({
      ...existing,
      ...nextRecord,
      createdAt: existing.createdAt || nextRecord.createdAt,
      metadata: {
        ...existing.metadata,
        ...nextRecord.metadata,
      },
    });
  } else {
    registry.targets.push(nextRecord);
  }

  const saved = await writeRegistryInternal(registryPath, registry);
  const record = saved.targets.find((item) => item.targetId === targetId) || null;
  return {
    registryPath,
    target: record,
  };
}
