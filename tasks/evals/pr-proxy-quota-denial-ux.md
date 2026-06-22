# Eval Evidence: Proxy Quota Denial UX

Date: 2026-06-22

## Scope

This PR changes the SentinelLayer managed LLM proxy client error path.

Touched AI-impacting files:

- `src/ai/proxy.js`
- `src/audit/persona-loop.js`
- `src/session/daemon.js`

## Baseline

Before this change, `/api/v1/proxy/llm` quota and paywall denials were collapsed into a plain JavaScript `Error`. The CLI discarded structured `error.details`, `Retry-After`, `X-RateLimit-*`, reset timing, upgrade URL, checkout mode, and request id fields.

Hard quota responses with HTTP 429 were also retried like transient infrastructure throttles. That wasted retry attempts and delayed the actionable user message.

Audit persona fallback events and Senti daemon `model_span` events preserved only a flattened error string, so downstream artifacts could not distinguish trial expiry, daily quota, weekly quota, budget cap, or IP throttling.

## Candidate

The candidate adds a typed `SentinelayerProxyError` plus `serializeProxyError()` in the proxy client. It parses the deployed proxy denial contract, keeps hard quota/paywall denials fail-fast, keeps transient 429 retry behavior when no quota metadata is present, and formats reset/upgrade guidance in the central error message.

Audit `llm_error` and Senti `model_span` payloads now preserve structured proxy metadata under `proxyError` while keeping existing fallback behavior intact.

Prompt text, model selection, provider routing, tool permissions, and finding parsing are unchanged.

## Risk Assessment

- Prompt-output behavior risk: low. No prompts or parsers changed.
- Provider-routing risk: low. SentinelLayer proxy remains the same provider path.
- Billing/entitlement UX risk: reduced. Quota/paywall denials now show reset and upgrade guidance instead of a generic proxy error.
- Retry risk: reduced for hard denials. Transient 429 responses without quota metadata still retry.
- Artifact compatibility risk: low. `proxyError` is additive on existing event payloads.

## Verification Plan

- Focused proxy/client tests prove structured denial parsing, no retry for hard quota 429, retry for transient 429, and preservation through `MultiProviderApiClient`.
- Focused audit and session daemon tests prove `proxyError` is written to `llm_error` and `model_span`.
- Full unit, E2E, package dry-run, local review scan, and local Omar diff must pass before merge.
