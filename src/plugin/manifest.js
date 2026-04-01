import fsp from "node:fs/promises";
import path from "node:path";

import { ZodError, z } from "zod";

import { resolveOutputRoot } from "../config/service.js";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = "1.0.0";
export const PLUGIN_MANIFEST_KIND = "sentinelayer.cli.plugin";
export const PLUGIN_PACK_TYPES = ["plugin", "template_pack", "policy_pack", "hybrid"];
export const PLUGIN_LOAD_STAGES = ["pre_scan", "scan", "post_scan", "reporting"];

const pluginIdRegex = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const semverRegex = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const pluginManifestSchema = z
  .object({
    schema_version: z.literal(PLUGIN_MANIFEST_SCHEMA_VERSION).default(PLUGIN_MANIFEST_SCHEMA_VERSION),
    kind: z.literal(PLUGIN_MANIFEST_KIND).default(PLUGIN_MANIFEST_KIND),
    id: z.string().regex(pluginIdRegex, "plugin id must match [a-z0-9._-] and be 1-64 chars"),
    name: z.string().min(1),
    version: z.string().regex(semverRegex, "version must use semver (for example 0.1.0)"),
    description: z.string().min(1),
    pack_type: z.enum(PLUGIN_PACK_TYPES).default("plugin"),
    entrypoint: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
      })
      .strict(),
    load_order: z
      .object({
        stage: z.enum(PLUGIN_LOAD_STAGES).default("scan"),
        after: z.array(z.string()).default([]),
        before: z.array(z.string()).default([]),
      })
      .strict()
      .default({
        stage: "scan",
        after: [],
        before: [],
      }),
    capabilities: z
      .object({
        commands: z.array(z.string()).default([]),
        templates: z.array(z.string()).default([]),
        policies: z.array(z.string()).default([]),
        mcp_tools: z.array(z.string()).default([]),
      })
      .strict()
      .default({
        commands: [],
        templates: [],
        policies: [],
        mcp_tools: [],
      }),
    budgets: z
      .object({
        max_runtime_ms: z.number().int().positive().default(20000),
        max_tool_calls: z.number().int().positive().default(20),
      })
      .strict()
      .default({
        max_runtime_ms: 20000,
        max_tool_calls: 20,
      }),
    security: z
      .object({
        requires_human_approval: z.boolean().default(false),
        allow_network: z.boolean().default(false),
        allowed_paths: z.array(z.string()).default([]),
        kill_switch: z.enum(["enabled", "disabled"]).default("enabled"),
      })
      .strict()
      .default({
        requires_human_approval: false,
        allow_network: false,
        allowed_paths: [],
        kill_switch: "enabled",
      }),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict();

export function normalizePluginId(rawValue) {
  const base = String(rawValue || "")
    .trim()
    .toLowerCase();
  if (!base) {
    throw new Error("Plugin id is required.");
  }
  const normalized = base
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!pluginIdRegex.test(normalized)) {
    throw new Error(
      "Plugin id is invalid. Use lowercase letters, numbers, '.', '_' or '-' (1-64 chars)."
    );
  }
  return normalized;
}

export function normalizePluginPackType(rawValue) {
  const normalized = String(rawValue || "plugin")
    .trim()
    .toLowerCase();
  if (!PLUGIN_PACK_TYPES.includes(normalized)) {
    throw new Error(`pack type must be one of: ${PLUGIN_PACK_TYPES.join(", ")}`);
  }
  return normalized;
}

export function normalizePluginLoadStage(rawValue) {
  const normalized = String(rawValue || "scan")
    .trim()
    .toLowerCase();
  if (!PLUGIN_LOAD_STAGES.includes(normalized)) {
    throw new Error(`load stage must be one of: ${PLUGIN_LOAD_STAGES.join(", ")}`);
  }
  return normalized;
}

function titleFromPluginId(pluginId) {
  return pluginId
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function buildDefaultCapabilities(packType) {
  if (packType === "template_pack") {
    return {
      commands: [],
      templates: ["templates/example-template.json"],
      policies: [],
      mcp_tools: [],
    };
  }
  if (packType === "policy_pack") {
    return {
      commands: [],
      templates: [],
      policies: ["policies/example-policy.json"],
      mcp_tools: [],
    };
  }
  if (packType === "hybrid") {
    return {
      commands: [],
      templates: ["templates/example-template.json"],
      policies: ["policies/example-policy.json"],
      mcp_tools: [],
    };
  }
  return {
    commands: [],
    templates: [],
    policies: [],
    mcp_tools: [],
  };
}

export function buildPluginManifestTemplate({
  pluginId,
  packType = "plugin",
  stage = "scan",
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedId = normalizePluginId(pluginId);
  const normalizedPackType = normalizePluginPackType(packType);
  const normalizedStage = normalizePluginLoadStage(stage);
  return {
    schema_version: PLUGIN_MANIFEST_SCHEMA_VERSION,
    kind: PLUGIN_MANIFEST_KIND,
    id: normalizedId,
    name: titleFromPluginId(normalizedId),
    version: "0.1.0",
    description: `Sentinelayer plugin package for ${normalizedId}.`,
    pack_type: normalizedPackType,
    entrypoint: {
      command: "node",
      args: ["index.js"],
    },
    load_order: {
      stage: normalizedStage,
      after: [],
      before: [],
    },
    capabilities: buildDefaultCapabilities(normalizedPackType),
    budgets: {
      max_runtime_ms: 20000,
      max_tool_calls: 20,
    },
    security: {
      requires_human_approval: false,
      allow_network: false,
      allowed_paths: [],
      kill_switch: "enabled",
    },
    metadata: {
      generated_at: generatedAt,
      generated_by: "create-sentinelayer",
    },
  };
}

function normalizeDependencySet(values = []) {
  const seen = new Set();
  const normalized = [];
  for (const rawValue of values) {
    const candidate = String(rawValue || "").trim().toLowerCase();
    if (!candidate) {
      continue;
    }
    if (!pluginIdRegex.test(candidate)) {
      throw new Error(`load_order reference '${rawValue}' is not a valid plugin id`);
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      normalized.push(candidate);
    }
  }
  return normalized;
}

function validateManifestGovernance(manifest) {
  const normalizedAfter = normalizeDependencySet(manifest.load_order?.after || []);
  const normalizedBefore = normalizeDependencySet(manifest.load_order?.before || []);

  if (normalizedAfter.includes(manifest.id) || normalizedBefore.includes(manifest.id)) {
    throw new Error("load_order cannot reference the plugin itself");
  }

  const overlap = normalizedAfter.filter((value) => normalizedBefore.includes(value));
  if (overlap.length > 0) {
    throw new Error(`load_order.after and load_order.before overlap: ${overlap.join(", ")}`);
  }

  if (normalizedAfter.length > 25 || normalizedBefore.length > 25) {
    throw new Error("load_order dependency list is too large (max 25 entries for after/before)");
  }

  const templateCount = manifest.capabilities?.templates?.length || 0;
  const policyCount = manifest.capabilities?.policies?.length || 0;

  if (manifest.pack_type === "template_pack" && templateCount === 0) {
    throw new Error("template_pack must declare at least one template capability");
  }
  if (manifest.pack_type === "policy_pack" && policyCount === 0) {
    throw new Error("policy_pack must declare at least one policy capability");
  }
  if (manifest.pack_type === "plugin" && (templateCount > 0 || policyCount > 0)) {
    throw new Error("plugin pack_type cannot declare templates/policies (use template_pack/policy_pack/hybrid)");
  }

  return {
    ...manifest,
    load_order: {
      ...manifest.load_order,
      after: normalizedAfter,
      before: normalizedBefore,
    },
  };
}

export function validatePluginManifest(payload) {
  const parsed = pluginManifestSchema.parse(payload);
  return validateManifestGovernance(parsed);
}

export function summarizePluginValidationError(error) {
  if (!(error instanceof ZodError)) {
    return String(error instanceof Error ? error.message : error);
  }
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonFile(filePath, value, { force = false } = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!force) {
    try {
      await fsp.access(resolvedPath);
      throw new Error(`File already exists: ${resolvedPath}. Use --force to overwrite.`);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        // missing file is expected
      } else if (error instanceof Error && error.message.startsWith("File already exists:")) {
        throw error;
      } else if (error) {
        throw error;
      }
    }
  }

  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fsp.writeFile(resolvedPath, stringifyJson(value), "utf-8");
  return resolvedPath;
}

export async function readJsonFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const rawText = await fsp.readFile(resolvedPath, "utf-8");
  return {
    path: resolvedPath,
    data: JSON.parse(rawText),
  };
}

export async function resolvePluginsDirectoryPath({ cwd, outputDir, env } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd,
    outputDirOverride: outputDir,
    env,
  });
  return path.join(outputRoot, "plugins");
}

export async function resolveDefaultPluginManifestPath({ cwd, outputDir, env, pluginId } = {}) {
  const pluginsRoot = await resolvePluginsDirectoryPath({
    cwd,
    outputDir,
    env,
  });
  const normalizedId = normalizePluginId(pluginId);
  return path.join(pluginsRoot, normalizedId, "plugin.json");
}

async function collectPluginManifestPaths(rootDir) {
  const queue = [rootDir];
  const matches = [];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === "plugin.json") {
        matches.push(entryPath);
      }
    }
  }

  matches.sort((left, right) => left.localeCompare(right));
  return matches;
}

export async function listPluginManifests({ cwd, outputDir, env } = {}) {
  const pluginsRoot = await resolvePluginsDirectoryPath({ cwd, outputDir, env });
  const manifestPaths = await collectPluginManifestPaths(pluginsRoot);
  const plugins = [];
  const invalid = [];

  for (const manifestPath of manifestPaths) {
    try {
      const loaded = await readJsonFile(manifestPath);
      const manifest = validatePluginManifest(loaded.data);
      plugins.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        packType: manifest.pack_type,
        stage: manifest.load_order.stage,
        commandCount: manifest.capabilities.commands.length,
        policyCount: manifest.capabilities.policies.length,
        templateCount: manifest.capabilities.templates.length,
        path: loaded.path,
      });
    } catch (error) {
      invalid.push({
        path: manifestPath,
        error: summarizePluginValidationError(error),
      });
    }
  }

  plugins.sort((left, right) => {
    if (left.id !== right.id) {
      return left.id.localeCompare(right.id);
    }
    return left.path.localeCompare(right.path);
  });

  return {
    pluginsRoot,
    plugins,
    invalid,
  };
}

function computeTopologicalOrderForStage(stagePlugins = []) {
  const pluginById = new Map(stagePlugins.map((plugin) => [plugin.id, plugin]));
  const edges = new Map();
  const indegree = new Map();
  const unresolvedReferences = [];

  for (const plugin of stagePlugins) {
    edges.set(plugin.id, new Set());
    indegree.set(plugin.id, 0);
  }

  for (const plugin of stagePlugins) {
    const after = plugin.load_order?.after || [];
    const before = plugin.load_order?.before || [];

    for (const dependencyId of after) {
      if (!pluginById.has(dependencyId)) {
        unresolvedReferences.push({
          pluginId: plugin.id,
          relation: "after",
          dependencyId,
        });
        continue;
      }
      if (!edges.get(dependencyId).has(plugin.id)) {
        edges.get(dependencyId).add(plugin.id);
        indegree.set(plugin.id, (indegree.get(plugin.id) || 0) + 1);
      }
    }

    for (const dependencyId of before) {
      if (!pluginById.has(dependencyId)) {
        unresolvedReferences.push({
          pluginId: plugin.id,
          relation: "before",
          dependencyId,
        });
        continue;
      }
      if (!edges.get(plugin.id).has(dependencyId)) {
        edges.get(plugin.id).add(dependencyId);
        indegree.set(dependencyId, (indegree.get(dependencyId) || 0) + 1);
      }
    }
  }

  const queue = [...stagePlugins.map((plugin) => plugin.id).filter((id) => (indegree.get(id) || 0) === 0)].sort(
    (left, right) => left.localeCompare(right)
  );
  const order = [];

  while (queue.length > 0) {
    const currentId = queue.shift();
    order.push(currentId);

    for (const neighborId of [...(edges.get(currentId) || [])].sort((left, right) => left.localeCompare(right))) {
      const nextInDegree = (indegree.get(neighborId) || 0) - 1;
      indegree.set(neighborId, nextInDegree);
      if (nextInDegree === 0) {
        queue.push(neighborId);
        queue.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  const cycleNodes = stagePlugins
    .map((plugin) => plugin.id)
    .filter((pluginId) => (indegree.get(pluginId) || 0) > 0)
    .sort((left, right) => left.localeCompare(right));

  return {
    order,
    cycleDetected: cycleNodes.length > 0,
    cycleNodes,
    unresolvedReferences: unresolvedReferences.sort((left, right) => {
      if (left.pluginId !== right.pluginId) {
        return left.pluginId.localeCompare(right.pluginId);
      }
      if (left.relation !== right.relation) {
        return left.relation.localeCompare(right.relation);
      }
      return left.dependencyId.localeCompare(right.dependencyId);
    }),
  };
}

export async function computePluginLoadOrder({
  cwd,
  outputDir,
  env,
  stage = "",
} = {}) {
  const normalizedStage = String(stage || "")
    .trim()
    .toLowerCase();
  if (normalizedStage && !PLUGIN_LOAD_STAGES.includes(normalizedStage)) {
    throw new Error(`stage must be one of: ${PLUGIN_LOAD_STAGES.join(", ")}`);
  }

  const listing = await listPluginManifests({
    cwd,
    outputDir,
    env,
  });

  const stageNames = normalizedStage ? [normalizedStage] : PLUGIN_LOAD_STAGES;
  const stages = [];

  for (const stageName of stageNames) {
    const stagePlugins = listing.plugins
      .filter((plugin) => plugin.stage === stageName)
      .sort((left, right) => left.id.localeCompare(right.id));

    const manifestById = new Map();
    for (const plugin of stagePlugins) {
      const loaded = await readJsonFile(plugin.path);
      const manifest = validatePluginManifest(loaded.data);
      manifestById.set(plugin.id, manifest);
    }

    const orderResult = computeTopologicalOrderForStage([...manifestById.values()]);
    stages.push({
      stage: stageName,
      pluginCount: stagePlugins.length,
      order: orderResult.order,
      cycleDetected: orderResult.cycleDetected,
      cycleNodes: orderResult.cycleNodes,
      unresolvedReferences: orderResult.unresolvedReferences,
    });
  }

  const invalidCount = listing.invalid.length;
  const cycleStageCount = stages.filter((stageEntry) => stageEntry.cycleDetected).length;

  return {
    pluginsRoot: listing.pluginsRoot,
    invalidCount,
    invalid: listing.invalid,
    stages,
    hasBlockingIssues: invalidCount > 0 || cycleStageCount > 0,
  };
}
