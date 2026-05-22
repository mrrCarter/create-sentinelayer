# PR 511 Eval Evidence - CLI LLM Usage Emitters

Date: 2026-05-22

## Scope

AI-impacting file changed:

- `src/commands/chat.js`

Related billing surfaces changed:

- `src/commands/spec.js`
- `src/commands/scan.js`
- `src/billing/llm-session-usage.js`
- `src/billing/ledger-entry.js`

The change does not alter prompts, provider selection, model routing, temperature, max token settings, or response parsing. It records durable billing/v1 `session_usage` events after successful LLM calls and reports proxy-provided token/cost usage when available.

## Baseline

- `chat ask`, `spec generate --ai`, and `scan precheck` called LLM providers and wrote local cost/run telemetry only.
- The Senti session usage ledger and web header could remain empty for these priced CLI paths.
- `chat ask` reported input/output token estimates but no cost and no billing result in JSON.

## Candidate

- `chat ask` emits `chat_ask` billing/v1 usage after non-dry-run LLM calls.
- `spec generate --ai` emits `spec_generate_ai` billing/v1 usage after AI refinement.
- `scan precheck` emits `scan_precheck` billing/v1 usage after AI report generation.
- Metadata is sanitized by the existing billing ledger path; raw prompt/response/text fields are omitted.
- If a SentinelLayer proxy response includes provider usage, CLI cost accounting uses that over local estimates.
- Dry-run chat remains unbilled and returns `billing.reason = "dry_run"`.

## Eval Checks

- `node --test tests/unit.billing-session-usage.test.mjs` -> 4/4 passed.
- `node --test tests/unit.ai-proxy.test.mjs tests/unit.review-ai.test.mjs tests/unit.commands-contracts.test.mjs` -> 23/23 passed.
- `npm run check -- src/billing/ledger-entry.js src/billing/llm-session-usage.js src/commands/chat.js src/commands/spec.js src/commands/scan.js tests/unit.billing-session-usage.test.mjs` passed.
- `git diff --check` passed with Windows LF/CRLF warnings only.

## Regression Notes

- Expected model output is unchanged because no prompt or model-call parameters changed.
- Expected CLI output delta is additive: `chat ask` now includes `cost_usd` in the terminal usage line and `billing` in JSON output.
- Expected session transcript/export delta is additive: billing/v1 `session_usage` events now exist for the three priced CLI LLM commands and count as priced usage actions.
