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
const GENERIC_SECRET_PATTERN = /^[A-Za-z0-9._~:/+=-]+$/;
const CUSTOM_TOKEN_FORMAT_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function shouldAllowCustomTokenFormatFallback() {
  const rawValue = String(process.env.SL_ALLOW_CUSTOM_TOKEN_FORMATS || "")
    .trim()
    .toLowerCase();
  return CUSTOM_TOKEN_FORMAT_TRUE_VALUES.has(rawValue);
}

function createOptionalSecretSchema({
  field,
  minLength = 20,
  maxLength = 512,
  providerPattern = null,
  providerPatternHint = "",
}) {
  return z
    .preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .min(minLength, `${field} must be at least ${minLength} characters.`)
        .max(maxLength, `${field} must be at most ${maxLength} characters.`)
        .regex(GENERIC_SECRET_PATTERN, `${field} must not include whitespace or unsupported characters.`)
        .refine(
          (value) => /[A-Za-z]/.test(value) && /[0-9]/.test(value),
          `${field} must include at least one letter and one digit.`
        )
        .refine((value) => {
          if (!providerPattern) {
            return true;
          }
          if (providerPattern.test(value)) {
            return true;
          }
          return shouldAllowCustomTokenFormatFallback() && value.length >= 32;
        }, providerPatternHint || `${field} must match provider key format or meet strong length requirements.`)
    )
    .optional();
}

const persistedConfigShape = {
  apiUrl: optionalUrl,
  webUrl: optionalUrl,
  outputDir: optionalTrimmedString,
  defaultPolicyPack: optionalTrimmedString,
  defaultModelProvider: z.enum(["openai", "anthropic", "google"]).optional(),
  defaultModelId: optionalTrimmedString,
};

const secretConfigShape = {
  sentinelayerToken: createOptionalSecretSchema({
    field: "sentinelayerToken",
    minLength: 24,
    providerPattern: /^(?:sl_[A-Za-z0-9._~:/+=-]{20,}|[A-Fa-f0-9]{32,})$/,
    providerPatternHint:
      "sentinelayerToken must use the Sentinelayer token format (sl_*) unless SL_ALLOW_CUSTOM_TOKEN_FORMATS is enabled.",
  }),
  openaiApiKey: createOptionalSecretSchema({
    field: "openaiApiKey",
    minLength: 20,
    providerPattern: /^sk-[A-Za-z0-9._~:/+=-]{16,}$/,
    providerPatternHint:
      "openaiApiKey must match the OpenAI key format (sk-...) unless SL_ALLOW_CUSTOM_TOKEN_FORMATS is enabled.",
  }),
  anthropicApiKey: createOptionalSecretSchema({
    field: "anthropicApiKey",
    minLength: 20,
    providerPattern: /^sk-ant-[A-Za-z0-9._~:/+=-]{12,}$/,
    providerPatternHint:
      "anthropicApiKey must match the Anthropic key format (sk-ant-...) unless SL_ALLOW_CUSTOM_TOKEN_FORMATS is enabled.",
  }),
  googleApiKey: createOptionalSecretSchema({
    field: "googleApiKey",
    minLength: 20,
    providerPattern: /^AIza[A-Za-z0-9_-]{20,}$/,
    providerPatternHint:
      "googleApiKey must match the Google API key format (AIza...) unless SL_ALLOW_CUSTOM_TOKEN_FORMATS is enabled.",
  }),
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
