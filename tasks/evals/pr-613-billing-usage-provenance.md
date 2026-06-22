# PR 613 Eval Evidence: Billing Usage Provenance Through AI Client Proxy

Date: 2026-06-22
PR: create-sentinelayer#613
Scope trigger: `src/ai/client.js` now forwards SentinelLayer proxy metering context through the high-level AI client.

## What Changed

- `MultiProviderApiClient.invoke()` accepts optional SentinelLayer proxy metering context:
  - `apiUrl`
  - `sessionId`
  - `agentId`
  - `action`
  - `usageIdempotencyKey`
  - `billingTier`
  - `customerPricingPolicy`
  - `metadata`
- For `provider: "sentinelayer"`, the high-level client forwards those fields into `invokeViaProxy()`.
- Proxy responses now preserve the returned `usageLedger` on the high-level client result.
- The default priced action rollup includes `proxy_llm`, `investor_dd_devtestbot_planner`, and `investor_dd_file_planner`.
- The Architect Pricing spec now states that proxy calls through `src/ai/client.js` and `src/ai/proxy.js` must forward supplied metering context and preserve returned ledger evidence.

## Eval Impact Assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: no.
- Response parsing changes: additive only. `usageLedger` from the SentinelLayer proxy is retained when present.
- Usage/accounting changes: yes. High-level SentinelLayer proxy calls can now produce billing-grade provenance instead of dropping caller-supplied session metering context.

## Baseline Behavior

Before this PR, lower-level proxy calls could carry session usage context, but the high-level `MultiProviderApiClient.invoke({ provider: "sentinelayer" })` path did not accept or forward that context. Callers using the generic AI client could receive model text while losing:

- session id
- agent id
- action
- usage idempotency key
- billing tier
- redaction-safe metadata
- proxy-returned `usageLedger`

That made the generic client path unsuitable for billing-grade priced action accounting even when the API proxy had enough information to return ledger evidence.

## Candidate Behavior

The candidate keeps direct OpenAI, Anthropic, and Google behavior unchanged. The only behavioral change is in the SentinelLayer proxy provider path:

- When no metering context is supplied, the proxy path remains compatible with existing unmetered calls.
- When metering context is supplied, the same fields are forwarded to `invokeViaProxy()`.
- The same usage idempotency key can be used by the proxy request and downstream ledger reconciliation.
- The high-level result preserves `usageLedger`, allowing callers to prove API-managed token, cost, and billing status without scraping lower-level responses.

## Validation Evidence

Focused checks:

- `node --test tests/unit.billing-session-usage.test.mjs tests/unit.investor-dd-usage.test.mjs tests/unit.ai-client.test.mjs tests/unit.ai-proxy.test.mjs`
  - result: `20/20` passed
  - verifies high-level proxy metering field forwarding, `usageLedger` preservation, proxy compatibility, priced action counting, Investor-DD billing/v1 writes, metadata redaction, and raw prompt/response omission.
- `node --import ./tests/setup-env.mjs --test tests/unit.ai-client.test.mjs tests/unit.ai-proxy.test.mjs tests/unit.billing-session-usage.test.mjs tests/unit.investor-dd-usage.test.mjs tests/unit.review-ai.test.mjs tests/unit.session-usage.test.mjs`
  - result: `37/37` passed
  - verifies the new proxy path alongside existing AI review and session usage regressions.

Full branch checks:

- `npm run check`
  - result: `335` files passed.
- `npm run test:unit`
  - result: `1537/1537` passed.
- `npm pack --dry-run`
  - result: passed.
- `git diff --check`
  - result: clean except expected Windows LF/CRLF warnings.
- `node bin/sl.js review scan --mode diff --spec tasks/architect-pricing-spec.md --json --path .`
  - result: `P1=0`, `P2=1`, blocking=false. The remaining P2 is the non-blocking spec-binding advisory for the touched AI client.
- `node bin/sl.js omargate deep --path . --scope-mode diff --json`
  - result: `P0=0`, `P1=0`, `P2=2`, blocking=false. AI personas were unavailable due to managed daily scan limit 429; deterministic findings were spec-binding only.

## Risk Assessment

Primary risk: proxy usage could be double counted on retries. Mitigation: the high-level client forwards the caller-supplied `usageIdempotencyKey`; tests assert the forwarding contract so API-side idempotency can reconcile repeated attempts.

Secondary risk: billing metadata could leak prompt or response text. Mitigation: this PR does not add prompt/response metadata to proxy calls, and the Investor-DD recorder test proves billing/v1 metadata omits raw prompt and response fields.

Compatibility risk: existing high-level proxy callers could break if metering fields became mandatory. Mitigation: every new metering field is optional, and direct provider behavior remains unchanged.

Residual risk: `usageLedger` is additive on the high-level response. Callers that ignore unknown properties keep working, but billing-aware callers can now use the returned ledger object as provenance.
