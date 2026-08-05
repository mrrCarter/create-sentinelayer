/**
 * Pure ENGRAM recall-index builder.
 *
 * This module accepts canonical observations only. Session event filtering is
 * an adapter concern in index-build.js, which keeps the retrieval closure
 * reusable without importing SentinelLayer session runtime.
 */

import { buildEntityGraph } from "./entities.js";
import { createEmbedder, normInt8 } from "./embedder.js";

// BM25 free parameters (Robertson/Sparck-Jones defaults — standard, not tuned).
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

function buildBm25(observations) {
  const postings = new Map();
  const docLen = new Map();
  let totalLen = 0;

  for (const obs of observations) {
    const tokens = obs.tokens;
    docLen.set(obs.id, tokens.length);
    totalLen += tokens.length;
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    for (const [term, count] of tf.entries()) {
      let bucket = postings.get(term);
      if (!bucket) {
        bucket = new Map();
        postings.set(term, bucket);
      }
      bucket.set(obs.id, count);
    }
  }

  const df = new Map();
  for (const [term, bucket] of postings.entries()) df.set(term, bucket.size);

  const N = observations.length;
  const avgdl = N > 0 ? totalLen / N : 0;
  return { postings, df, docLen, avgdl, N };
}

function buildDense(observations, embedder) {
  const vectors = new Map();
  const norms = new Map();
  for (const obs of observations) {
    const vector = embedder.embed(obs.text);
    vectors.set(obs.id, vector);
    norms.set(obs.id, normInt8(vector));
  }
  return { vectors, norms, dim: embedder.dim };
}

/** Build a recall index from already-normalized observations. */
export function buildRecallIndex({
  observations = [],
  messageActions = [],
  embedder = createEmbedder(),
  sessionId = "",
  droppedControlEvents = 0,
  materialCount = observations.length,
} = {}) {
  if (!Array.isArray(observations)) {
    throw new TypeError("observations must be an array.");
  }

  const byId = new Map();
  for (const obs of observations) byId.set(obs.id, obs);

  const order = observations
    .slice()
    .sort((a, b) => {
      const sa = a.sequenceId || 0;
      const sb = b.sequenceId || 0;
      if (sa !== sb) return sa - sb;
      return a.index - b.index;
    })
    .map((obs) => obs.id);

  const graph = buildEntityGraph(observations, messageActions);
  const bm25 = buildBm25(observations);
  const dense = buildDense(observations, embedder);

  return {
    schemaVersion: "1.0.0",
    sessionId,
    observations,
    byId,
    order,
    graph,
    bm25,
    dense,
    occurrences: graph.occurrences,
    embedder,
    meta: {
      observationCount: observations.length,
      materialCount,
      droppedControlEvents,
      entityCount: graph.counts.entities,
      edgeCount: graph.counts.edges,
      occurrenceCount: graph.counts.occurrences,
      embedder: embedder.name,
      dim: embedder.dim,
    },
  };
}
