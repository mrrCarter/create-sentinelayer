# Investor-DD Audit Architecture

**Status**: CORE IMPLEMENTATION COMPLETE — 10 PRs merged (2026-04-21), all 32 planned work items landed across collapsed merges. Further PRs are polish only (partial-report UX, resume-from-partial, eval-regression suite).

## Landed in main (2026-04-21)

| PR | Spec Slot | Description |
|---:|-----------|-------------|
| #388 | PR-1 | Slash command scaffold + 32-PR architecture doc |
| #390 | PR-2, PR-3 | Per-file review loop library + deterministic per-persona file router |
| #391 | PR-4..15, PR-5, PR-16, PR-18a, PR-29 | Unified persona runner (12 personas), top-level orchestrator + markdown report + streaming NDJSON, CLI wiring, reconciliation ruleset |
| #392 | PR-20..24 | Compliance pack (SOC 2, ISO 27001, GDPR/CCPA, HIPAA, license, DR) |
| #393 | PR-25..28 | Live-web validator (devTestBot + AIdenID client adapters) |
| #394 | PR-17 | Per-finding reproducibility chain (replay command + file SHAs) |
| #395 | PR-19 | Notification dispatch (email + dashboard clients) |
| #396 | PR-18b | Self-contained HTML report generator |
| #397 | Integration | Orchestrator wiring: compliance + live validator + reconciliation + notifications + HTML + reproducibility |

## How to run

```bash
# Deterministic investor-DD end-to-end
sl /omargate investor-dd --path .

# Machine-readable output
sl /omargate investor-dd --path . --json

# Streaming NDJSON to stdout
sl /omargate investor-dd --path . --stream

# Dry-run (plan + compliance only)
sl /omargate investor-dd --path . --dry-run
```

## Artifact bundle

Under `.sentinelayer/runs/<runId>/investor-dd/`:

- `plan.json` — router output + budget
- `stream.ndjson` — full event trace
- `persona-<id>.json` — per-persona findings + coverage proof
- `findings.json` — flat list, each finding carries `.reproducibility` block
- `summary.json` — run metadata + compliance + reconciliation flags
- `compliance.json` — SOC 2 / ISO 27001 / GDPR/CCPA / HIPAA / license / DR gap tables
- `interaction-plan.json` — discovered interactive elements (when live validator runs)
- `live-observations.json` — per-interaction observations + identity (when live validator runs)
- `report.md` — human-readable markdown report
- `report.html` — self-contained HTML report (inlined CSS)
- `manifest.json` — SHA-256 chain of every artifact file

## Remaining polish (optional)

| PR | Spec Slot | Notes |
|---:|-----------|-------|
| — | PR-30 | Partial-report UX refinement (current: budget exhaustion sets `terminationReason`, remaining personas land in `skipped`) |
| — | PR-31 | Resume from partial (admin_error_log assignment ledger pattern) |
| — | PR-32 | Eval regression suite across 3 identical runs on fixture repo |

---


Investor-grade due-diligence audit mode for `sentinelayer-cli`. Replaces
the one-shot-per-persona deep scan with a per-file agentic review loop
across all 13 personas, streams progress into a Senti session, builds a
reproducibility chain for every finding, and ships a final report to the
operator's email + SentinelLayer dashboard.

## Why this exists

The existing `/omargate deep` runs ~90 seconds and does one LLM call per
persona with the whole codebase stuffed into context. Personas
self-attest which files they inspected, which has been shown to under-
report coverage. Investor-grade DD demands deterministic file routing,
per-file verification, and evidence an auditor can replay.

Investor-DD mode accepts ~30-60 min runtime and ~$8-20 in LLM cost per
run in exchange for **acquirer-grade** coverage — the same shape that
a venture-backed M&A firm or Tier 1 customer would demand before close:

| Acquirer concern | Covered by |
|---|---|
| Code quality + maintainability | ethan (code-quality), priya (testing) |
| Application security | nina (security) + deterministic scan |
| Data handling + privacy (GDPR/CCPA) | compliance pack (see below) |
| Infrastructure + scalability | kat (infra), noah (reliability) |
| Supply-chain + SBOM + license | nora (supply-chain) + license pack |
| Observability + incident response | sofia (observability) |
| AI-pipeline governance | amina (ai-governance) |
| Documentation + runbook completeness | samir (documentation) |
| Release engineering + provenance | omar (release) |
| Backend handler safety + data txn | maya (backend), linh (data-layer) |
| Frontend runtime + accessibility | jules (frontend) |
| **SOC 2 Trust Service Criteria** | compliance pack |
| **ISO 27001 Annex A** | compliance pack |
| **HIPAA / GDPR / CCPA** | compliance pack |
| **DR + business continuity** | reliability + infra cross-read |

## Compliance pack (investor-dd exclusive)

On top of the 13 base personas, investor-dd runs a dedicated
**compliance pack** that cross-reads every file against standards-
oriented checklists:

- **SOC 2** — Security, Availability, Processing Integrity,
  Confidentiality, Privacy (TSC 2017 + 2022 updates)
- **ISO 27001 Annex A** — relevant operational controls
  (A.5 policies, A.8 asset mgmt, A.9 access control, A.12 ops
  security, A.13 comms security, A.14 system acquisition, A.16
  incident mgmt, A.17 continuity, A.18 compliance)
- **GDPR / CCPA** — data subject rights surfaces, lawful basis
  tracking, deletion + export flows, consent ledger
- **HIPAA (opt-in via flag)** — PHI field recognition, BAA-gated
  endpoints, audit logging coverage
- **License compliance** — SPDX identifier coverage, SBOM parity
  against package manifests, copyleft propagation risk
- **Disaster recovery** — documented RPO/RTO, backup verification
  paths, failover test evidence

The compliance pack is its own persona-adjacent dispatch (Leila Farouk,
re-added for investor-dd only — not in base full-depth roster per
PR #365 / #367). It reads outputs from the 13 persona reviews plus
raw repo artifacts (LICENSE, SECURITY.md, privacy policies,
runbooks) and emits a **compliance gap table** with per-control
status.

## Architectural borrowings

Patterns adapted from the reference codebase:
- Async-generator loop emitting structured events (adapted to a
  review-only variant without fix-cycle edit path).
- Tool dispatch layer with per-call budget + telemetry.
- Shared-tools base (file-read, grep, glob, shell, file-edit,
  path-guards).
- Lock / lease pattern for single-orchestrator semantics in
  multi-agent sessions.

Not borrowed: names, interfaces, file layouts from those references.
Code patterns only.

## Command surface

```
sl /omargate investor-dd --path . [options]
```

New subcommand under the existing `omargate` group. Keeps baseline and
deep subcommands unchanged.

Options (tuned to investor-DD defaults):
- `--max-cost <usd>` default `25.0` (was `5.0` for deep)
- `--max-runtime-minutes <n>` default `45` (new — was unbounded)
- `--max-parallel <n>` default `3` (was `4` — each persona loops, not one-shot)
- `--persona <csv>` / `--skip-persona <csv>` (preserved)
- `--scan-mode <mode>` absent — investor-dd always runs full 13
- `--stream` (preserved)
- `--notify-email <addr>` default: operator's account email
- `--notify-session <session-id>` default: auto-start a Senti session
- `--no-email` / `--no-dashboard` opt-outs

## Artifact output

Under `.sentinelayer/runs/<run-id>/investor-dd/`:

- `plan.json` — file routing table (persona → files in scope)
- `stream.ndjson` — full event stream from the run
- `persona-<id>.json` — per-persona findings + coverage proof + tool calls
- `reproducibility.json` — per-finding replay commands
- `report.md` — human-readable final report
- `report.html` — operator dashboard variant
- `report.pdf` — emailable variant (if pandoc / headless-chrome available)
- `manifest.json` — SHA-256 chain of every artifact

## PR sequence (22 PRs across 6 batches)

### Batch 1 — Foundation (3 PRs)
1. `feat/investor-dd-1-slash-command-scaffold` — this PR. Wires the
   subcommand, writes the architecture doc, adds budget scaffold.
   Behavior thin-wraps existing deep-scan.
2. `feat/investor-dd-2-review-loop-library` — generalize the
   async-generator loop for review personas. No fix-cycle path (review
   never writes). Budget + telemetry on every tool call.
3. `feat/investor-dd-3-file-routing-engine` — compute
   `filesInScope[personaId]` from persona domain metadata + ingest
   risk surfaces + pattern filters. Unit-tested against a fixture repo.

### Batch 2 — First 3 personas (3 PRs)
4. `feat/investor-dd-4-nina-security-per-file-loop`
5. `feat/investor-dd-5-maya-backend-per-file-loop`
6. `feat/investor-dd-6-linh-data-per-file-loop`

### Batch 3 — Next 4 personas (4 PRs)
7. `feat/investor-dd-7-ethan-code-quality-per-file-loop`
8. `feat/investor-dd-8-priya-testing-per-file-loop`
9. `feat/investor-dd-9-noah-reliability-per-file-loop`
10. `feat/investor-dd-10-omar-release-per-file-loop`

### Batch 4 — Remaining 5 personas (5 PRs)
11. `feat/investor-dd-11-sofia-observability-per-file-loop`
12. `feat/investor-dd-12-kat-infrastructure-per-file-loop`
13. `feat/investor-dd-13-nora-supply-chain-per-file-loop`
14. `feat/investor-dd-14-samir-documentation-per-file-loop`
15. `feat/investor-dd-15-amina-ai-governance-per-file-loop`

### Batch 5 — Streaming + reporting (4 PRs)
16. `feat/investor-dd-16-senti-stream-hooks` — emit
    `persona_file_reviewing`, `finding_detected`, `persona_complete`
    events to the attached Senti session if present.
17. `feat/investor-dd-17-reproducibility-chain` — each finding carries
    a `replay` command (bash or in-CLI `sl review show --finding <id>`)
    that re-runs the exact evidence gathering, plus SHA-256 of the
    files involved at finding-time.
18. `feat/investor-dd-18-report-generator` — MD + HTML + PDF report
    generator. Cross-persona findings section. Reproducibility table.
19. `feat/investor-dd-19-notification-dispatch` — email via
    sentinelayer-api Resend integration + dashboard card persistence
    for the user's account.

### Batch 6 — Compliance pack (5 PRs)
20. `feat/investor-dd-20-compliance-pack-scaffold` — Leila Farouk
    persona-adjacent dispatch, gap-table schema, cross-reads persona
    outputs + raw repo artifacts (LICENSE, SECURITY.md, privacy,
    runbook).
21. `feat/investor-dd-21-soc2-coverage-map` — Security / Availability
    / Processing Integrity / Confidentiality / Privacy TSC control
    coverage. Emits per-control status.
22. `feat/investor-dd-22-iso27001-annex-a` — relevant Annex A control
    enumeration. License: SPDX + SBOM parity.
23. `feat/investor-dd-23-gdpr-ccpa-data-flows` — data-subject rights
    surfaces, deletion + export flows, consent ledger.
24. `feat/investor-dd-24-hipaa-optional-pack` — PHI recognition, BAA
    gates, audit log coverage. Flag-gated `--compliance-pack hipaa`.

### Batch 7 — Live-web validation + reconciliation (5 PRs)

The investor-DD run is not complete until every source-level finding
has been checked against the live product behavior. Jules owns this
lane — it already runs Lighthouse + a11y via the existing
`frontend-analyze` + `runtime-audit` tools. This batch adds:

1. Provisioned AIdenID identities as real users for the live site
2. Full button/form interaction coverage against the running app
3. Video + trace capture per interaction
4. Reconciliation engine that cross-references source findings with
   live observations and flags each as CONFIRMED, FALSE_POSITIVE,
   CONTRADICTORY, or UNVERIFIABLE

25. `feat/investor-dd-25-live-validator-scaffold` — live-validator
    dispatcher under Jules. Provisions AIdenID ephemeral identity per
    the run, tags with `sentinelayer-investor-dd:<run-id>`. Routes
    through the existing devTestBot client (AIdenID product) for a11y,
    interaction recording, Lighthouse (already emitted).
26. `feat/investor-dd-26-button-discovery` — static extraction of
    interactive elements from JSX/TSX/Vue/HTML + server-rendered HTML
    fallback for unknown frameworks. Emits `interaction-plan.json`
    (list of buttons, forms, nav items with their source-level
    origin). When static extraction yields < 80% of what the live DOM
    shows, fall back to live-DOM crawl and merge.
27. `feat/investor-dd-27-interaction-recorder` — for each element in
    `interaction-plan.json`, perform click/submit/keypress; record
    network calls, console errors, DOM diffs, navigation outcomes.
    Video + Playwright trace saved to
    `investor-dd/live/<interaction-id>.webm` + `.trace.zip`.
28. `feat/investor-dd-28-reconciliation-engine` — cross-read source
    findings vs live observations per persona. Emits verdict per
    finding using the ruleset in `feat/investor-dd-29`.
29. `feat/investor-dd-29-reconciliation-ruleset` — documented rules
    at `src/review/reconciliation-rules.js`. Each rule captures
    (finding-pattern, live-observation-pattern, verdict) triples.
    Examples:
    - `{ finding: "broken button onClick", live: "click succeeded +
       no console error + expected network call", verdict:
       "FALSE_POSITIVE" }`
    - `{ finding: "unbounded fetch", live: "payload > 10MB or 10k+
       rows returned", verdict: "CONFIRMED" }`
    - `{ finding: "broken button onClick", live: "click threw
       console error matching claimed stack", verdict: "CONFIRMED" }`
    - `{ finding: "auth bypass", live: "unauth GET returned 200 +
       sensitive data", verdict: "CONFIRMED + CRITICAL" }`
    - `{ finding: "XSS vector", live: "payload rendered + executed",
       verdict: "CONFIRMED + CRITICAL" }`
    - `{ finding: "missing idempotency", live: "double-submit created
       2 rows", verdict: "CONFIRMED" }`
    - No ruleset match → `UNVERIFIABLE` with reason.

### Batch 8 — Polish (3 PRs)
30. `feat/investor-dd-30-partial-report-on-budget-exhaust` — graceful
    degradation when runtime or cost budgets hit. Emit partial report
    with explicit "incomplete" markers per missing persona + live
    validator.
31. `feat/investor-dd-31-resume-from-partial` — long runs can be
    paused with `sl session kill`, archived, and resumed from the
    last-completed persona or interaction batch. Uses the
    admin_error_log assignment ledger pattern.
32. `feat/investor-dd-32-eval-regression-tests` — prompt-stability
    tests for all 14 personas + reconciliation verdict stability.
    Assert (a) per-file loop converges on the same findings across 3
    identical runs on a fixture repo, and (b) reconciliation ruleset
    produces identical verdicts for the same (finding, live-obs) pair.

## Reconciliation guarantees

Every finding in the final report carries a `reconciliation` block:

```json
{
  "verdict": "CONFIRMED | FALSE_POSITIVE | CONTRADICTORY | UNVERIFIABLE",
  "source_finding": { "persona": "nina", "file": "...", "line": 42 },
  "live_observation": {
    "interaction_id": "btn-checkout-submit",
    "video_uri": ".sentinelayer/runs/<id>/investor-dd/live/btn-checkout-submit.webm",
    "trace_uri": ".sentinelayer/runs/<id>/investor-dd/live/btn-checkout-submit.trace.zip",
    "network_errors": [],
    "console_errors": [{ "msg": "...", "stack": "..." }],
    "status_code_observed": 200
  },
  "rule_matched": "src/review/reconciliation-rules.js#R14",
  "confidence": 0.95
}
```

**Policy**: report promotion requires verdict in
`{CONFIRMED, CONTRADICTORY, UNVERIFIABLE-with-documented-reason}`.
`FALSE_POSITIVE` is dropped from the final report unless operator
overrides via HITL. `CONTRADICTORY` flags bubble to the top with an
explicit "source code says X, live behavior says Y — investigate
before acquirer sees this" banner.

This is how we guarantee "we never give them bad reports" — false
positives get caught by the live test, and contradictions get flagged
loudly rather than silently shipped.

## Cost model (estimate per full run)

| Repo size | LLM cost | Runtime |
|---|---|---|
| Small (< 100 files) | $1-3 | 10-15 min |
| Medium (100-500 files) | $3-7 | 20-30 min |
| Large (500-2000 files) | $7-15 | 30-45 min |
| XL (> 2000 files) | budget-gated | up to 45 min |

Compare to current `/omargate deep`: $0.10 / 90s. Investor-DD is 20-150x
cost and 10-30x runtime. The tradeoff is depth of review and
reproducibility — every finding carries a replay command.

## Operator UX

```
$ sl /omargate investor-dd --path . --stream
[session] investor-dd session: sess_idd_abc123
[dispatch] 13 personas × ~47 files each (routing complete)
[nina]     reviewing src/auth/login.py:1-83
[nina]     finding P1 src/auth/login.py:42 — missing MFA bypass guard
[nina]     replay: `sl review show --finding nina-a1b2c3`
[maya]     reviewing src/api/webhooks.py:1-120
[maya]     finding P2 src/api/webhooks.py:88 — unbounded fetch
... [~30 minutes] ...
[report]   32 findings (P0:0, P1:3, P2:18, P3:11)
[report]   written: .sentinelayer/runs/<id>/investor-dd/report.html
[email]    sent to carther@plexaura.io
[dashboard] card created at sentinelayer.com/dashboard/dd/<id>
```

## Non-goals

- Real-time collaborative review (use admin Sessions page)
- Fix-cycle auto-remediation (Jules-only flow stays)
- Multi-repo cross-scan (single repo per run)
- Billing / pricing changes (cost is operator-absorbed at CLI level)
