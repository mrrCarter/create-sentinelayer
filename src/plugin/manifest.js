import fsp from "node:fs/promises";
import path from "node:path";

import { ZodError, z } from "zod";

import { resolveOutputRoot } from "../config/service.js";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = "1.0.0";
export const PLUGIN_MANIFEST_KIND = "sentinelayer.cli.plugin";

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
    entrypoint: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
      })
      .strict(),
    load_order: z
      .object({
        stage: z.enum(["pre_scan", "scan", "post_scan", "reporting"]).default("scan"),
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

function titleFromPluginId(pluginId) {
  return pluginId
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function buildPluginManifestTemplate({ pluginId, generatedAt = new Date().toISOString() } = {}) {
  const normalizedId = normalizePluginId(pluginId);
  return {
    schema_version: PLUGIN_MANIFEST_SCHEMA_VERSION,
    kind: PLUGIN_MANIFEST_KIND,
    id: normalizedId,
    name: titleFromPluginId(normalizedId),
    version: "0.1.0",
    description: `Sentinelayer plugin package for ${normalizedId}.`,
    entrypoint: {
      command: "node",
      args: ["index.js"],
    },
    load_order: {
      stage: "scan",
      after: [],
      before: [],
    },
    capabilities: {
      commands: [],
      templates: [],
      policies: [],
      mcp_tools: [],
    },
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

export function validatePluginManifest(payload) {
  return pluginManifestSchema.parse(payload);
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
        stage: manifest.load_order.stage,
        commandCount: manifest.capabilities.commands.length,
        policyCount: manifest.capabilities.policies.length,
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
