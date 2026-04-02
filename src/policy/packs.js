import { loadConfig } from "../config/service.js";
import { listPluginManifests } from "../plugin/manifest.js";

export const DEFAULT_POLICY_PACK_ID = "community";

export const BUILTIN_POLICY_PACKS = Object.freeze([
  {
    id: "community",
    name: "Community",
    description: "Balanced defaults for everyday repositories.",
    source: "builtin",
    scanProfile: {},
  },
  {
    id: "strict",
    name: "Strict",
    description: "Aggressive security gating with stricter severity threshold.",
    source: "builtin",
    scanProfile: {
      scanMode: "deep",
      severityGate: "P0",
      sbomMode: "audit",
    },
  },
  {
    id: "compliance-soc2",
    name: "Compliance SOC2",
    description: "SOC2-oriented defaults with deep scan and supply-chain auditing.",
    source: "builtin",
    scanProfile: {
      scanMode: "deep",
      severityGate: "P1",
      sbomMode: "audit",
    },
  },
  {
    id: "compliance-hipaa",
    name: "Compliance HIPAA",
    description: "HIPAA-oriented defaults with strict severity gating.",
    source: "builtin",
    scanProfile: {
      scanMode: "deep",
      severityGate: "P0",
      sbomMode: "audit",
    },
  },
]);

function normalizePackId(rawValue) {
  return String(rawValue || "")
    .trim()
    .toLowerCase();
}

function mapCustomPack(pluginEntry) {
  return {
    id: pluginEntry.id,
    name: pluginEntry.name,
    description: `Plugin policy pack (${pluginEntry.packType})`,
    source: "plugin",
    scanProfile: {},
    plugin: {
      version: pluginEntry.version,
      stage: pluginEntry.stage,
      path: pluginEntry.path,
      policyCount: pluginEntry.policyCount,
    },
  };
}

export async function listPolicyPacks({ cwd, outputDir, env } = {}) {
  const builtins = BUILTIN_POLICY_PACKS.map((pack) => ({ ...pack }));
  const pluginListing = await listPluginManifests({
    cwd,
    outputDir,
    env,
  });
  const custom = pluginListing.plugins
    .filter(
      (plugin) =>
        plugin.policyCount > 0 && (plugin.packType === "policy_pack" || plugin.packType === "hybrid")
    )
    .map((plugin) => mapCustomPack(plugin));

  custom.sort((left, right) => left.id.localeCompare(right.id));
  const all = [...builtins];
  for (const customPack of custom) {
    if (!all.some((builtin) => builtin.id === customPack.id)) {
      all.push(customPack);
    }
  }

  return {
    packs: all,
    builtins,
    custom,
    pluginsRoot: pluginListing.pluginsRoot,
    invalidManifestCount: pluginListing.invalid.length,
  };
}

export async function resolvePolicyPackById({ packId, cwd, outputDir, env } = {}) {
  const normalizedPackId = normalizePackId(packId);
  const listing = await listPolicyPacks({ cwd, outputDir, env });
  const selected = listing.packs.find((pack) => pack.id === normalizedPackId);
  return {
    ...listing,
    packId: normalizedPackId,
    selected: selected || null,
  };
}

export async function resolveActivePolicyPack({ cwd, outputDir, env } = {}) {
  const config = await loadConfig({ cwd, env });
  const configuredId = normalizePackId(config.resolved.defaultPolicyPack) || DEFAULT_POLICY_PACK_ID;
  const resolved = await resolvePolicyPackById({
    packId: configuredId,
    cwd,
    outputDir,
    env,
  });
  const fallback =
    resolved.selected || resolved.packs.find((pack) => pack.id === DEFAULT_POLICY_PACK_ID) || null;

  return {
    configuredId,
    selected: fallback,
    listing: resolved,
  };
}

export function applyPolicyPackToScanProfile(profile = {}, policyPack = null) {
  if (!policyPack || !policyPack.scanProfile) {
    return profile;
  }
  const next = { ...profile };
  for (const [key, value] of Object.entries(policyPack.scanProfile)) {
    const normalized = String(value || "").trim();
    if (normalized) {
      next[key] = normalized;
    }
  }
  return next;
}
