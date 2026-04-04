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
const PLACEHOLDER_TOKEN_PATTERNS = [
  /(?:^|[_\-])(?:example|sample|placeholder|changeme|replace(?:[_\-]?me)?|test(?:[_\-]?key|[_\-]?token)?)(?:$|[_\-])/i,
  /(?:your[_\-]?(?:api[_\-]?key|token|secret))/i,
];

function hasSufficientTokenDiversity(value) {
  const normalized = String(value || "");
  const uniqueChars = new Set(normalized).size;
  const classes = [
    /[a-z]/.test(normalized),
    /[A-Z]/.test(normalized),
    /[0-9]/.test(normalized),
    /[^A-Za-z0-9]/.test(normalized),
  ].filter(Boolean).length;
  return uniqueChars >= 8 && classes >= 2;
}

function hasPlaceholderTokenPattern(value) {
  const normalized = String(value || "");
  return PLACEHOLDER_TOKEN_PATTERNS.some((pattern) => pattern.test(normalized));
}

function createOptionalSecretSchema({
  field,
  minLength = 20,
  maxLength = 512,
  providerPatterns = [],
}) {
  return z
    .preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .min(minLength, `${field} must be at least ${minLength} characters.`)
        .max(maxLength, `${field} must be at most ${maxLength} characters.`)
        .refine(
          (value) => /^[\x21-\x7E]+$/.test(value),
          `${field} must use printable ASCII token characters only [SL-CONFIG-SECRET-CHARSET].`
        )
        .refine(
          (value) => !hasPlaceholderTokenPattern(value),
          `${field} must not contain placeholder/test credential text [SL-CONFIG-SECRET-PLACEHOLDER].`
        )
        .refine(
          (value) => hasSufficientTokenDiversity(value),
          `${field} must include sufficient character diversity [SL-CONFIG-SECRET-STRENGTH].`
        )
        .refine((value) => {
          for (const providerPattern of providerPatterns) {
            if (providerPattern.test(value)) {
              return true;
            }
          }
          return false;
        }, `${field} must match a supported provider token shape [SL-CONFIG-SECRET-SHAPE].`)
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
    providerPatterns: [/^(?:sl_[A-Za-z0-9._~:/+=-]{20,}|[A-Fa-f0-9]{32,})$/],
  }),
  openaiApiKey: createOptionalSecretSchema({
    field: "openaiApiKey",
    minLength: 20,
    providerPatterns: [/^sk-(?:proj-)?[A-Za-z0-9._-]{16,}$/],
  }),
  anthropicApiKey: createOptionalSecretSchema({
    field: "anthropicApiKey",
    minLength: 20,
    providerPatterns: [/^sk-ant-[A-Za-z0-9._-]{12,}$/],
  }),
  googleApiKey: createOptionalSecretSchema({
    field: "googleApiKey",
    minLength: 20,
    providerPatterns: [/^AIza[A-Za-z0-9_-]{20,}$/],
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
