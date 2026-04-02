import process from "node:process";
import path from "node:path";

import { getConfigPaths } from "./paths.js";
import { ensureConfigFile, readConfigFile, writeConfigFile } from "./io.js";
import { CONFIG_KEYS, configSchema } from "./schema.js";

const ENV_MAPPING = Object.freeze({
  SENTINELAYER_API_URL: "apiUrl",
  SENTINELAYER_WEB_URL: "webUrl",
  SENTINELAYER_TOKEN: "sentinelayerToken",
  SENTINELAYER_POLICY_PACK: "defaultPolicyPack",
  OPENAI_API_KEY: "openaiApiKey",
  ANTHROPIC_API_KEY: "anthropicApiKey",
  GOOGLE_API_KEY: "googleApiKey",
});

const WRITABLE_SCOPES = new Set(["global", "project"]);
const LAYER_SCOPES = new Set(["global", "project", "env", "resolved"]);

function normalizeKey(key) {
  const normalized = String(key || "").trim();
  if (!CONFIG_KEYS.includes(normalized)) {
    throw new Error(`Unknown config key '${normalized}'. Allowed keys: ${CONFIG_KEYS.join(", ")}`);
  }
  return normalized;
}

function normalizeValueForKey(key, value) {
  const payload = { [key]: value };
  const parsed = configSchema.partial().parse(payload);
  return parsed[key];
}

function buildEnvLayer(env) {
  const layer = {};
  for (const [envVar, key] of Object.entries(ENV_MAPPING)) {
    if (envVar in env) {
      const value = normalizeValueForKey(key, env[envVar]);
      if (value !== undefined) {
        layer[key] = value;
      }
    }
  }
  return layer;
}

function mergeLayers(...layers) {
  return layers.reduce((accumulator, layer) => {
    for (const [key, value] of Object.entries(layer || {})) {
      if (value !== undefined) {
        accumulator[key] = value;
      }
    }
    return accumulator;
  }, {});
}

function normalizeLayerScope(scope, { allowResolved = true } = {}) {
  const normalized = String(scope || "resolved").trim();
  if (!allowResolved && normalized === "resolved") {
    throw new Error("Resolved scope is read-only. Use global or project.");
  }
  if (!LAYER_SCOPES.has(normalized)) {
    throw new Error(`Invalid scope '${normalized}'. Use global, project, env, or resolved.`);
  }
  return normalized;
}

export async function loadConfig({ cwd = process.cwd(), env = process.env, homeDir } = {}) {
  const paths = getConfigPaths({ cwd, homeDir });
  const [globalConfig, projectConfig] = await Promise.all([
    readConfigFile(paths.global),
    readConfigFile(paths.project),
  ]);

  const envConfig = buildEnvLayer(env);
  const resolved = configSchema.parse(mergeLayers(globalConfig, projectConfig, envConfig));

  return {
    paths,
    layers: {
      global: globalConfig,
      project: projectConfig,
      env: envConfig,
    },
    resolved,
  };
}

export function getLayer(config, scope) {
  const normalized = normalizeLayerScope(scope);
  if (normalized === "resolved") {
    return config.resolved;
  }
  return config.layers[normalized] || {};
}

export function findConfigSource(config, key) {
  const normalizedKey = normalizeKey(key);
  if (Object.prototype.hasOwnProperty.call(config.layers.env, normalizedKey)) {
    return "env";
  }
  if (Object.prototype.hasOwnProperty.call(config.layers.project, normalizedKey)) {
    return "project";
  }
  if (Object.prototype.hasOwnProperty.call(config.layers.global, normalizedKey)) {
    return "global";
  }
  return null;
}

export async function setConfigValue({
  key,
  value,
  scope = "project",
  cwd = process.cwd(),
  homeDir,
} = {}) {
  const normalizedScope = normalizeLayerScope(scope, { allowResolved: false });
  if (!WRITABLE_SCOPES.has(normalizedScope)) {
    throw new Error(`Cannot write scope '${normalizedScope}'. Use global or project.`);
  }

  const normalizedKey = normalizeKey(key);
  const normalizedValue = normalizeValueForKey(normalizedKey, value);

  const paths = getConfigPaths({ cwd, homeDir });
  const targetPath = paths[normalizedScope];
  const current = await readConfigFile(targetPath);
  const next = {
    ...current,
    [normalizedKey]: normalizedValue,
  };

  await writeConfigFile(targetPath, next);

  return {
    scope: normalizedScope,
    path: targetPath,
    key: normalizedKey,
    value: normalizedValue,
  };
}

export async function ensureEditableConfigPath({ scope = "project", cwd = process.cwd(), homeDir } = {}) {
  const normalizedScope = normalizeLayerScope(scope, { allowResolved: false });
  if (!WRITABLE_SCOPES.has(normalizedScope)) {
    throw new Error(`Cannot edit scope '${normalizedScope}'. Use global or project.`);
  }

  const paths = getConfigPaths({ cwd, homeDir });
  const targetPath = paths[normalizedScope];
  await ensureConfigFile(targetPath);

  return {
    scope: normalizedScope,
    path: targetPath,
  };
}

export function listConfigKeys() {
  return [...CONFIG_KEYS];
}

export async function resolveOutputRoot({
  cwd = process.cwd(),
  outputDirOverride = "",
  env = process.env,
  homeDir,
} = {}) {
  const overrideValue = String(outputDirOverride || "").trim();
  if (overrideValue) {
    return path.resolve(cwd, overrideValue);
  }

  const config = await loadConfig({ cwd, env, homeDir });
  const configuredOutputDir = String(config.resolved.outputDir || "").trim();
  if (configuredOutputDir) {
    return path.resolve(cwd, configuredOutputDir);
  }

  return path.resolve(cwd, ".sentinelayer");
}
