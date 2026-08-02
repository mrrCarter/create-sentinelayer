/**
 * ENGRAM §1 — build the recall index over a session's events.
 *
 * Produces the immutable tri-layer store plus the two derived retrieval
 * structures the Recall Engine (§7) needs:
 *   - dense : 256-d int8 vectors + cached norms for the EXACT int8 scan
 *             (no ANN — session is small-data, Thesis 1).
 *   - bm25  : an inverted index for the lexical channel. This is the
 *             "BM25 lexical (FTS5-equivalent)" mechanism from §7 stage 2b.
 *             Per relay ruling #1: FTS5 *is* SQLite's BM25 implementation;
 *             the CLI has no SQLite (NDJSON store, Node ^20, native-dep +
 *             publish fragility) and the 8-Needle eval requires determinism,
 *             so we implement the same BM25 mechanism in pure JS. Only the
 *             storage engine differs; the retrieval mechanism is faithful.
 *
 * Everything here is idempotent and rebuildable from the immutable
 * observations (ENGRAM §8 "vectors and graph are derived, SQLite is truth"
 * — here: derived, the NDJSON stream is truth).
 */

import { buildObservations } from "./observations.js";
import { buildEntityGraph } from "./entities.js";
import { createEmbedder, normInt8 } from "./embedder.js";

// BM25 free parameters (Robertson/Sparck-Jones defaults — standard, not tuned).
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

function buildBm25(observations) {
  const postings = new Map(); // term -> Map<obsId, tf>
  const docLen = new Map(); // obsId -> token count
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
  const vectors = new Map(); // obsId -> Int8Array
  const norms = new Map(); // obsId -> number
  for (const obs of observations) {
    const vector = embedder.embed(obs.text);
    vectors.set(obs.id, vector);
    norms.set(obs.id, normInt8(vector));
  }
  return { vectors, norms, dim: embedder.dim };
}

/**
 * Build a full recall index.
 *
 * Accepts EITHER raw session `events` (builds observations via the session
 * adapter) OR pre-built `observations` (ENGRAM §2: the namespace store already
 * mapped items/events to observations). `sessionId` is an opaque namespace id.
 *
 * @param {object}   params
 * @param {object[]} [params.events]          Raw session events (local NDJSON shape).
 * @param {object[]} [params.observations]    Pre-built observations (bypasses buildObservations).
 * @param {object[]} [params.messageActions]  Raw actions (ACT-R fuel + reply edges).
 * @param {object}   [params.embedder]        Pluggable embedder (default: hash-projection stub).
 * @param {string}   [params.sessionId]       Opaque namespace/session id (meta + id-fallback).
 * @param {boolean}  [params.includeControlEvents=false]
 * @returns {object} index
 */
export function buildRecallIndex({
  events = [],
  observations: prebuiltObservations = null,
  messageActions = [],
  embedder = createEmbedder(),
  sessionId = "",
  includeControlEvents = false,
} = {}) {
  const built = Array.isArray(prebuiltObservations)
    ? { observations: prebuiltObservations, droppedControlEvents: 0, materialCount: prebuiltObservations.length }
    : buildObservations(events, { sessionId, includeControlEvents });
  const { observations, droppedControlEvents, materialCount } = built;

  const byId = new Map();
  for (const obs of observations) byId.set(obs.id, obs);

  // Deterministic canonical order: by sequenceId when present, else input index.
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
