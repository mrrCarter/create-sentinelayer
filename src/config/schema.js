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
const optionalStringArray = z
  .array(z.preprocess(emptyToUndefined, z.string().min(1)))
  .optional();

const alertsChannelSchema = z
  .object({
    type: optionalTrimmedString,
    webhook_url: optionalTrimmedString,
    webhookUrl: optionalTrimmedString,
    url: optionalTrimmedString,
    bot_token: optionalTrimmedString,
    botToken: optionalTrimmedString,
    chat_id: optionalTrimmedString,
    chatId: optionalTrimmedString,
  })
  .passthrough();

const alertsConfigSchema = z
  .object({
    channels: z.array(alertsChannelSchema).optional(),
    frequency: optionalTrimmedString,
    events: optionalStringArray,
  })
  .passthrough()
  .optional();

export const configSchema = z
  .object({
    apiUrl: optionalUrl,
    webUrl: optionalUrl,
    outputDir: optionalTrimmedString,
    defaultPolicyPack: optionalTrimmedString,
    defaultModelProvider: z.enum(["openai", "anthropic", "google"]).optional(),
    defaultModelId: optionalTrimmedString,
    sentinelayerToken: optionalTrimmedString,
    openaiApiKey: optionalTrimmedString,
    anthropicApiKey: optionalTrimmedString,
    googleApiKey: optionalTrimmedString,
    alerts: alertsConfigSchema,
  })
  .strict();

export const CONFIG_KEYS = Object.freeze(Object.keys(configSchema.shape));
