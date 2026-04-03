import { z } from "zod";

function emptyToUndefined(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : undefined;
}

const optionalTrimmedString = z.preprocess(emptyToUndefined, z.string().min(1)).optional();
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url()).optional();

const persistedConfigShape = {
  apiUrl: optionalUrl,
  webUrl: optionalUrl,
  outputDir: optionalTrimmedString,
  defaultPolicyPack: optionalTrimmedString,
  defaultModelProvider: z.enum(["openai", "anthropic", "google"]).optional(),
  defaultModelId: optionalTrimmedString,
};

const secretConfigShape = {
  sentinelayerToken: optionalTrimmedString,
  openaiApiKey: optionalTrimmedString,
  anthropicApiKey: optionalTrimmedString,
  googleApiKey: optionalTrimmedString,
};

export const PERSISTED_CONFIG_KEYS = Object.freeze(Object.keys(persistedConfigShape));
export const SECRET_CONFIG_KEYS = Object.freeze(Object.keys(secretConfigShape));

export const persistedConfigSchema = z.object(persistedConfigShape).strict();
export const runtimeSecretSchema = z.object(secretConfigShape).strict();
export const configSchema = persistedConfigSchema;

export function isSecretConfigKey(key) {
  return SECRET_CONFIG_KEYS.includes(String(key || "").trim());
}

export function findPersistedSecretKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return SECRET_CONFIG_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function getPersistedConfigSchema() {
  return persistedConfigSchema;
}

export function getRuntimeSecretSchema() {
  return runtimeSecretSchema;
}

export function getAllConfigKeys({ includeSecrets = false } = {}) {
  return includeSecrets
    ? [...PERSISTED_CONFIG_KEYS, ...SECRET_CONFIG_KEYS]
    : [...PERSISTED_CONFIG_KEYS];
}
