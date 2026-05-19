# PRC-1 Eval Evidence: AI Review Billing Session Usage

Date: 2026-05-19
PR: create-sentinelayer#477
Scope trigger: `src/review/ai-review.js` records billing-grade usage events for the AI review path.

## What changed

- Adds a versioned `billing/v1` price book for current OpenAI and Anthropic token rates.
- Adds deterministic ledger-entry construction with stable ids derived from run/call idempotency keys.
- Adds `recordSessionUsage()` to persist `session_usage` events with token totals, provider cost, price-book version, customer-cost placeholder, and redacted metadata.
- Wires `runAiReviewLayer()` so the AI review / Omar-priced path records a billing ledger event and returns the ledger in the AI review artifact.

## Eval impact assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: no.
- Usage/accounting changes: yes. The PR adds post-call billing telemetry for the existing AI review path.

## Baseline behavior

Before this PR, `runAiReviewLayer()` wrote cost telemetry to the local cost history and run ledger, but it did not emit a session-scoped `session_usage` billing ledger event. Session transcript/export consumers could not derive a billing-grade per-agent usage row from the AI review execution itself.

## Candidate behavior

The candidate keeps the same AI review prompt, dry-run output, provider resolution, and model invocation path. After token usage is known, it appends one `session_usage` event with:

- `schema: "billing/v1"`
- `agentId: "audit-orchestrator"`
- `action: "audit_run"`
- deterministic `ledgerEntryId`
- deterministic `idempotencyKey`
- input/output/total token counts
- provider cost in USD when a model rate is known
- `customerCostUsd: null` for the first internal-metering slice
- metadata with raw prompt/response/message/text fields omitted and secret-like values redacted

If billing telemetry append fails, the AI review result records a non-throwing `sessionUsageLedger.ok=false` object so review execution is not turned into a billing-path availability dependency.

## Validation evidence

Focused checks:

- `node --import ./tests/setup-env.mjs --test tests/unit.billing-session-usage.test.mjs tests/unit.review-ai.test.mjs tests/unit.core.test.mjs`
  - result: 20/20 passed
  - verifies known/unknown model pricing, zero-token cost, stable ledger ids, raw prompt/response omission, secret redaction, duplicate idempotency behavior, priced-event counting, and the real `runAiReviewLayer()` dry-run path writing one `billing/v1` `session_usage` event.

Full branch checks:

- `npm run check`
  - result: 310 files passed
- `npm run test:coverage`
  - result: 1250/1250 passed, 90.32% statement coverage
- `npm run verify`
  - result: check, docs build, 97 e2e tests, 1250 coverage tests, and package dry-run all passed
- `npm pack --dry-run`
  - result: package includes `src/billing/ledger-entry.js`, `src/billing/price-book.js`, and `src/billing/session-usage.js`
- `git diff --check`
  - result: clean

## Risk assessment

Primary risk: billing telemetry could persist raw prompt or response text. Mitigation: ledger metadata recursively drops raw text/message/prompt/response keys and runs through the existing session payload redactor. Tests assert both top-level and metadata prompt/response fields are absent and secret-like metadata is masked.

Secondary risk: duplicate retries could overcount usage. Mitigation for this slice: ledger entry ids are deterministic from idempotency keys, making duplicates identifiable by downstream aggregation/export even though the append-only session stream still records every attempted write. Tests lock duplicate idempotency behavior.

Residual risk: provider prices can change. Mitigation: price book is versioned (`2026-05-19`) and source URLs are documented in the PR body; unknown models are surfaced as unpriced instead of fabricated.
