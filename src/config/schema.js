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

export const configSchema = z
  .object({
    apiUrl: optionalUrl,
    webUrl: optionalUrl,
    outputDir: optionalTrimmedString,
    defaultModelProvider: z.enum(["openai", "anthropic", "google"]).optional(),
    defaultModelId: optionalTrimmedString,
    sentinelayerToken: optionalTrimmedString,
    openaiApiKey: optionalTrimmedString,
    anthropicApiKey: optionalTrimmedString,
    googleApiKey: optionalTrimmedString,
  })
  .strict();

export const CONFIG_KEYS = Object.freeze(Object.keys(configSchema.shape));
