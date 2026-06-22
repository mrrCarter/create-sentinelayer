# Eval Evidence: Review AI Usage Ledger Guardrail

Date: 2026-06-22

## Scope

This PR changes `sl review --ai` so operators can opt into a billing-grade usage-ledger guardrail with `--require-usage-ledger`.

Touched AI-impacting files:

- `src/commands/review.js`
- `src/review/ai-review.js`

## Baseline

Before this change, `runAiReviewLayer` attempted to record a `billing/v1` `session_usage` event and exposed failures as `billing.ok=false`, but `sl review --ai` continued even when the usage ledger write failed. That was acceptable for local best-effort telemetry, but not for subscription/trial enforcement or sellable usage metering.

Investor-DD already had a stricter `--require-usage-ledger` control. Plain `review --ai` did not.

## Candidate

The candidate keeps default `review --ai` behavior best-effort, adds `review --ai --require-usage-ledger`, and fails closed only when the new flag is set and billing-grade usage emission fails.

The AI review prompt, parser, model selection, deterministic finding input, cost budget calculation, and finding reconciliation are unchanged.

## Risk Assessment

- Prompt-output behavior risk: low. The prompt and parser are unchanged.
- Billing/entitlement risk: reduced. Callers can now require usage-ledger proof before treating AI-backed review as successful.
- Backward compatibility risk: low. Existing `review --ai` runs remain best-effort unless the new flag is present.
- Testability: improved. `runAiReviewLayer` accepts an injected usage recorder for deterministic offline failure tests.

## Verification Plan

- Command contract test proves `review` exposes `--require-usage-ledger`.
- Unit tests prove usage-ledger writer failures remain best-effort by default and fail closed when required.
- E2E dry-run test proves the real CLI succeeds with `review --ai --ai-dry-run --require-usage-ledger --json` when local billing event recording succeeds.
- Local quality gates and Omar/review scans must pass before PR merge.
