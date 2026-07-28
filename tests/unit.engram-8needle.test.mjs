import test from "node:test";
import assert from "node:assert/strict";

import {
  runEightNeedle,
  buildChainCorpus,
  buildScatterCorpus,
} from "../src/session/recall/needle-eval.js";
import { buildRecallIndex } from "../src/session/recall/index-build.js";
import { recall } from "../src/session/recall/retrieve.js";

// CI-appropriate size (fast, ~1s). The full ENGRAM §11 scale (500 chains) is
// documented in tasks/evals/engram-s1-session-recall.md and passes the same
// gates; kept smaller here to keep the unit suite quick.
const CONFIG = { chains: 150, chainLen: 8, scatterQueries: 60, relevants: 8, seed: 1 };

test("Unit engram 8-Needle: all gates pass (Chain >=95%, Scatter >=95%, recall@10 >=95%)", () => {
  const r = runEightNeedle(CONFIG);
  assert.ok(r.needleChain.rate >= 0.95, `Needle-Chain ${r.needleChain.rate} < 0.95`);
  assert.ok(r.needleScatter.rate >= 0.95, `Needle-Scatter ${r.needleScatter.rate} < 0.95`);
  assert.ok(r.recallAt10.rate >= 0.95, `recall@10 ${r.recallAt10.rate} < 0.95`);
  assert.equal(r.pass, true);
});

test("Unit engram 8-Needle: deterministic across runs and seeds", () => {
  const a = runEightNeedle(CONFIG);
  const b = runEightNeedle(CONFIG);
  assert.equal(a.needleChain.rate, b.needleChain.rate);
  assert.equal(a.recallAt10.rate, b.recallAt10.rate);
  for (const seed of [2, 3]) {
    const r = runEightNeedle({ ...CONFIG, seed });
    assert.ok(r.pass, `seed ${seed} failed a gate`);
  }
});

test("Unit engram 8-Needle: the Chain benchmark has teeth (collapses without graph diffusion)", () => {
  // With expansion disabled the tail is lexically unreachable from the head,
  // so chain completion must collapse toward 0 — proving the >=95% pass is
  // earned by genuine spreading activation, not by lexical leakage.
  const chain = buildChainCorpus({ chains: 120, chainLen: 8, seed: 1 });
  const index = buildRecallIndex({ events: chain.events, sessionId: "needle-chain" });
  const now = Date.UTC(2027, 0, 1);
  let completed = 0;
  for (const cq of chain.chainQueries) {
    const res = recall(index, { query: cq.query, k: 20, now, tuning: { expansionHops: 0 } });
    if (res.results.some((r) => r.observationId === cq.tailId)) completed += 1;
  }
  const rate = completed / chain.chainQueries.length;
  assert.ok(rate < 0.1, `expected chain to collapse without diffusion, got ${rate}`);
});

test("Unit engram 8-Needle: Scatter pool contains the dispersed relevants", () => {
  const scatter = buildScatterCorpus({ queries: 40, relevants: 8, seed: 200 });
  const index = buildRecallIndex({ events: scatter.events, sessionId: "needle-scatter" });
  const now = Date.UTC(2027, 0, 1);
  for (const sq of scatter.scatterQueries.slice(0, 5)) {
    const res = recall(index, { query: sq.query, k: 20, now });
    const pool = new Set(res.candidatePoolIds);
    let present = 0;
    for (const id of sq.relevantIds) if (pool.has(id)) present += 1;
    assert.ok(present / sq.relevantIds.size >= 0.95, `pool recall ${present}/${sq.relevantIds.size}`);
  }
});
