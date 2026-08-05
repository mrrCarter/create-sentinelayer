import test from "node:test";
import assert from "node:assert/strict";

import { runEngramSla } from "../src/engram/sla.js";

// The 8-Needle SLA runs OVER A NAMESPACE through the shared store (not raw
// events), proving the quality bar is namespace-agnostic — the detachability
// guarantee. CI size kept modest (~1-2s); the §1 branch verifies the full
// 500-chain scale at 100%.
const CONFIG = { chains: 120, chainLen: 8, scatterQueries: 50, relevants: 8, seed: 1 };

test("Unit engram MaaS SLA: 8-Needle gates pass over the namespace store", async () => {
  const r = await runEngramSla(CONFIG);
  assert.ok(r.needleChain.rate >= 0.95, `Needle-Chain ${r.needleChain.rate} < 0.95`);
  assert.ok(r.needleScatter.rate >= 0.95, `Needle-Scatter ${r.needleScatter.rate} < 0.95`);
  assert.ok(r.recallAt10.rate >= 0.95, `recall@10 ${r.recallAt10.rate} < 0.95`);
  assert.equal(r.pass, true);
  assert.equal(r.config.path, "namespace-store");
});

test("Unit engram MaaS SLA: deterministic across runs", async () => {
  const a = await runEngramSla(CONFIG);
  const b = await runEngramSla(CONFIG);
  assert.equal(a.needleChain.rate, b.needleChain.rate);
  assert.equal(a.recallAt10.rate, b.recallAt10.rate);
});
