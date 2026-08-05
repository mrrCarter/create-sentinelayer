/**
 * ENGRAM §1 — the Recall Engine (ENGRAM §7).
 *
 * Query path, faithful to §7 (no LLM in the hot path):
 *   1. query embed (256-d int8) + entity-mention match
 *   2a. dense candidates: EXACT int8 scan (no ANN — small-data, Thesis 1)
 *   2b. lexical candidates: BM25 (FTS5-equivalent, ruling #1), in parallel
 *   3.  RRF-pool 2a + 2b + entity matches -> candidate set (rank-based fusion)
 *   4.  bounded spreading activation: BFS over the entity graph from the
 *       pooled seeds (the first diffusion hops of §7's forward-push PPR;
 *       full ACL push-PPR is the P1 upgrade)
 *   5.  fusion score = cos + log(1+PPR-mass) + ACT-R B(m); order the pool
 *   6.  assemble results + provenance path evidence
 *
 * POOLING (RRF + expansion, builds the candidate set) and ORDERING (the
 * fusion score) are separate jobs, per §7. `candidatePoolIds` is the
 * pre-rerank pool the Needle-Scatter benchmark measures.
 *
 * Determinism: every sort has an explicit tie-breaker; B(m) `now` is
 * injectable. Same inputs -> byte-identical ranking.
 */

import { normInt8, cosineInt8 } from "./embedder.js";
import { matchQueryEntities } from "./entities.js";
import { buildProvenance, observationNeighbors } from "./provenance.js";
import { BM25_K1, BM25_B } from "./index-core.js";
import { queryTokens } from "./text.js";

export const RECALL_DEFAULTS = Object.freeze({
  k: 12,
  rrfK: 60,
  denseChannelDepth: 100, // top-N dense hits that feed RRF
  denseCosThreshold: 0.12, // dense hits below this are collision noise (esp. for the stub embedder)
  expansionHops: 8, // bounded BFS depth (>= needle chain length so 8-chains complete)
  expansionDecay: 0.85, // per-hop mass decay
  expansionSeedCount: 24, // top-RRF observations used as diffusion seeds
  hubDegreeCap: 40, // entities bound to more obs than this don't carry activation
  poolCap: 512, // hard cap on candidate-pool size
  expansionWeight: 0.1, // scales diffusion mass into the PPR-stand-in term
});

// Fusion weights. Fixed, interpretable constants for P0; learned weights
// trained on the rehearsal loop are the §7 P1 upgrade. `ppr` (the rank-based
// RRF+diffusion pool, which carries the precise BM25 signal) leads; raw cos
// from the deterministic stub is a minor tie-shaper only.
export const RECALL_WEIGHTS = Object.freeze({ cos: 0.2, ppr: 1.0, actr: 0.25 });

function sortedByScoreDesc(scoreById, order) {
  // order: canonical obs order for deterministic tie-breaking.
  const rankIndex = new Map();
  order.forEach((id, i) => rankIndex.set(id, i));
  return Array.from(scoreById.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return (rankIndex.get(a[0]) ?? 0) - (rankIndex.get(b[0]) ?? 0);
    })
    .map(([id]) => id);
}

/** Dense exact int8 scan. Returns cosById (all) + top-depth ranked list. */
function denseChannel(index, queryVec, depth, threshold) {
  const queryNorm = normInt8(queryVec);
  const cosById = new Map();
  for (const obsId of index.order) {
    const vec = index.dense.vectors.get(obsId);
    const cos = cosineInt8(queryVec, vec, queryNorm, index.dense.norms.get(obsId));
    cosById.set(obsId, cos);
  }
  const ranked = sortedByScoreDesc(
    new Map(Array.from(cosById.entries()).filter(([, cos]) => cos >= threshold)),
    index.order,
  ).slice(0, depth);
  return { cosById, ranked };
}

/** BM25 lexical channel (FTS5-equivalent). Returns scoreById + ranked list. */
function bm25Channel(index, queryTokens) {
  const { postings, df, docLen, avgdl, N } = index.bm25;
  const scoreById = new Map();
  if (N === 0 || avgdl === 0) return { scoreById, ranked: [] };
  const seen = new Set();
  for (const term of queryTokens) {
    if (seen.has(term)) continue;
    seen.add(term);
    const bucket = postings.get(term);
    if (!bucket) continue;
    const termDf = df.get(term) || bucket.size;
    const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
    for (const [obsId, tf] of bucket.entries()) {
      const dl = docLen.get(obsId) || 0;
      const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl);
      const contribution = idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
      scoreById.set(obsId, (scoreById.get(obsId) || 0) + contribution);
    }
  }
  return { scoreById, ranked: sortedByScoreDesc(scoreById, index.order) };
}

/** Entity-match channel with inverse-degree (IDF-like) weighting of hits. */
function entityChannel(index, matchedEntityIds) {
  const scoreById = new Map();
  const seedObs = new Set();
  for (const entityId of matchedEntityIds) {
    const peers = index.graph.entityToObs.get(entityId);
    if (!peers) continue;
    const degree = peers.size;
    const weight = 1 / Math.log2(2 + degree); // hubs contribute little
    const isHub = degree > RECALL_DEFAULTS.hubDegreeCap;
    for (const obsId of peers) {
      scoreById.set(obsId, (scoreById.get(obsId) || 0) + weight);
      if (!isHub) seedObs.add(obsId); // only specific entities seed expansion
    }
  }
  return { scoreById, ranked: sortedByScoreDesc(scoreById, index.order), seedObs };
}

/** Reciprocal-rank fusion over the channel ranked lists. */
function reciprocalRankFusion(rankedLists, rrfK) {
  const rrfById = new Map();
  for (const ranked of rankedLists) {
    ranked.forEach((obsId, i) => {
      const rank = i + 1;
      rrfById.set(obsId, (rrfById.get(obsId) || 0) + 1 / (rrfK + rank));
    });
  }
  return rrfById;
}

/**
 * Bounded spreading activation: BFS over the entity graph from seed
 * observations, decaying mass each hop. Returns expansionMassById (max mass
 * reached per observation). The first diffusion hops of §7's PPR.
 */
function spreadActivation(index, seedObsIds, { hops, decay, hubDegreeCap, poolCap }) {
  const massById = new Map();
  let frontier = [];
  for (const seed of seedObsIds) {
    massById.set(seed, 1);
    frontier.push(seed);
  }
  const visitedCap = poolCap * 4;
  for (let hop = 1; hop <= hops; hop += 1) {
    if (massById.size >= visitedCap) break;
    const hopMass = decay ** hop;
    const next = [];
    for (const obsId of frontier) {
      const neighbors = observationNeighbors(index, obsId, { hubDegreeCap });
      for (const neighbor of Array.from(neighbors.keys()).sort()) {
        if (!massById.has(neighbor)) {
          massById.set(neighbor, hopMass);
          next.push(neighbor);
          if (massById.size >= visitedCap) break;
        }
      }
      if (massById.size >= visitedCap) break;
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return massById;
}

/** ACT-R base-level activation: B(m) = ln Σ_j (t_now - t_j)^(-0.5). */
function actrActivation(occurrences, nowMs) {
  if (!occurrences || occurrences.length === 0) return 0;
  let sum = 0;
  for (const occ of occurrences) {
    const dtSeconds = Math.max((nowMs - (occ.atMs || 0)) / 1000, 1); // floor at 1s
    sum += dtSeconds ** -0.5;
  }
  return sum > 0 ? Math.log(sum) : 0;
}

function normalizeMap(valueById, ids) {
  let min = Infinity;
  let max = -Infinity;
  for (const id of ids) {
    const v = valueById.get(id) ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const out = new Map();
  for (const id of ids) {
    const v = valueById.get(id) ?? 0;
    out.set(id, range > 0 ? (v - min) / range : 0);
  }
  return out;
}

/**
 * Run recall over a built index.
 *
 * @param {object} index  From buildRecallIndex().
 * @param {object} params
 * @param {string} params.query   The need / question.
 * @param {number} [params.k=12]
 * @param {string} [params.role]  Optional role lens folded into the query.
 * @param {number} [params.now]   Epoch ms for ACT-R (default Date.now()).
 * @param {object} [params.weights]  Override RECALL_WEIGHTS.
 * @param {object} [params.tuning]   Override RECALL_DEFAULTS knobs.
 * @returns {{results: object[], candidatePoolIds: string[], poolSize: number,
 *            matchedEntityIds: string[], query: string, k: number, weights: object}}
 */
export function recall(index, {
  query = "",
  k = RECALL_DEFAULTS.k,
  role = "",
  now = Date.now(),
  weights = RECALL_WEIGHTS,
  tuning = {},
} = {}) {
  const cfg = { ...RECALL_DEFAULTS, ...tuning };
  const w = { ...RECALL_WEIGHTS, ...weights };
  const rawQueryText = [String(query || ""), String(role || "")].filter((s) => s.trim()).join(" ").trim();
  // Strip query stopwords so the weak deterministic stub and BM25 both focus
  // on the query's meaningful anchors (see text.js QUERY_STOPWORDS).
  const qTokens = queryTokens(rawQueryText);
  const queryText = qTokens.join(" ") || rawQueryText;
  const normalizedK = Math.max(1, Math.floor(Number(k) || RECALL_DEFAULTS.k));

  // --- Channels (2a dense / 2b lexical / entity) ---
  const queryVec = index.embedder.embed(queryText);
  const dense = denseChannel(index, queryVec, cfg.denseChannelDepth, cfg.denseCosThreshold);
  const lexical = bm25Channel(index, qTokens);
  const matchedEntityIds = matchQueryEntities(index.graph.entities, queryText);
  const entity = entityChannel(index, matchedEntityIds);

  // --- 3. RRF pool ---
  const rrfById = reciprocalRankFusion([dense.ranked, lexical.ranked, entity.ranked], cfg.rrfK);

  // Direct-match set = observations any channel ranked (rrf > 0): the query's
  // own hits, and the seed set for provenance.
  const directSeeds = new Set(rrfById.keys());

  // --- 4. Bounded spreading activation ---
  // Expansion seeds are PRECISION-GATED: only high-confidence direct matches
  // may diffuse. A BM25 hit is an exact lexical match; a strong-dense hit
  // clears a higher cos bar than the pool threshold; matched non-hub entities
  // seed too. This stops a low-confidence dense COLLISION from seeding a
  // whole unrelated cluster into the pool.
  const expansionSeeds = new Set([...lexical.ranked, ...entity.seedObs]);
  for (const id of dense.ranked) {
    if ((dense.cosById.get(id) || 0) >= cfg.seedCosThreshold) expansionSeeds.add(id);
  }
  const expansionMassById = spreadActivation(index, expansionSeeds, {
    hops: cfg.expansionHops,
    decay: cfg.expansionDecay,
    hubDegreeCap: cfg.hubDegreeCap,
    poolCap: cfg.poolCap,
  });

  // --- Candidate pool (pre-rerank): rrf>0 OR reached by expansion ---
  // Unified pool scale (the §7 "PPR mass" stand-in): a seed / direct match
  // carries base mass 1 PLUS its rank-based RRF; an item reached ONLY by
  // diffusion carries its decayed mass (< 1). So a direct query hit ALWAYS
  // outranks pure diffusion, while a deep-chain tail (pure diffusion) still
  // sits above collision noise. `expansionWeight` scales diffusion influence.
  const poolScoreById = new Map();
  const poolIdSet = new Set();
  for (const id of directSeeds) poolIdSet.add(id);
  for (const id of expansionMassById.keys()) poolIdSet.add(id);
  for (const id of poolIdSet) {
    const rrf = rrfById.get(id) || 0;
    const mass = expansionMassById.get(id) || 0;
    const isSeed = expansionSeeds.has(id);
    const graphMass = isSeed ? 1 : cfg.expansionWeight * mass;
    poolScoreById.set(id, graphMass + rrf);
  }
  // Cap the pool deterministically by pool score.
  let poolIds = sortedByScoreDesc(poolScoreById, index.order);
  if (poolIds.length > cfg.poolCap) poolIds = poolIds.slice(0, cfg.poolCap);

  // --- 5. Fusion score over the pool ---
  // Evidence TIER dominates the ordering, then the fusion blend orders within
  // a tier (§7 intent: seeds/direct matches > graph-diffused > weak signal).
  // This is what stops the stub's cos noise on a weak-direct collision from
  // outranking a legitimate graph-diffused chain member (whose cos is 0).
  //   tier 3: direct strong match (an expansion seed: BM25 hit / strong dense / entity)
  //   tier 2: reached by graph diffusion (not a seed)
  //   tier 1: weak direct only (dense hit below the seed bar, no diffusion)
  const TIER_WEIGHT = 10;
  const tierById = new Map();
  for (const id of poolIds) {
    if (expansionSeeds.has(id)) tierById.set(id, 3);
    else if ((expansionMassById.get(id) || 0) > 0) tierById.set(id, 2);
    else tierById.set(id, 1);
  }

  const cosPosById = new Map();
  const pprById = new Map();
  const actrById = new Map();
  for (const id of poolIds) {
    cosPosById.set(id, Math.max(0, dense.cosById.get(id) || 0));
    pprById.set(id, Math.log(1 + (poolScoreById.get(id) || 0)));
    actrById.set(id, actrActivation(index.occurrences.get(id), now));
  }
  const cosN = normalizeMap(cosPosById, poolIds);
  const pprN = normalizeMap(pprById, poolIds);
  const actrN = normalizeMap(actrById, poolIds);

  const finalScoreById = new Map();
  for (const id of poolIds) {
    const within =
      w.cos * (cosN.get(id) || 0) + w.ppr * (pprN.get(id) || 0) + w.actr * (actrN.get(id) || 0);
    finalScoreById.set(id, TIER_WEIGHT * (tierById.get(id) || 1) + within);
  }

  const ordered = Array.from(poolIds).sort((a, b) => {
    const sa = finalScoreById.get(a) || 0;
    const sb = finalScoreById.get(b) || 0;
    if (sb !== sa) return sb - sa;
    // tie-break: higher pool score, then more recent (sequenceId desc), then id.
    const pa = poolScoreById.get(a) || 0;
    const pb = poolScoreById.get(b) || 0;
    if (pb !== pa) return pb - pa;
    const obsA = index.byId.get(a);
    const obsB = index.byId.get(b);
    const seqA = obsA?.sequenceId || 0;
    const seqB = obsB?.sequenceId || 0;
    if (seqB !== seqA) return seqB - seqA;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const topIds = ordered.slice(0, normalizedK);

  // --- 6. Assemble results + provenance ---
  const denseTopSet = new Set(dense.ranked);
  const bm25Set = new Set(lexical.ranked);
  const entitySet = new Set(entity.ranked);
  const results = topIds.map((id) => {
    const obs = index.byId.get(id);
    const channels = [];
    if (denseTopSet.has(id)) channels.push("dense");
    if (bm25Set.has(id)) channels.push("bm25");
    if (entitySet.has(id)) channels.push("entity");
    const provenance = buildProvenance(
      index,
      id,
      { obsIds: directSeeds, entityIds: matchedEntityIds, channels },
      { maxHops: 4, hubDegreeCap: cfg.hubDegreeCap },
    );
    return {
      observationId: id,
      sequenceId: obs?.sequenceId || 0,
      ts: obs?.ts || "",
      agentId: obs?.agentId || "",
      kind: obs?.kind || "",
      snippet: obs?.snippet || "",
      text: obs?.text || "",
      score: Number((finalScoreById.get(id) || 0).toFixed(6)),
      breakdown: {
        cos: Number((dense.cosById.get(id) || 0).toFixed(6)),
        rrf: Number((rrfById.get(id) || 0).toFixed(6)),
        expansion: Number((expansionMassById.get(id) || 0).toFixed(6)),
        actr: Number((actrById.get(id) || 0).toFixed(6)),
        channels,
        viaExpansionOnly: !directSeeds.has(id),
      },
      provenance,
    };
  });

  return {
    query: queryText,
    k: normalizedK,
    results,
    candidatePoolIds: poolIds,
    poolSize: poolIds.length,
    matchedEntityIds,
    weights: w,
    tuning: cfg,
  };
}
