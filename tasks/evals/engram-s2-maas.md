# Eval — ENGRAM §2: Memory-as-a-Service via MCP (`memory.write/recall/summarize`)

AI-impacting change: exposes the §1 recall engine as 3 MCP tools over scoped
namespaces (hybrid dense + BM25 + RRF + bounded diffusion + ACT-R retrieval,
plus a retrieve-then-generate summarize). Deterministic eval evidence per
`.github/instructions/ai-eval.instructions.md` (baseline vs candidate, input
set, output deltas, regression notes).

## What changed

Turns the §1 engine into **Memory-as-a-Service**: point any agent at the MCP
and it can `write` what it needs remembered and `recall`/`summarize` on demand
over a scoped namespace — no chunking/embeddings/indexes/eviction exposed.

- New **detachable** core `src/engram/` (imports ONLY the §1 engine core +
  node builtins — HARD-asserted): `namespace.js`, `trust.js`, `governance.js`,
  `store.js`, `tools.js`, `sla.js`, `index.js`.
- §1 generalized IN PLACE: `buildObservationsFromItems` beside
  `buildObservations`; `buildRecallIndex` accepts pre-built `observations`;
  eval functions exported for the SLA. Core `recall()` UNTOUCHED.
- 3 tools wired into `src/mcp/session-stdio-server.js` with the SL session as
  namespace #1 (an injected adapter) + generic namespaces (project/org/ns) to
  prove detachability. Declared with `security.scopes` (`memory:read/write`)
  and `durable_receipt_required` on recall/summarize.

## Design fidelity (stack-doc §2 + engine §1/§3/§9)

- **3 tools EXACTLY** (stack-doc §2): `memory.write({scope, items})` idempotent
  (content-hash dedup, §3), `memory.recall({scope, query, k})` -> ranked
  memories + provenance path (REUSES §1 `retrieve.js` verbatim),
  `memory.summarize({scope, focus})` retrieve-then-generate.
- **Namespace = tenancy boundary; session = namespace #1.** The engine has
  ZERO session coupling (detachable); session-ness lives in one injected store
  adapter (§1 "rides the coordination layer for free").
- **Deterministic + provenance = the wedge** — reproducible, auditable, a
  provenance path on every hit.

### Relay rulings recorded (on the record)

1. **§2.1 hosted is a later increment.** The hosted MCP-OAuth chain
   (PRM/AS/JWKS/RFC8707/8693/PKCE) does NOT exist server-side yet; P0 is
   CLI-local (embedded proof + detachability). Not attempted here.
2. **Receipt + meter are clean-interface STUBS in P0.** AIdenID signing is
   external (api.aidenid.com; this repo is a client) and the server usage
   ledger is session-welded (`SessionUsageLedgerEntry` requires
   `session_id`+`session_sequence_id`). So P0 emits an UNSIGNED receipt
   (`sig:null`, `stub:true`, seam `aidenid-external-signer`) and a stub meter
   (`stub:true`, seam `namespace-usage-ledger`). **FLAG:** real backing =
   §2.1 (external AIdenID sign + a namespace-generalized ledger keyed on
   `billing_account_id`). The seams always fire (never skipped).
3. **Trust vocabulary aligns with the server `ServiceTrustLevel` (L0–L5)** so
   §2.1 converges onto that existing certification subsystem
   (`MemoryCertification`), not a divergent trust model. P0 does NOT touch the
   server subsystem — it only borrows the vocabulary.
4. **Stacked on #790.** Reuses `src/session/recall/`, which lives only on the
   §1 branch; rebase to main when #790 lands.
5. **One shared store.** The 3 tools + the 8-Needle SLA + token-cut all read
   `store.js`. Detachability is by import-graph, not directory name
   (§1 core stays at `src/session/recall/`), enforced by a HARD unit test.

## Baseline vs candidate

| | Baseline | Candidate (this change) |
|---|---|---|
| Agent memory API | none (bespoke per-agent) | 3 MCP tools over scoped namespaces |
| Retrieval | n/a | §1 hybrid engine, provenance per hit |
| Multi-tenant | session-only | namespace = tenancy boundary (session/project/org/ns) |
| Governance | none | fail-closed consent (403), recall receipt, per-call meter |
| Trust | none | L0–L5 seal; only verified is authoritative; sealed/revoked gated |

### 8-Needle SLA (namespace-agnostic, over the shared store)

Corpora are written as `memory.write` items into a namespace and recalled
through the same store the tools use (input set = seeded synthetic corpora):

| Gate | Threshold | Result (CI, 120 chains / 50 scatter) |
|---|---|---|
| Needle-Chain (tail-in-top-20) | ≥ 95% | **100%** |
| Needle-Scatter (relevants in pre-rerank pool) | ≥ 95% | **100%** |
| recall@10 vs exact ground truth | ≥ 95% | **100%** |

The engine is identical to §1 (verified at the full §11 500-chain scale at
100%); the SLA proves the bar holds over an arbitrary NAMESPACE via the store.

### Governance & trust semantics (output deltas)

- `memory.write` from a **verified** caller -> `L2_memory_certified`
  (authoritative). From **unverified** -> `L1_audited` (retrievable, NOT
  authoritative). From **guest/no-identity** -> denied (403) by default
  consent, or `L0_connected` if consent allows.
- `memory.recall` marks every hit `authoritative` (trust ≥ L2). **Sealed**
  memory surfaces only to an authorized scope; **revoked** never surfaces.
- Every call emits a stub meter; recall/summarize emit a stub receipt.

## Acceptance criteria

- [x] 3 tools exactly; write idempotent (content-hash dedup); provenance on recall
- [x] Reuses §1 engine (no retrieval reimplementation)
- [x] Namespace = tenancy boundary; session = namespace #1; engine detachable (HARD test: `src/engram/*` imports no session runtime)
- [x] Consent fail-closed (403) + recall receipt (§9 shape, stub) + per-call meter (stub) — seams flagged
- [x] Trust seal (L0–L5); sealed/revoked never surfaced to unauthorized scope; unverified never authoritative
- [x] 8-Needle SLA namespace-agnostic, all gates ≥ 95%
- [x] One shared store; deterministic

## Regression notes / limitations (flagged, not improvised)

- **Receipt + meter are stubs in P0** (see ruling #2). No cryptographic
  signature and no durable ledger write yet — the seams are present and always
  fire; §2.1 supplies the real backing.
- **Trust verification is heuristic in P0** — `verified` comes from the local
  caller flag; real provider-signature / delegation-proof verification is
  AIdenID (§2.1). P0 default MCP callers are `verified:false` (non-authoritative)
  until AIdenID lands.
- **Session-namespace occurrences** are capture-only in the §2 path (the
  message-actions ACT-R fuel is not threaded through the generic store); B(m)
  still computes over captures. Minor; §2.1 can enrich.

### P1 / §2.1 upgrades

- Hosted MCP-OAuth chain (PRM/AS/JWKS/RFC8707/8693/PKCE) + scoped token mint.
- Real AIdenID-signed recall receipts; namespace/tenant-generalized usage
  ledger (billing_account_id) replacing the stubs.
- Converge trust onto the server `ServiceTrustLevel`/`MemoryCertification` (L0–L5).
- Cross-session **org namespace** (stack-doc §4); Pocket brief-pipeline as a
  client of `memory.summarize` (stack-doc §3).

## Reproduce

```
# §2 SLA (namespace-agnostic 8-Needle over the store)
node -e "import('./src/engram/sla.js').then(m=>m.runEngramSla({chains:120,scatterQueries:50}).then(r=>console.log(JSON.stringify(r,null,2))))"

# Unit tests (incl. HARD detachability + fail-closed 403 + trust seal + SLA)
node --import ./tests/setup-env.mjs --test tests/unit.engram-maas.test.mjs tests/unit.engram-maas-sla.test.mjs

# MCP tools present
node bin/sl.js mcp server run --help   # served via tools/list: memory.write/recall/summarize
```
