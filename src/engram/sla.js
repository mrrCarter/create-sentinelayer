/**
 * ENGRAM §2 — the Memory-as-a-Service quality SLA (namespace-agnostic).
 *
 * The §1 8-Needle eval (ENGRAM §11) becomes the MaaS SLA, run OVER A NAMESPACE
 * through the shared store: corpora are `memory.write`-shaped items written to
 * a namespace, then recalled through the same store the tools use. This proves
 * the SLA holds for ANY namespace (not just sessions), which is the
 * detachability guarantee.
 *
 * Reuses the §1 corpus builders + evaluators verbatim (no reimplementation).
 */

import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  buildChainCorpus,
  buildScatterCorpus,
  evaluateChain,
  evaluateScatter,
  evaluateRecallAt10,
} from "../session/recall/needle-eval.js";
import { buildRecallIndex } from "../session/recall/index-build.js";
import { createEmbedder } from "../session/recall/embedder.js";
import { createStore } from "./store.js";
import { parseNamespace } from "./namespace.js";

function eventToItem(event) {
  return {
    id: event.eventId,
    text: event?.payload?.message || "",
    kind: event.event,
    author: event?.agent?.id,
    ts: event.ts,
    topics: event?.payload?.topics,
    sequenceId: event.sequenceId,
  };
}

function latestTsMs(events) {
  let max = 0;
  for (const e of events) {
    const ms = Date.parse(e.ts);
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max;
}

/**
 * Run the 8-Needle SLA over the namespace store.
 * @param {object} [options]
 * @returns {Promise<object>} metrics + pass/fail per gate
 */
export async function runEngramSla({
  chains = 120,
  chainLen = 8,
  scatterQueries = 50,
  relevants = 8,
  seed = 1,
  embedder = createEmbedder(),
  storeRoot = null,
  gates = { chain: 0.95, scatter: 0.95, recallAt10: 0.95 },
} = {}) {
  const root = storeRoot || (await mkdtemp(path.join(os.tmpdir(), "engram-sla-")));
  const cleanup = !storeRoot;
  try {
    const store = createStore({ storeRoot: root, adapters: {} });
    const chain = buildChainCorpus({ chains, chainLen, seed });
    const scatter = buildScatterCorpus({ queries: scatterQueries, relevants, seed: seed + 100 });

    const chainNs = parseNamespace("ns:sla-chain");
    const scatterNs = parseNamespace("ns:sla-scatter");
    await store.appendItems(chainNs, chain.events.map(eventToItem));
    await store.appendItems(scatterNs, scatter.events.map(eventToItem));

    const chainObs = await store.readObservations(chainNs);
    const scatterObs = await store.readObservations(scatterNs);
    const chainIndex = buildRecallIndex({ observations: chainObs, embedder, sessionId: chainNs.raw });
    const scatterIndex = buildRecallIndex({ observations: scatterObs, embedder, sessionId: scatterNs.raw });

    // Deterministic ACT-R clock, strictly after every corpus timestamp.
    const nowMs = Math.max(latestTsMs(chain.events), latestTsMs(scatter.events)) + 10 * 60_000;

    const chainResult = evaluateChain(chainIndex, chain.chainQueries, { k: 20, now: nowMs });
    const scatterResult = evaluateScatter(scatterIndex, scatter.scatterQueries, { now: nowMs });
    const recallAt10Result = evaluateRecallAt10(scatterIndex, scatter.scatterQueries, { now: nowMs });

    const pass =
      chainResult.rate >= gates.chain &&
      scatterResult.rate >= gates.scatter &&
      recallAt10Result.rate >= gates.recallAt10;

    return {
      config: { chains, chainLen, scatterQueries, relevants, seed, embedder: embedder.name, path: "namespace-store" },
      needleChain: { rate: chainResult.rate, completed: chainResult.completed, total: chainResult.total, gate: gates.chain, pass: chainResult.rate >= gates.chain },
      needleScatter: { rate: scatterResult.rate, total: scatterResult.total, gate: gates.scatter, pass: scatterResult.rate >= gates.scatter },
      recallAt10: { rate: recallAt10Result.rate, total: recallAt10Result.total, gate: gates.recallAt10, pass: recallAt10Result.rate >= gates.recallAt10 },
      pass,
    };
  } finally {
    if (cleanup) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
