# PR 481 Eval Evidence: Senti Proxy Session Metering

Date: 2026-05-19
PR: create-sentinelayer#481
Scope trigger: `src/ai/proxy.js` now accepts session usage context for Senti daemon LLM calls.

## What changed

- Extends the CLI proxy client to forward optional session usage fields to `/api/v1/proxy/llm`.
- Uses one canonical usage idempotency key in both `Idempotency-Key` and `usage_idempotency_key`.
- Wires Senti help responses to call the proxy with `sessionId`, `agentId: "senti"`, `action: "proxy_llm"`, `billingTier: "internal"`, and redaction-safe metadata.
- Preserves legacy proxy calls by omitting every session usage field when no context is provided.

## Eval impact assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: no.
- Usage/accounting changes: yes. Senti daemon proxy usage is now eligible for API-managed session metering through API PR #517.

## Baseline behavior

Before this PR, Senti help-response LLM calls used the proxy compatibility path without session context. The API could return model text and token usage, but it could not attach those calls to a session billing ledger row or enforce the API-managed LLM policy for session-scoped Senti work.

## Candidate behavior

The candidate keeps the same Senti prompt, fallback behavior, help-response flow, and local `model_span` telemetry. When the daemon has enough context for a help request, it sends the proxy:

- `session_id`
- `agent_id`
- `action`
- `usage_idempotency_key`
- `billing_tier`
- `metadata`

The proxy client returns `usageLedger` from either camelCase or snake_case API responses. When callers do not pass session context, the client sends the historical body shape and does not add an idempotency header.

## Validation evidence

Focused checks:

- `node --import ./tests/setup-env.mjs --test tests/unit.ai-proxy.test.mjs tests/unit.session-daemon-context.test.mjs`
  - result: 4/4 passed
  - verifies body/header idempotency alignment, usage ledger parsing, no-context compatibility, and Senti help-response context construction.

Full branch checks:

- `npm run check`
  - result: 310 files passed
- `npm run test:unit`
  - result: 1254/1254 passed
- `npm run verify`
  - result: check, docs build, 97 e2e tests, 1254 coverage tests, and package dry-run all passed
- `git diff --check`
  - result: clean except existing CRLF normalization warnings in changed files
- `node bin/sl.js review --path . --json`
  - result: P0=0, P1=0, blocking=false
- `node bin/sl.js omargate deep --ai-dry-run`
  - result: P0=0, P1=0

## Risk assessment

Primary risk: duplicate retries could double count proxy usage. Mitigation: the daemon derives a deterministic usage idempotency key from the session id and help request correlation id, and the proxy sends the same key in the request header and body for API reconciliation.

Secondary risk: session metadata could leak prompt or response text. Mitigation: this slice only sends `purpose` and `runId`, matching the API #517 metadata allowlist. Raw prompt, response, message, and transcript text are not sent in metering metadata.

Compatibility risk: existing CLI proxy consumers might break if the new fields become mandatory. Mitigation: session context remains optional, and a unit test asserts the old request shape omits session usage fields and the idempotency header.

Residual risk: the API must be deployed with PR #517 for billing-grade session metering. Production health confirmed API build `c3d6e44e563e1d754b326a7bd3b79923703b8fdc`, which includes the corresponding server-side enforcement and ledger relay.
