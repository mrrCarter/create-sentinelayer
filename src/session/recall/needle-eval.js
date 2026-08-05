/**
 * ENGRAM §1 — the 8-Needle eval harness (ENGRAM §11) + recall QA (§6 step 9).
 *
 * Two complementary axes, both as hard gates:
 *   - Needle-Chain (DEPTH): plant chains of N memories linked ONLY through
 *     shared entities; query the head with a paraphrase; success = the TAIL
 *     memory in the top-20. This tests depth through the graph — the tail is
 *     lexically disjoint from the head, so it is reachable only by spreading
 *     activation over the entity graph. Gate: >= 95% chain completion.
 *   - Needle-Scatter (BREADTH): 8 relevant memories dispersed across the
 *     corpus; success = the pre-rerank candidate pool contains them. Gate:
 *     >= 95% present in the pool.
 * Plus recall@10 >= 0.95 vs exact brute-force ground truth.
 *
 * Everything is generated from a seeded PRNG so the harness is byte-
 * reproducible in CI with the deterministic hash-projection embedder — no
 * model download, no network.
 */

import { buildRecallIndex } from "./index-core.js";
import { createEmbedder } from "./embedder.js";
import { buildEventObservations } from "./observation-core.js";
import { recall } from "./retrieve.js";

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_TS_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const STEP_MS = 60_000; // one minute between events

function tsAt(seq) {
  return new Date(BASE_TS_MS + seq * STEP_MS).toISOString();
}

// Opaque, non-stem-sharing random token. Distinct tokens share char n-grams
// only by rare chance, so the corpus's ONLY intra-chain linkage is the entity
// graph (never lexical stems) — the faithful Needle-Chain construction.
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randToken(rand, len = 8) {
  let out = "";
  for (let i = 0; i < len; i += 1) out += TOKEN_ALPHABET[Math.floor(rand() * TOKEN_ALPHABET.length)];
  return out;
}

function message(seq, agentId, text, topics, eventId) {
  return {
    stream: "sl_event",
    event: "session_message",
    eventId,
    agent: { id: agentId },
    payload: { message: text, topics },
    ts: tsAt(seq),
    sequenceId: seq,
  };
}

/**
 * Needle-Chain corpus. Each chain's N memories are linked ONLY through
 * per-link topic entities (never through shared text). The head carries a
 * distinctive salted subject; the query paraphrases it. The tail is
 * lexically disjoint from the head.
 */
export function buildChainCorpus({ chains = 150, chainLen = 8, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const events = [];
  const chainQueries = [];
  let seq = 1;
  const agents = ["codex", "claude", "relay", "warden", "atlas"];

  for (let i = 0; i < chains; i += 1) {
    const headTokenA = randToken(rand);
    const headTokenB = randToken(rand);
    // Per-link opaque topic entities — the ONLY thing linking consecutive
    // memories (never shared text).
    const linkTokens = [];
    for (let j = 0; j < chainLen - 1; j += 1) linkTokens.push(`link${randToken(rand)}`);
    const memberIds = [];
    for (let j = 0; j < chainLen; j += 1) {
      const agentId = agents[Math.floor(rand() * agents.length)];
      const eventId = `c${i}-m${j}`;
      const topics = [];
      if (j > 0) topics.push(linkTokens[j - 1]);
      if (j < chainLen - 1) topics.push(linkTokens[j]);
      let text;
      if (j === 0) {
        text = `${headTokenA} ${headTokenB} ${randToken(rand)}`;
      } else if (j === chainLen - 1) {
        text = `${randToken(rand)} ${randToken(rand)} ${randToken(rand)}`;
      } else {
        text = `${randToken(rand)} ${randToken(rand)}`;
      }
      events.push(message(seq, agentId, text, topics, eventId));
      memberIds.push(eventId);
      seq += 1;
      // Intersperse a distractor so chains are dispersed, not contiguous.
      if (rand() < 0.5) {
        events.push(message(seq, agents[Math.floor(rand() * agents.length)], `${randToken(rand)} ${randToken(rand)}`, [], `c${i}-n${j}`));
        seq += 1;
      }
    }
    // Paraphrase of the head: reordered head tokens + generic verbs that never
    // appear in the corpus (and are stripped as stopwords anyway).
    chainQueries.push({
      chainId: i,
      query: `recall the ${headTokenB} about ${headTokenA}`,
      headId: memberIds[0],
      tailId: memberIds[chainLen - 1],
      memberIds,
    });
  }
  return { events, chainQueries, lastSeq: seq };
}

/**
 * Needle-Scatter corpus. Each query has `relevants` memories that share a
 * distinctive salted token, dispersed among distractors.
 */
export function buildScatterCorpus({ queries = 60, relevants = 8, distractorsPerQuery = 12, seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const events = [];
  const scatterQueries = [];
  const agents = ["codex", "claude", "relay", "warden", "atlas"];
  let seq = 1;

  // Build a flat pool of (queryIndex, kind) slots then shuffle for dispersion.
  const slots = [];
  for (let q = 0; q < queries; q += 1) {
    for (let r = 0; r < relevants; r += 1) slots.push({ q, r, relevant: true });
    for (let d = 0; d < distractorsPerQuery; d += 1) slots.push({ q, d, relevant: false });
  }
  // Deterministic Fisher-Yates shuffle.
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  // Opaque per-query subject token (shared by that query's relevants) and a
  // per-query topic entity; distinct across queries (no stem sharing).
  const subjectTokens = [];
  const topicTokens = [];
  for (let q = 0; q < queries; q += 1) {
    subjectTokens.push(randToken(rand));
    topicTokens.push(`topic${randToken(rand)}`);
  }

  const relevantIdsByQuery = new Map();
  for (const slot of slots) {
    const agentId = agents[Math.floor(rand() * agents.length)];
    if (slot.relevant) {
      const eventId = `s${slot.q}-r${slot.r}`;
      events.push(message(seq, agentId, `${subjectTokens[slot.q]} ${randToken(rand)} ${randToken(rand)}`, [topicTokens[slot.q]], eventId));
      if (!relevantIdsByQuery.has(slot.q)) relevantIdsByQuery.set(slot.q, new Set());
      relevantIdsByQuery.get(slot.q).add(eventId);
    } else {
      events.push(message(seq, agentId, `${randToken(rand)} ${randToken(rand)}`, [], `s${slot.q}-d${slot.d}`));
    }
    seq += 1;
  }
  for (let q = 0; q < queries; q += 1) {
    scatterQueries.push({
      queryIndex: q,
      query: `what do we know about ${subjectTokens[q]}`,
      relevantIds: relevantIdsByQuery.get(q) || new Set(),
    });
  }
  return { events, scatterQueries, lastSeq: seq };
}

export function evaluateChain(index, chainQueries, { k = 20, now } = {}) {
  let completed = 0;
  const misses = [];
  for (const cq of chainQueries) {
    const result = recall(index, { query: cq.query, k, now });
    const ids = new Set(result.results.map((r) => r.observationId));
    if (ids.has(cq.tailId)) completed += 1;
    else misses.push(cq.chainId);
  }
  const total = chainQueries.length;
  return { total, completed, rate: total > 0 ? completed / total : 1, misses };
}

export function evaluateScatter(index, scatterQueries, { now } = {}) {
  let fractionSum = 0;
  const misses = [];
  for (const sq of scatterQueries) {
    const result = recall(index, { query: sq.query, k: 20, now });
    const pool = new Set(result.candidatePoolIds);
    let present = 0;
    for (const id of sq.relevantIds) if (pool.has(id)) present += 1;
    const denom = sq.relevantIds.size || 1;
    fractionSum += present / denom;
    if (present / denom < 1) misses.push({ q: sq.queryIndex, present, of: denom });
  }
  const total = scatterQueries.length;
  return { total, rate: total > 0 ? fractionSum / total : 1, misses };
}

export function evaluateRecallAt10(index, scatterQueries, { now } = {}) {
  let recallSum = 0;
  for (const sq of scatterQueries) {
    const result = recall(index, { query: sq.query, k: 10, now });
    const top10 = result.results.slice(0, 10).map((r) => r.observationId);
    let hit = 0;
    for (const id of top10) if (sq.relevantIds.has(id)) hit += 1;
    const denom = Math.min(10, sq.relevantIds.size || 1);
    recallSum += hit / denom;
  }
  const total = scatterQueries.length;
  return { total, rate: total > 0 ? recallSum / total : 1 };
}

/**
 * Run the full 8-Needle evaluation. Returns metrics + a pass/fail per gate.
 *
 * @param {object} [options]
 * @param {number} [options.chains=150]
 * @param {number} [options.chainLen=8]
 * @param {number} [options.scatterQueries=60]
 * @param {number} [options.relevants=8]
 * @param {number} [options.seed=1]
 * @param {object} [options.embedder]
 * @returns {object}
 */
export function runEightNeedle({
  chains = 150,
  chainLen = 8,
  scatterQueries = 60,
  relevants = 8,
  distractorsPerQuery = 12,
  seed = 1,
  embedder = createEmbedder(),
  gates = { chain: 0.95, scatter: 0.95, recallAt10: 0.95 },
} = {}) {
  const chain = buildChainCorpus({ chains, chainLen, seed });
  const scatter = buildScatterCorpus({ queries: scatterQueries, relevants, distractorsPerQuery, seed: seed + 100 });

  const chainObservations = buildEventObservations(chain.events, { sessionId: "needle-chain" });
  const scatterObservations = buildEventObservations(scatter.events, { sessionId: "needle-scatter" });
  const chainIndex = buildRecallIndex({
    observations: chainObservations.observations,
    embedder,
    sessionId: "needle-chain",
  });
  const scatterIndex = buildRecallIndex({
    observations: scatterObservations.observations,
    embedder,
    sessionId: "needle-scatter",
  });

  // Fixed "now" strictly after every corpus timestamp -> deterministic B(m).
  const nowMs = BASE_TS_MS + (Math.max(chain.lastSeq, scatter.lastSeq) + 10) * STEP_MS;

  const chainResult = evaluateChain(chainIndex, chain.chainQueries, { k: 20, now: nowMs });
  const scatterResult = evaluateScatter(scatterIndex, scatter.scatterQueries, { now: nowMs });
  const recallAt10Result = evaluateRecallAt10(scatterIndex, scatter.scatterQueries, { now: nowMs });

  const pass =
    chainResult.rate >= gates.chain &&
    scatterResult.rate >= gates.scatter &&
    recallAt10Result.rate >= gates.recallAt10;

  return {
    config: { chains, chainLen, scatterQueries, relevants, distractorsPerQuery, seed, embedder: embedder.name },
    corpusSizes: { chainEvents: chain.events.length, scatterEvents: scatter.events.length },
    needleChain: { rate: chainResult.rate, completed: chainResult.completed, total: chainResult.total, gate: gates.chain, pass: chainResult.rate >= gates.chain },
    needleScatter: { rate: scatterResult.rate, total: scatterResult.total, gate: gates.scatter, pass: scatterResult.rate >= gates.scatter },
    recallAt10: { rate: recallAt10Result.rate, total: recallAt10Result.total, gate: gates.recallAt10, pass: recallAt10Result.rate >= gates.recallAt10 },
    pass,
  };
}
