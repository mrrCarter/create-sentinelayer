# Eval — ENGRAM §1: Session Recall (`sl session recall`)

AI-impacting change: adds a hybrid retrieval path (dense embedding + BM25 +
RRF + graph diffusion + ACT-R ranking) behind `sl session recall`. This doc
is the deterministic eval evidence required by
`.github/instructions/ai-eval.instructions.md` (baseline vs candidate, input
set, output deltas, regression notes).

## What changed

Hydrating a Senti session used to mean **full-tail replay** — read the whole
event stream back into an agent's context. That cost grows with session
length (the reader-as-writer scale wall). This change hydrates by
**retrieval**: `sl session recall "<need>" --session <id>` returns the top-K
relevant memories, each with a one-line provenance path, instead of the
firehose.

New engine (isolated in `src/session/recall/`, no changes to
`src/memory/*` or the API): `text.js`, `embedder.js`, `observations.js`,
`entities.js`, `index-build.js`, `provenance.js`, `retrieve.js`,
`token-stats.js`, `needle-eval.js`, `index.js` + the command wiring in
`src/commands/session.js`.

## Design fidelity (ENGRAM architecture v3)

- **Tri-layer data model (§3).** Session events = immutable `observation`s
  (content-hash dedup via the server `idempotency_token`; never a destructive
  merge). Agents/files/PRs/decisions/topics = `entity`s. Author / mention /
  reply-target / touches-file / about-topic / governs = `binding` edges. The
  `session_message_actions` layer (view/like/reply/ack) becomes ACT-R
  `occurrence` rows (§3 occurrence, §6 rehearsal loop).
- **Recall Engine (§7).** Query embed + entity match → dense **exact int8
  scan** (no ANN — small-data, Thesis 1) ‖ **BM25 lexical** (parallel) →
  **RRF pool** (rank-based) → **bounded spreading activation** over the entity
  graph → **fusion score = cos + log(1+PPR-mass) + ACT-R B(m)**, where
  `B(m) = ln Σ (t_now − t_j)^(−0.5)`. Pooling (RRF+diffusion) and ordering
  (fusion) are kept separate. Every hit carries a **provenance path** (§7
  path evidence, via bounded bidirectional BFS ≤4 hops/side).
- **8-Needle eval (§11).** Needle-Chain (depth) + Needle-Scatter (breadth) +
  recall@10, all as hard gates.

### Relay rulings recorded (faithful, on the record)

1. **BM25 lexical (FTS5-equivalent).** FTS5 *is* SQLite's BM25 implementation.
   The CLI has no SQLite (NDJSON store, published `engines` still allow Node
   ^20, native-dep + publish fragility, and the eval requires determinism), so
   the same BM25 *mechanism* is implemented in pure JS. Only the storage
   engine differs from the doc's consumer-app context (§8).
2. **Bounded graph diffusion.** A literal single hop cannot complete an
   8-memory chain (the tail is ~7 hops from the head). Expansion is bounded,
   decayed, hub-skipping BFS — the first diffusion hops of §7's forward-push
   PPR, and the same bounded BFS §7 already specifies for path evidence. Full
   ACL push-PPR with α-teleport + edge-type priors + residual ranking remains
   the **P1** upgrade.

## Baseline vs candidate

| | Baseline (status quo) | Candidate (this change) |
|---|---|---|
| Hydration | full-tail replay of all material events | retrieve top-K + provenance |
| Cost | grows with session length | ~flat (top-K), decoupled from length |
| Ranking | chronological | dense+BM25+RRF+graph+ACT-R |
| Explainability | none | provenance path per hit |

### Token cut — measured on a REAL session

Session `6cf7e861` (Senti Pocket build room), **889 real events**, tokens via
the Anthropic tokenizer (`@anthropic-ai/tokenizer`):

| Query | Full replay (tokens) | Recall pack (tokens) | Reduction |
|---|---|---|---|
| "what did we decide about the pocket write contract" (k=12) | 346,129 | 1,153 | **300×** (99.7%) |
| "authfetch contract stale generation terminal" (k=12) | 346,129 | 1,111 | 312× |
| "who is working on the relay lane" (k=12) | 346,129 | 1,102 | 314× |
| same, k=6 (CLI dogfood) | 346,129 | 535 | 647× |

The 346K-token full replay alone exceeds most model context windows — this is
the scale wall the change removes. Retrieved memories were on-topic
(WARDEN reconciliation, write-contract freeze, HOLD acceptances) with correct
`dense+bm25` provenance.

### 8-Needle gates (input set = seeded synthetic corpora, deterministic)

Full ENGRAM §11 scale (500 chains of 8 + 200 scatter queries; 5,984 + 4,000
synthetic events), deterministic hash-projection stub embedder:

| Gate | Threshold | Result |
|---|---|---|
| Needle-Chain (tail-in-top-20) | ≥ 95% | **100.0%** (500/500) |
| Needle-Scatter (relevants in pre-rerank pool) | ≥ 95% | **100.0%** |
| recall@10 vs exact ground truth | ≥ 95% | **100.0%** |

CI unit test (`tests/unit.engram-8needle.test.mjs`) runs a 150-chain / 60-query
subset (~1s) and asserts the same gates; robust across seeds 1–5.

**Teeth check (regression guard on the benchmark itself):** with graph
diffusion disabled (`expansionHops: 0`), Needle-Chain collapses to **0.7%**.
The tail is lexically disjoint from the head (opaque per-chain tokens), so a
≥95% pass is earned by genuine spreading activation, not lexical leakage.

## Acceptance criteria

- [x] Needle-Chain ≥ 95% (100%)
- [x] Needle-Scatter ≥ 95% (100%)
- [x] recall@10 ≥ 0.95 (1.00)
- [x] Deterministic (identical results across runs/seeds; CI-asserted)
- [x] Token cut demonstrated on a real large session (≈300× at k=12)
- [x] Every hit carries a provenance path

## Regression notes / limitations (flagged, not improvised)

- The default embedder is a **deterministic hash-projection stub** (256-d,
  int8, char-trigram features) so CI needs no model download. A real
  EmbeddingGemma-class embedder plugs in behind the same interface
  (`provider: "api"`) with stub fallback. The stub is lexical-leaning; deep
  semantic paraphrase quality improves with the real embedder (chain
  completion here is carried by the graph, by design).
- **P1 upgrades (not regressions):** forward-push PPR (α-teleport + edge-type
  priors) replacing bounded BFS; learned fusion weights trained on the
  rehearsal loop; LLM topic/relation extraction (ENGRAM Pass-3) beyond the
  current conservative explicit-tag topics.
- Recall over a session requires a complete local mirror; `runSessionRecall`
  forces a `tail:0` hydrate and surfaces `eventsBackfillComplete=false` as a
  warning so a truncated mirror is never silently indexed.

## Reproduce

```
# 8-Needle harness (full ENGRAM scale)
node -e "import('./src/session/recall/needle-eval.js').then(m=>console.log(JSON.stringify(m.runEightNeedle({chains:500,scatterQueries:200}),null,2)))"

# CLI dogfood on a local session
node bin/sl.js session recall "<need>" --session <id> --path <workspace> --no-remote --k 12

# Unit gates
node --import ./tests/setup-env.mjs --test tests/unit.engram-8needle.test.mjs tests/unit.engram-recall.test.mjs
```
