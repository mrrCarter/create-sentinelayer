/**
 * ENGRAM §1 — pluggable dense text embedder (256-d, int8, deterministic).
 *
 * Design fidelity (ENGRAM §4 model roster + §7 storage math):
 *  - 256-d Matryoshka-truncated text vectors, int8-quantized for the
 *    "exact int8 scan" recall path (§7 stage 2a). No ANN — a session is
 *    small-data (Thesis 1), so exhaustive scan is 100% recall by definition.
 *  - The interface is PLUGGABLE. The DEFAULT is a deterministic
 *    hash-projection stub (the feature-hashing trick) so the 8-Needle
 *    harness (§11) is reproducible in CI with no model download. A real
 *    EmbeddingGemma-class embedder plugs in behind the same interface via
 *    `provider: "api"`, degrading to the stub on any failure — the same
 *    provider-fallback shape the repo already uses in
 *    `src/memory/retrieval.js`.
 *
 * The stub is intentionally lexical-leaning: chains in Needle-Chain are
 * linked ONLY through shared entities (their head/tail share no tokens), so
 * chain completion is carried by the graph-expansion stage (§7 spreading
 * activation), not by dense similarity — exactly as the design intends.
 */

import { tokenize, bigrams, charNGrams, fnv1a32 } from "./text.js";

export const DEFAULT_DIM = 256;
const QUANT_SCALE = 127;

/**
 * Deterministic hash-projection into a dense float vector, then L2-normalize.
 * Signed feature hashing: each feature lands in one bucket with a stable
 * sign, so collisions cancel in expectation rather than compound.
 * @param {string} text
 * @param {number} dim
 * @returns {Float32Array}
 */
function hashProjectionFloat(text, dim) {
  const vec = new Float32Array(dim);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;
  // Features: token unigrams + token bigrams (phrase order) + character
  // trigrams per token (robust overlap for short texts). Char trigrams make
  // genuine token overlap dominate collision noise in the 256-d space.
  const features = tokens.concat(bigrams(tokens));
  for (const token of tokens) {
    for (const gram of charNGrams(token, 3)) features.push(`c:${gram}`);
  }
  for (const feature of features) {
    const bucket = fnv1a32(feature) % dim;
    const sign = (fnv1a32(`sign:${feature}`) & 1) === 1 ? 1 : -1;
    vec[bucket] += sign;
  }
  let sumSquares = 0;
  for (let i = 0; i < dim; i += 1) sumSquares += vec[i] * vec[i];
  const norm = Math.sqrt(sumSquares);
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) vec[i] /= norm;
  }
  return vec;
}

/**
 * Quantize a normalized float vector to int8 (×127, rounded, clamped).
 * @param {Float32Array} floatVec
 * @returns {Int8Array}
 */
export function quantizeInt8(floatVec) {
  const out = new Int8Array(floatVec.length);
  for (let i = 0; i < floatVec.length; i += 1) {
    const scaled = Math.round(floatVec[i] * QUANT_SCALE);
    out[i] = scaled > QUANT_SCALE ? QUANT_SCALE : scaled < -QUANT_SCALE ? -QUANT_SCALE : scaled;
  }
  return out;
}

/**
 * L2 norm of an int8 vector (computed once at index time, cached for the
 * exact-scan cosine).
 * @param {Int8Array} vec
 * @returns {number}
 */
export function normInt8(vec) {
  let sumSquares = 0;
  for (let i = 0; i < vec.length; i += 1) sumSquares += vec[i] * vec[i];
  return Math.sqrt(sumSquares);
}

/**
 * Dot product of two equal-length int8 vectors.
 * @param {Int8Array} a
 * @param {Int8Array} b
 * @returns {number}
 */
export function dotInt8(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) dot += a[i] * b[i];
  return dot;
}

/**
 * Cosine similarity of two int8 vectors given precomputed norms.
 * @returns {number} in [-1, 1]
 */
export function cosineInt8(a, b, normA, normB) {
  if (!normA || !normB) return 0;
  return dotInt8(a, b) / (normA * normB);
}

/**
 * Create an embedder. Default is the deterministic hash-projection stub.
 *
 * @param {object} [options]
 * @param {number}  [options.dim=256]
 * @param {"stub"|"api"} [options.provider="stub"]
 * @param {string} [options.endpoint="")]  Real-embedder HTTP endpoint (provider="api").
 * @param {string} [options.apiKey=""]
 * @param {Function} [options.fetchImpl]   Injected fetch (tests/provider).
 * @returns {{
 *   name: string, dim: number,
 *   embedFloat: (text: string) => Float32Array,
 *   embed: (text: string) => Int8Array,
 *   embedRemote: (text: string) => Promise<{vector: Int8Array, provider: string, fallback: boolean}>
 * }}
 */
export function createEmbedder({
  dim = DEFAULT_DIM,
  provider = "stub",
  endpoint = "",
  apiKey = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedDim = Number.isInteger(dim) && dim > 0 ? dim : DEFAULT_DIM;
  const embedFloat = (text) => hashProjectionFloat(text, normalizedDim);
  const embed = (text) => quantizeInt8(embedFloat(text));

  // Bound the remote embedder call so a hung provider can't stall recall; on
  // timeout AbortSignal rejects the fetch and we fall back to the deterministic
  // stub via the catch below.
  const EMBED_REMOTE_TIMEOUT_MS = 10_000;
  async function embedRemote(text) {
    const canUseApi =
      provider === "api" && endpoint && typeof fetchImpl === "function";
    if (!canUseApi) {
      return { vector: embed(text), provider: "stub", fallback: provider === "api" };
    }
    try {
      const response = await fetchImpl(String(endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ text: String(text ?? ""), dim: normalizedDim }),
        signal: AbortSignal.timeout(EMBED_REMOTE_TIMEOUT_MS),
      });
      if (!response || !response.ok) {
        throw new Error(`embedder api ${response ? response.status : "no_response"}`);
      }
      const payload = await response.json();
      const values = Array.isArray(payload?.vector) ? payload.vector : null;
      if (!values || values.length === 0) {
        throw new Error("embedder api returned empty vector");
      }
      // Matryoshka-truncate/pad to dim, then quantize for the shared scan path.
      const floatVec = new Float32Array(normalizedDim);
      for (let i = 0; i < normalizedDim && i < values.length; i += 1) {
        floatVec[i] = Number(values[i]) || 0;
      }
      return { vector: quantizeInt8(floatVec), provider: "api", fallback: false };
    } catch {
      return { vector: embed(text), provider: "stub", fallback: true };
    }
  }

  return {
    name: provider === "api" ? `api:${normalizedDim}` : `hash-projection:${normalizedDim}`,
    dim: normalizedDim,
    embedFloat,
    embed,
    embedRemote,
  };
}
