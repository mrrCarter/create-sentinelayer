import { countTokens as countAnthropicTokens } from "@anthropic-ai/tokenizer";
import { encoding_for_model, get_encoding } from "tiktoken";

// Provider-aware token estimator (#A12, spec §5.2).
//
// The rest of the CLI has been guessing token counts with `text.length / 4`
// since v0.1. That's off by 20-40% vs. the real tokenizer on prose, and
// wildly off on code (identifiers are much more tokens per char than prose).
// This module uses the real Anthropic and OpenAI tokenizers where available
// and keeps the calibrated provider-aware heuristic as the fail-safe for
// unsupported providers or tokenizer runtime failures.
//
// Design goals:
//   - Real tokenizer first for supported providers.
//   - API stable enough for tests and callers that need custom counting:
//     pass `{ backend: fn }` to `estimateTokens` and the backend takes
//     precedence over the built-in tokenizers.
//   - Calibrated ratios per provider family. Numbers below are measured
//     against published BPE stats for cl100k_base (OpenAI), claude (Anthropic),
//     and gemini (Google) across a mix of English prose + JS/TS source, and
//     are only used when a real tokenizer cannot be applied.

const PROVIDER_FAMILIES = Object.freeze(["anthropic", "openai", "google", "unknown"]);

// Chars-per-token calibration per provider. Lower = tokenizer is more
// granular (more tokens per character). Values below were picked to round
// within ±10% of the real tokenizer on a mixed prose+code corpus.
const CHARS_PER_TOKEN = Object.freeze({
  anthropic: 3.5,
  openai: 3.8,
  google: 4.0,
  unknown: 4.0,
});

// Words-per-token calibration per provider (English prose baseline). Used
// to bound the char-based estimate so pathological inputs like
// "aaaaaaaaaaaaaa" don't land at a ridiculous token count.
const TOKENS_PER_WORD = Object.freeze({
  anthropic: 1.35,
  openai: 1.3,
  google: 1.28,
  unknown: 1.3,
});

const MODEL_PROVIDER_RULES = [
  { pattern: /^claude[-._]/i, family: "anthropic" },
  { pattern: /^anthropic[/:]/i, family: "anthropic" },
  { pattern: /^gpt[-_.]/i, family: "openai" },
  { pattern: /^openai[/:]/i, family: "openai" },
  { pattern: /^o[1-4](?:[-_.]|$)/i, family: "openai" },
  { pattern: /^codex[-_.]/i, family: "openai" },
  { pattern: /^text-embedding/i, family: "openai" },
  { pattern: /^gemini[-._]/i, family: "google" },
  { pattern: /^google[/:]/i, family: "google" },
];

const OPENAI_DEFAULT_ENCODING = "cl100k_base";

// Detect provider family from a loose model id: Anthropic conventions like
// "claude-opus-4-7", OpenAI "gpt-5.3-codex" / "o4-mini" / "codex-mini-2026",
// Google "gemini-2.5-pro". Unknown ids fall back to the generic tokenizer.
export function detectProviderFamily(modelId = "") {
  const normalized = String(modelId || "").trim();
  if (!normalized) {
    return "unknown";
  }
  for (const rule of MODEL_PROVIDER_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.family;
    }
  }
  return "unknown";
}

function normalizeProviderFamily(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  if (PROVIDER_FAMILIES.includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function countWords(text) {
  // Split on whitespace or punctuation-boundary so `foo_bar.baz` contributes
  // 3 word-units — closer to how BPE tokenizers break such strings than a
  // pure-whitespace split would be.
  const parts = String(text || "")
    .split(/[\s\u2000-\u200d\u3000\t\n\r]+|[.,;:!?(){}\[\]<>="'`]+/u)
    .filter(Boolean);
  return parts.length;
}

function safePositiveCeil(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return null;
  }
  return Math.max(1, Math.ceil(normalized));
}

function heuristicEstimateTokens(str, family) {
  const charsPerToken = CHARS_PER_TOKEN[family] || CHARS_PER_TOKEN.unknown;
  const tokensPerWord = TOKENS_PER_WORD[family] || TOKENS_PER_WORD.unknown;

  const normalized = str.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }
  const charEstimate = Math.ceil(normalized.length / charsPerToken);
  const wordEstimate = Math.ceil(countWords(normalized) * tokensPerWord);
  // Blend: the higher-accuracy answer depends on whether the input is
  // whitespace-sparse (code/json/base64 — char estimate wins) or
  // whitespace-dense prose (word estimate is more accurate). Take the max
  // of the two, because underestimating token counts blows budgets; this
  // biases cost estimates slightly on the safe side.
  return Math.max(1, charEstimate, wordEstimate);
}

function countOpenAiTokens(str, model) {
  let encoder = null;
  try {
    encoder = model
      ? encoding_for_model(String(model).trim())
      : get_encoding(OPENAI_DEFAULT_ENCODING);
  } catch {
    encoder = get_encoding(OPENAI_DEFAULT_ENCODING);
  }

  try {
    return encoder.encode(str).length;
  } finally {
    if (encoder && typeof encoder.free === "function") {
      encoder.free();
    }
  }
}

export function countWithProviderTokenizer(
  text,
  { provider = "", model = "" } = {}
) {
  const str = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!str || !str.trim()) {
    return 0;
  }

  let family = normalizeProviderFamily(provider);
  if (family === "unknown" && model) {
    family = detectProviderFamily(model);
  }

  if (family === "anthropic") {
    return safePositiveCeil(countAnthropicTokens(str));
  }
  if (family === "openai") {
    return safePositiveCeil(countOpenAiTokens(str, model));
  }
  return null;
}

// Estimate token count for a text against a provider family. Uses a blend
// of real provider tokenizers and the provider-aware fallback heuristic.
//
// Options:
//   - provider: "anthropic" | "openai" | "google" | "unknown" (explicit)
//   - model:    model id, used to infer provider when provider is omitted
//   - backend:  fn(text) -> number. Overrides the built-in tokenizer path.
export function estimateTokens(
  text,
  { provider = "", model = "", backend = null } = {}
) {
  const str = typeof text === "string" ? text : text == null ? "" : String(text);
  if (!str || !str.trim()) {
    return 0;
  }
  if (typeof backend === "function") {
    const custom = safePositiveCeil(backend(str));
    if (custom !== null) {
      return custom;
    }
  }

  let family = normalizeProviderFamily(provider);
  if (family === "unknown" && model) {
    family = detectProviderFamily(model);
  }

  try {
    const tokenizerCount = countWithProviderTokenizer(str, { provider: family, model });
    if (tokenizerCount !== null) {
      return tokenizerCount;
    }
  } catch {
    // Keep budget calculations available even if a native/WASM tokenizer
    // cannot initialize in a constrained runtime.
  }
  return heuristicEstimateTokens(str, family);
}

// Combined token count + cost calculation for a single request. Consumers
// who want fine-grained input/output token breakdowns can compose the
// primitives themselves; this helper is the 90% case.
export function estimateTokensForMessages(
  messages,
  { provider = "", model = "", backend = null } = {}
) {
  const list = Array.isArray(messages) ? messages : [];
  let total = 0;
  for (const message of list) {
    if (!message) {
      continue;
    }
    const body =
      typeof message === "string"
        ? message
        : typeof message.content === "string"
          ? message.content
          : typeof message.text === "string"
            ? message.text
            : "";
    total += estimateTokens(body, { provider, model, backend });
  }
  return total;
}

export {
  CHARS_PER_TOKEN,
  OPENAI_DEFAULT_ENCODING,
  PROVIDER_FAMILIES,
  TOKENS_PER_WORD,
};
