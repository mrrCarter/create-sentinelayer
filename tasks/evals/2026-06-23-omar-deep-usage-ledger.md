# Omar Deep Usage Ledger Eval - 2026-06-23

## Scope

This change touches AI/Omar execution surfaces:

- `src/review/ai-review.js`
- `src/review/omargate-orchestrator.js`
- `src/commands/omargate.js`
- `src/legacy-cli.js`

The intended behavior change is billing telemetry classification and optional fail-closed enforcement. Prompt text, persona roster selection, model routing defaults, deterministic finding reconciliation, and severity scoring are not changed.

## Baseline

- `review --ai` records `session_usage` with `action=audit_run` and `agentId=audit-orchestrator`.
- `review --ai --require-usage-ledger` fails closed if the billing-grade usage ledger cannot be written.
- `omargate deep` delegates its AI layer through the review AI runner but did not expose a command-level required-ledger flag or classify Omar Deep AI calls as the priced `omargate_deep` action.

## Candidate Invariants

- `review --ai` default ledger behavior remains `audit_run`.
- `omargate deep` AI/persona calls record `action=omargate_deep`.
- `omargate deep --notify-session <id>` writes all Omar Deep AI billing entries to the shared session id.
- `omargate deep --require-usage-ledger` fails closed when a required usage write fails.
- Best-effort behavior remains unchanged when `--require-usage-ledger` is absent.
- Caller-provided billing metadata is sanitized and cannot override canonical ledger fields such as `sourceCommand` or `layer`.

## Local Eval Commands

```powershell
node --import ./tests/setup-env.mjs --test tests/unit.review-ai.test.mjs tests/unit.omargate-orchestrator.test.mjs tests/unit.legacy-args-persona-flags.test.mjs tests/unit.commands-contracts.test.mjs
```

Expected result: all focused tests pass, including the new custom metadata, shared-session Omar Deep billing, fail-closed Omar Deep ledger, Commander flag, and legacy argv pass-through cases.

## Risk Review

- Billing metadata flows through `sanitizeBillingMetadata` before it reaches `buildLedgerEntry`.
- Canonical ledger metadata is assigned after caller-provided metadata so internal contract fields cannot be spoofed.
- The new required-ledger path is opt-in. Existing default best-effort behavior remains compatible with offline or locally-only AI dry runs.
