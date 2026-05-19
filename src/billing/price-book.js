export const PRICE_BOOK_VERSION = "2026-05-19";

export const PRICE_BOOK_SOURCES = Object.freeze({
  openai: "https://platform.openai.com/docs/pricing",
  openaiCodex: "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
});

const RATE = (inputPerMTok, outputPerMTok, source, aliases = []) =>
  Object.freeze({
    inputPerMTok,
    outputPerMTok,
    currency: "USD",
    source,
    aliases,
  });

export const PRICE_BOOK = Object.freeze({
  "gpt-5.4-mini": RATE(0.75, 4.5, "openai"),
  "gpt-5.3-codex": RATE(1.75, 14, "openaiCodex"),
  "gpt-5.2-codex": RATE(1.75, 14, "openai"),
  "gpt-5.1-codex": RATE(1.25, 10, "openai"),
  "gpt-5-codex": RATE(1.25, 10, "openai"),
  "gpt-4.1-mini": RATE(0.4, 1.6, "openai"),
  "claude-opus-4.1": RATE(15, 75, "anthropic", ["claude-opus-4-7"]),
  "claude-opus-4": RATE(15, 75, "anthropic", ["claude-opus-4-6"]),
  "claude-sonnet-4": RATE(3, 15, "anthropic", ["claude-sonnet-4-6"]),
  "claude-sonnet-3.7": RATE(3, 15, "anthropic"),
  "claude-sonnet-3.5": RATE(3, 15, "anthropic"),
  "claude-haiku-3.5": RATE(0.8, 4, "anthropic"),
  "claude-haiku-3": RATE(0.25, 1.25, "anthropic"),
});

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeModel(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeTokenCount(value, field) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return Math.floor(parsed);
}

function round6(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

const ALIAS_TO_MODEL = Object.freeze(
  Object.entries(PRICE_BOOK).reduce((acc, [model, rate]) => {
    acc[model] = model;
    for (const alias of rate.aliases || []) {
      acc[normalizeModel(alias)] = model;
    }
    return acc;
  }, {}),
);

export function resolvePriceBookRate(model) {
  const requestedModel = normalizeString(model);
  const normalized = normalizeModel(requestedModel);
  const canonicalModel = ALIAS_TO_MODEL[normalized] || normalized;
  const rate = PRICE_BOOK[canonicalModel] || null;
  if (!rate) {
    return {
      model: requestedModel,
      canonicalModel: normalized || requestedModel,
      rate: null,
      unpriced: true,
      priceBookVersion: PRICE_BOOK_VERSION,
    };
  }
  return {
    model: requestedModel || canonicalModel,
    canonicalModel,
    rate,
    unpriced: false,
    priceBookVersion: PRICE_BOOK_VERSION,
  };
}

export function computeProviderCost({
  model,
  inputTokens = 0,
  outputTokens = 0,
} = {}) {
  const input = normalizeTokenCount(inputTokens, "inputTokens");
  const output = normalizeTokenCount(outputTokens, "outputTokens");
  const resolved = resolvePriceBookRate(model);
  if (resolved.unpriced) {
    return {
      model: resolved.model,
      canonicalModel: resolved.canonicalModel,
      priceBookVersion: PRICE_BOOK_VERSION,
      providerCostUsd: null,
      unpriced: true,
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
    };
  }
  const providerCostUsd = round6(
    (input / 1_000_000) * resolved.rate.inputPerMTok +
      (output / 1_000_000) * resolved.rate.outputPerMTok,
  );
  return {
    model: resolved.model,
    canonicalModel: resolved.canonicalModel,
    priceBookVersion: PRICE_BOOK_VERSION,
    providerCostUsd,
    unpriced: false,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    currency: resolved.rate.currency,
    source: resolved.rate.source,
  };
}
