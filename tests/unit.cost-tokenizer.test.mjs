// Unit tests for src/cost/tokenizer.js (#A12 provider-aware token estimator).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHARS_PER_TOKEN,
  PROVIDER_FAMILIES,
  TOKENS_PER_WORD,
  detectProviderFamily,
  estimateTokens,
  estimateTokensForMessages,
} from "../src/cost/tokenizer.js";
import { estimateCostForText } from "../src/cost/tracker.js";

test("PROVIDER_FAMILIES covers the providers we ship", () => {
  assert.ok(PROVIDER_FAMILIES.includes("anthropic"));
  assert.ok(PROVIDER_FAMILIES.includes("openai"));
  assert.ok(PROVIDER_FAMILIES.includes("google"));
  assert.ok(PROVIDER_FAMILIES.includes("unknown"));
});

test("detectProviderFamily: Claude model ids", () => {
  assert.equal(detectProviderFamily("claude-opus-4-7"), "anthropic");
  assert.equal(detectProviderFamily("claude-sonnet-4-6"), "anthropic");
  assert.equal(detectProviderFamily("anthropic/claude-3-haiku"), "anthropic");
});

test("detectProviderFamily: OpenAI model ids", () => {
  assert.equal(detectProviderFamily("gpt-4o"), "openai");
  assert.equal(detectProviderFamily("gpt-5.3-codex"), "openai");
  assert.equal(detectProviderFamily("o4-mini"), "openai");
  assert.equal(detectProviderFamily("codex-mini-2026"), "openai");
  assert.equal(detectProviderFamily("openai/gpt-4-turbo"), "openai");
  assert.equal(detectProviderFamily("text-embedding-3-small"), "openai");
});

test("detectProviderFamily: Google model ids", () => {
  assert.equal(detectProviderFamily("gemini-2.5-pro"), "google");
  assert.equal(detectProviderFamily("gemini-1.5-flash"), "google");
  assert.equal(detectProviderFamily("google/gemini-2"), "google");
});

test("detectProviderFamily: unknown ids fall back to `unknown`", () => {
  assert.equal(detectProviderFamily("llama3-70b"), "unknown");
  assert.equal(detectProviderFamily(""), "unknown");
  assert.equal(detectProviderFamily(null), "unknown");
});

test("estimateTokens: empty input → 0 tokens", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens("   \n\t  "), 0);
});

test("estimateTokens: tokenizer backend override wins", () => {
  const tokens = estimateTokens("hello world", {
    provider: "openai",
    backend: () => 42,
  });
  assert.equal(tokens, 42);
});

test("estimateTokens: backend returning invalid value falls back to heuristic", () => {
  const tokens = estimateTokens("hello world", {
    provider: "openai",
    backend: () => NaN,
  });
  assert.ok(tokens > 0);
});

test("estimateTokens: per-provider ratios are distinct", () => {
  const sample = "The quick brown fox jumps over the lazy dog.".repeat(50);
  const anthropic = estimateTokens(sample, { provider: "anthropic" });
  const openai = estimateTokens(sample, { provider: "openai" });
  const google = estimateTokens(sample, { provider: "google" });
  // Anthropic's ratio is tighter (fewer chars per token) so it yields more
  // tokens for the same text than OpenAI or Google.
  assert.ok(anthropic > openai, "anthropic should estimate more than openai");
  assert.ok(openai >= google, "openai should estimate ≥ google");
});

test("estimateTokens: model id alone infers provider family", () => {
  const claude = estimateTokens("hello there fellow developer", {
    model: "claude-opus-4-7",
  });
  const gpt = estimateTokens("hello there fellow developer", {
    model: "gpt-5.3-codex",
  });
  assert.ok(claude >= gpt);
});

test("estimateTokens: code-like input produces higher count than length/4 alone", () => {
  // Old formula: Math.ceil(47 / 4) = 12. Provider-aware should be higher
  // because camelCase/underscores generate more tokens per character.
  const codey = "function renderUserProfileCard(props) { return null; }";
  const tokens = estimateTokens(codey, { provider: "openai" });
  assert.ok(tokens > Math.ceil(codey.length / 4));
});

test("estimateTokens: strips whitespace before measuring", () => {
  const lean = estimateTokens("hello world", { provider: "openai" });
  const padded = estimateTokens("   hello     world   ", { provider: "openai" });
  // Whitespace collapses, so the two should match exactly.
  assert.equal(padded, lean);
});

test("estimateTokens: minimum output for non-empty string is 1", () => {
  assert.ok(estimateTokens("a", { provider: "openai" }) >= 1);
});

test("estimateTokensForMessages: aggregates a chat-style transcript", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Please summarize the README." },
    { role: "assistant", content: "Sure — here's the summary..." },
  ];
  const total = estimateTokensForMessages(messages, { provider: "anthropic" });
  const manualSum = messages.reduce(
    (acc, m) => acc + estimateTokens(m.content, { provider: "anthropic" }),
    0
  );
  assert.equal(total, manualSum);
});

test("estimateTokensForMessages: handles legacy {text} shape and strings", () => {
  const messages = [
    "just a bare string",
    { text: "and a text field instead of content" },
  ];
  const total = estimateTokensForMessages(messages, { provider: "openai" });
  assert.ok(total > 0);
});

test("estimateTokensForMessages: empty / malformed entries don't crash", () => {
  const total = estimateTokensForMessages([null, undefined, {}, { content: "" }], {
    provider: "openai",
  });
  assert.equal(total, 0);
});

test("CHARS_PER_TOKEN / TOKENS_PER_WORD tables are frozen", () => {
  assert.ok(Object.isFrozen(CHARS_PER_TOKEN));
  assert.ok(Object.isFrozen(TOKENS_PER_WORD));
});

test("estimateCostForText: combines tokenizer + pricing table", () => {
  const result = estimateCostForText({
    modelId: "claude-opus-4-7",
    inputText: "Summarize this paragraph in one sentence.",
    outputText: "The paragraph covers a topic concisely.",
  });
  assert.equal(result.modelId, "claude-opus-4-7");
  assert.ok(result.inputTokens > 0);
  assert.ok(result.outputTokens > 0);
  assert.ok(result.costUsd > 0);
});

test("estimateCostForText: rejects empty modelId", () => {
  assert.throws(
    () => estimateCostForText({ modelId: "", inputText: "x" }),
    /modelId is required/
  );
});

test("estimateCostForText: Opus is pricier than Sonnet for the same text", () => {
  const sample =
    "Review the diff and summarize observations in a few short bullet points.";
  const opus = estimateCostForText({
    modelId: "claude-opus-4-7",
    inputText: sample,
    outputText: sample,
  });
  const sonnet = estimateCostForText({
    modelId: "claude-sonnet-4-6",
    inputText: sample,
    outputText: sample,
  });
  assert.ok(opus.costUsd > sonnet.costUsd);
});
