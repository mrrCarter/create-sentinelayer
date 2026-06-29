# PR 677 Eval Evidence: Senti Usage Metering Preservation

Date: 2026-06-29
PR: create-sentinelayer#677
Scope trigger: `src/ai/client.js` now preserves provider-reported token usage for direct non-stream LLM calls.

## What Changed

- Direct OpenAI, Anthropic, and Google non-stream responses now return normalized provider usage when the upstream payload reports tokens.
- Senti managed help responses now emit a local `session_usage/local-v1` event from measured proxy usage.
- The Senti local usage event uses the same deterministic help-request idempotency key as the proxy call and sets `syncRemote: false`.
- No visible chat-message estimates are emitted. Ordinary agent messages remain unmetered unless their caller/host reports actual usage.

## Eval Impact Assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: no.
- Response content parsing changes: no.
- Usage/accounting changes: yes. Provider-reported usage is retained instead of being dropped, and Senti help-response usage becomes visible in the local transcript ledger without double-syncing to the API.

## Baseline Behavior

Before this PR, direct provider calls could receive token usage from OpenAI, Anthropic, or Google, but `MultiProviderApiClient.invoke()` did not preserve it in the normalized result. Downstream callers fell back to estimates or reported zero usage even when the provider had already returned measured token counts.

For Senti managed help responses, the daemon wrote model-span telemetry but did not emit a `session_usage/local-v1` row from the measured proxy result. That left local recap/download usage views unable to show Senti help-response token/cost usage even though the proxy path had billing evidence.

## Candidate Behavior

The candidate keeps prompts, provider choice, streaming behavior, model parameters, and response text handling unchanged. It only preserves additive usage metadata:

- OpenAI `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens`.
- Anthropic `usage.input_tokens` and `usage.output_tokens`.
- Google `usageMetadata.promptTokenCount`, `usageMetadata.candidatesTokenCount`, and `usageMetadata.totalTokenCount`.
- Senti help-response local usage from the measured proxy result returned to the daemon.

The local Senti usage row is intentionally not synced back to the API. The `/api/v1/proxy/llm` request already creates the durable billing row for the same idempotency key, so syncing the local row would risk double-counting `Session.total_cost_usd`.

## Eval Cases

- OpenAI non-stream response with provider usage returns `inputTokens: 31`, `outputTokens: 9`, and `totalTokens: 40`.
- Anthropic non-stream response with provider usage returns `inputTokens: 44`, `outputTokens: 12`, and `totalTokens: 56`.
- Google non-stream response with provider usage returns `inputTokens: 22`, `outputTokens: 11`, and `totalTokens: 33`.
- Senti managed help response emits one local `session_usage/local-v1` event with `action: "proxy_llm"`, measured input/output/total tokens, cost, and `syncRemote: false`.
- The Senti usage idempotency key matches the proxy request idempotency key so later hydrated billing rows can dedupe locally by key.

## Validation Evidence

Focused checks:

- `node --import ./tests/setup-env.mjs --test tests/unit.ai-client.test.mjs tests/unit.session-daemon-context.test.mjs tests/unit.session-usage.test.mjs tests/unit.session-recap.test.mjs`
  - result: `36/36` passed.
  - verifies OpenAI/Anthropic/Google usage preservation, Senti help-response local usage emission, session usage aggregation, and recap usage totals.

Full branch checks:

- `npm run check`
  - result: `340` files passed.
- `npm run test:unit`
  - result: `1647/1647` passed.
- `npm run test:e2e`
  - result: `111/111` passed.
- `sl.cmd review scan --mode diff --json`
  - result: `P1=0`, `P2=1`, blocking=false. The remaining P2 is the non-blocking spec-scope advisory for `src/ai/client.js`.
- `sl.cmd /omargate deep --path . --json`
  - result: `P0=0`, `P1=0`, `P2=3`, blocking=false.

## Risk Assessment

Primary risk: double counting Senti help-response usage. Mitigation: the daemon records a local-only usage event with `syncRemote: false` because the proxy already writes durable API billing for the same idempotency key.

Secondary risk: fabricated or misleading costs for normal chat messages. Mitigation: this PR does not estimate visible chat-message token usage. It only reports provider-sourced usage from LLM calls that return measured usage.

Security risk: usage/cost data can be tenant-sensitive. Mitigation: this PR adds no new remote read surface and does not expose raw prompts, responses, secrets, API keys, or message content in the new usage row metadata.

Residual risk: future API/web usage rollups must enforce tenant-scoped reads and must keep provider tokens, raw prompts, raw responses, and secrets out of exported billing metadata.
