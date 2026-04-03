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

export const PLAINTEXT_CONFIG_SECRETS_ENV = "SENTINELAYER_ALLOW_PLAINTEXT_CONFIG_SECRETS";

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

export const SECRET_CONFIG_KEYS = Object.freeze(Object.keys(secretConfigShape));

export const persistedConfigSchema = z.object(persistedConfigShape).strict();
export const configSchema = persistedConfigSchema.extend(secretConfigShape).strict();

export const CONFIG_KEYS = Object.freeze(Object.keys(configSchema.shape));

export function isSecretConfigKey(key) {
  return SECRET_CONFIG_KEYS.includes(String(key || "").trim());
}

export function findPersistedSecretKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return SECRET_CONFIG_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function isPlaintextConfigSecretsOptInEnabled(env = process.env) {
  const normalized = String(env?.[PLAINTEXT_CONFIG_SECRETS_ENV] || "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function getPersistedConfigSchema({ allowPlaintextSecrets = false } = {}) {
  return allowPlaintextSecrets ? configSchema : persistedConfigSchema;
}
