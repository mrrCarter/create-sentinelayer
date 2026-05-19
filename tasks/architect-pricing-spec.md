# Architect Pricing And Token Metering Spec

Date: 2026-05-19
Owner: Codex
Status: draft for Claude/Omar review

## Problem

Senti sessions need billing-grade usage accounting. The user should see live token/cost totals in the session, downloaded Markdown should include session and per-agent totals, and paid product actions such as checkpoint generation, recaps, audits, and delegated agent work need idempotent ledger entries.

## Current State

- CLI can emit `session_usage` events with `inputTokens`, `outputTokens`, `totalTokens`, and `costUsd`.
- CLI and API markdown renderers roll up `payload.usage` into per-agent/session totals.
- Web header stats show `totalCostUsd`, event count, active duration, and loaded participant token/cost breakdown.
- There is not yet a complete, versioned billing ledger for recap/checkpoint/audit actions.

## Event Sources

Usage can come from:

- Direct LLM calls inside CLI/persona/orchestrator flows.
- API summary/checkpoint generation calls.
- Omar/audit runs.
- Background recap/checkpoint daemons.
- Third-party provider traffic projected through AIdenID.

Each billable interaction must produce one idempotent ledger event:

```json
{
  "ledgerEntryId": "bill_<stable-id>",
  "sessionId": "uuid",
  "agentId": "codex",
  "action": "session_recap|checkpoint_generate|audit_run|agent_message",
  "model": "gpt-5.4-mini",
  "priceBookVersion": "2026-05-19",
  "inputTokens": 1200,
  "outputTokens": 300,
  "totalTokens": 1500,
  "providerCostUsd": 0.003,
  "customerCostUsd": 0.015,
  "idempotencyKey": "stable-source-key",
  "createdAt": "2026-05-19T09:00:00.000Z"
}
```

## Price Book

The first product price book should be explicit and versioned:

- Token pass-through cost is computed from the selected provider/model rate.
- Checkpoint generation may have a fixed milestone charge, e.g. the current Carter anchor of `$5/checkpoint`, but only if the UI labels it as a paid action.
- Recaps should default to token-cost accounting first; add fixed pricing only after UX confirms users understand automatic background charges.
- Audits can carry a higher action multiplier because they run deeper review loops, but the multiplier must be visible in export and admin views.
- Unknown model rates must not silently bill as zero in production. They should be marked `unpriced` and surfaced for admin review.

## Invariants

- Idempotency key prevents double billing on retry.
- Raw prompts and responses are not required in billing events; token counts and hashed source ids are enough.
- Exports show provider cost and customer cost separately once customer pricing is enabled.
- Session totals equal the sum of accepted ledger entries, not the sum of untrusted client claims.
- Free or internal dogfood sessions are flagged by policy, not by deleting usage data.

## PR Batches

1. `PRC-1` CLI price book module and pure ledger calculator for `session_usage` events.
2. `PRC-2` API ledger table and idempotent ingest endpoint for billable session actions.
3. `PRC-3` Web live usage panel: session total, per-agent total, and recent billable actions.
4. `PRC-4` Markdown export: provider/customer totals, price book version, and per-agent ledger rows.
5. `PRC-5` Admin reconciliation: compare provider invoices, session ledgers, and exported totals.

## Acceptance

- Replaying the same usage event does not change billed totals.
- A session export can explain exactly which agent/action spent tokens and how the total was computed.
- Background recaps/checkpoints are visible as billable or free before charges are applied.
- Admin reconciliation can detect unpriced models, duplicate idempotency keys, and mismatched totals.
