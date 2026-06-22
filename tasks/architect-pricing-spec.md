# Architect Pricing And Token Metering Spec

Date: 2026-05-19
Owner: Codex (PRC-1..5) · Co-author: claude-mythos (PRC-0.5 tier model)
Status: draft for Claude/Omar review

## Problem

Senti sessions need billing-grade usage accounting. The user should see live token/cost totals in the session, downloaded Markdown should include session and per-agent totals, and paid product actions such as checkpoint generation, recaps, audits, and delegated agent work need idempotent ledger entries.

## Current State

- CLI can emit `session_usage` events with `inputTokens`, `outputTokens`, `totalTokens`, and `costUsd`.
- CLI and API markdown renderers roll up `payload.usage` into per-agent/session totals.
- Web header stats show `totalCostUsd`, event count, active duration, and loaded participant token/cost breakdown.
- There is not yet a complete, versioned billing ledger for recap/checkpoint/audit actions.

## Product Pricing Model (PRC-0.5)

The product surface charges subscription tiers, not raw per-token. Token cost is the cost of goods; tier price is the value capture. Locked anchors per founder direction 2026-05-19:

| Tier | Price | Audits / mo | Effective $/audit | Seats | Report retention | Notes |
|------|-------|-------------|-------------------|-------|------------------|-------|
| **Free** | $0 | 1 | — | 1 | 7 days | Onboarding hook. Full deliverable, watermarked PDF/report. Personal repos only. |
| **Indie / Solo** | $149 / mo | 4 | ~$37 | 1 | 30 days | Personal repos, Slack export off, full report. |
| **Pro / Team** | $499 / mo | 15 | ~$33 | 5 | 90 days | Org repos, Slack export, role-based seats. |
| **Acquirer DD** | per-engagement, $1,499 anchor | 1-3 + audit/findings export + PlexAura DD Protocol overlay | DD package price; $500-$1,499 effective depending on scope | custom | engagement + 1 yr | Productized SKU for `SWE_excellence_framework.md` DD use case. White-glove. See market-anchor note below. |

**Pricing rules:**

- **Priced surfaces**: `sl audit` (full 15-agent swarm), `sl audit security` (Jules security-focused), `sl audit frontend` (Jules frontend-focused), `sl /omargate deep` (security analysis with LLM-backed depth). All count against the tier audit quota.
- **Free surfaces** (always, regardless of tier): `sl session say/join/read`, `sl session recap` (periodic recap is free, operational glue not deliverable), `sl session checkpoint create/list` (checkpoint is free, context anchor not analysis), `sl review scan` (deterministic local review, no LLM compute), dashboard reads, transcript export, `sl auth`, `sl spec`, `sl prompt`, `sl guide`.
- **Anchor framing** (market positioning, NOT a literal per-audit price in the DD SKU): the $99-$199 per-audit number is the **market-comparable price perception** for DD-grade audit work (Snyk paid tier, Veracode per-engagement scans, etc.). The DD SKU price ($1,499 / engagement) is the *package* price for 1-3 audits + findings export + PlexAura DD Protocol overlay, which produces an effective rate of ~$500-$1,499/audit at the package level. Use the $99-$199 number in marketing prose to anchor *perceived value*, not in the price table where users will do the math and notice the gap. Subscription tiers (Indie/Team) bundle to a meaningfully better effective rate ($33-$37/audit), which is the actual upsell ladder against the DD anchor.
- **Free tier rationale**: 1 audit/mo with full deliverable (watermarked) lets the user experience real value before paying. Cheap for us, one audit per user per month is small compute, and the deliverable quality is the conversion driver.
- **Overage policy**: when a paid tier exhausts its monthly audit quota, fail-closed with a clear "upgrade or wait until next cycle" error. **Never** silently bill overages without explicit user acknowledgement (no surprise invoices, that is a SS B.2.3 fail-closed application to the billing surface).
- **Free or internal dogfood sessions** are flagged by policy via a `billing_tier=internal` session attribute, not by deleting usage data. Usage data still records for accounting; charges are suppressed.

**Why this shape:**

- Charging the deliverable (multi-agent audit / security scan) and freeing the operational chatter (recaps, checkpoints, session events) is defensible to users: "we charge when we actually do work for you, not for talking."
- Subscription bundles avoid the "every action has a price tag" UX friction that kills CLI adoption. The user opens their wallet once.
- DD per-engagement SKU productizes the acquirer due-diligence use case directly, it is where the framework value already lives.
- Watermarked free-tier deliverables prevent the "perpetual free tool" weaponization.

## Event Sources

Usage can come from:

- Direct LLM calls inside CLI/persona/orchestrator flows.
- SentinelLayer proxy calls through `src/ai/client.js` (`MultiProviderApiClient.invoke`) and `src/ai/proxy.js` (`invokeViaProxy`); these must forward any supplied session metering context and preserve returned `usageLedger` provenance.
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
  "billingTier": "indie|team|dd|free|internal",
  "idempotencyKey": "stable-source-key",
  "createdAt": "2026-05-19T09:00:00.000Z"
}
```

Note the added `billingTier` field, required so the ledger entry records the tier in effect at write time. Tier changes mid-month must NOT retroactively re-rate existing entries (immutable ledger principle; SS B.2.4 idempotency applies at the entry, not at the rollup).

## Quota Enforcement Contract

For tiered priced actions (audit, deep omargate):

1. **Pre-action check**: server reads `(user, billing_tier, current_billing_period, audits_consumed)` and rejects if `audits_consumed >= tier_quota` with a structured error `{"code":"QUOTA_EXHAUSTED", "tier":"indie", "consumed":4, "limit":4, "resetsAt":"2026-06-01T00:00:00Z"}`. CLI surfaces the message verbatim, no silent retry, no degraded run.
2. **Atomic increment**: on action acceptance, increment `audits_consumed` in the same transaction that creates the ledger entry. If the increment fails, abort the action. SS B.2.3 fail-closed.
3. **Action completion**: even if the action errors mid-execution (LLM timeout, partial result), the audit slot is still consumed unless the failure is explicitly retriable (network blip, provider 5xx). Retriable failures get an explicit refund via a compensating ledger entry, never via silent decrement.
4. **Free-tier first-audit-of-month**: when `audits_consumed == 0` on free tier, mark the entry `tier=free` and skip Stripe charge entirely. No card on file required for free tier.

## Stripe Integration Sketch

Out of scope for the spec to enumerate, but the shape:

- **Customers** map 1:1 to SentinelLayer user accounts via `user.stripeCustomerId`.
- **Subscriptions** map 1:1 to active tier. Tier changes = subscription updates with proration handled by Stripe defaults.
- **Usage-based add-ons** (e.g. Acquirer DD per-engagement) are one-time invoice items billed against the customer.
- **Webhooks** consumed: `customer.subscription.created/updated/deleted`, `invoice.payment_succeeded/failed`, `customer.subscription.trial_will_end`. Webhook handler is the source of truth for tier state; the local `users.billing_tier` column is a cache that the webhook keeps in sync.
- **Idempotency keys on Stripe API calls** are mandatory per Stripe own docs and SS B.2.4. Use the same `idempotencyKey` from the ledger entry where possible.
- **No client-side Stripe.js calls hold a secret key**. Tier upgrades happen via signed checkout sessions or via the dashboard; the CLI never talks to Stripe directly. SS K.2, no token passthrough.

## Price Book

The first product price book should be explicit and versioned:

- Token pass-through cost is computed from the selected provider/model rate.
- Audits and `omargate deep` are gated by the tier quota above, not by per-action $5/$10/etc. price tags. Internal accounting still tracks provider cost per audit to track margin.
- Recaps and checkpoints carry no fixed pricing (PRC-0.5 lock). They consume provider tokens which are recorded for margin analysis but never billed to the user.
- Unknown model rates must not silently bill as zero in production. They should be marked `unpriced` and surfaced for admin review.

## Invariants

- Idempotency key prevents double billing on retry.
- Raw prompts and responses are not required in billing events; token counts and hashed source ids are enough.
- Exports show provider cost and customer cost separately once customer pricing is enabled.
- Session totals equal the sum of accepted ledger entries, not the sum of untrusted client claims.
- Free or internal dogfood sessions are flagged by policy, not by deleting usage data.
- **Quota state is server-side authoritative.** Client-side quota display is a cache for UX; the server enforces.
- **Tier downgrades take effect at end of current billing period.** Mid-period downgrade does not strip already-quota'd capacity.

## PR Batches

1. `PRC-0.5` Pricing tier addendum (this section). **Spec only, no code.** Co-authored by claude-mythos to lock the tier model.
2. `PRC-1` CLI price book module and pure ledger calculator for `session_usage` events.
3. `PRC-2` API ledger table and idempotent ingest endpoint for billable session actions.
4. `PRC-3` Web live usage panel: session total, per-agent total, and recent billable actions.
5. `PRC-4` Markdown export: provider/customer totals, price book version, and per-agent ledger rows. **In flight as sentinelayer-api PR #508.**
6. `PRC-5` Admin reconciliation: compare provider invoices, session ledgers, and exported totals.
7. `PRC-6` Stripe integration: Customer + Subscription wiring, webhook handler, signed checkout sessions, tier-state cache sync.
8. `PRC-7` Quota enforcement: pre-action check, atomic increment, compensating refunds, `QUOTA_EXHAUSTED` error surface.
9. `PRC-8` Dashboard tier management UI: current tier display, upgrade/downgrade flow via Stripe Checkout, audit-usage meter.

## Acceptance

- Replaying the same usage event does not change billed totals.
- A session export can explain exactly which agent/action spent tokens and how the total was computed.
- Background recaps/checkpoints are visible as billable or free before charges are applied.
- Admin reconciliation can detect unpriced models, duplicate idempotency keys, and mismatched totals.
- **A user on Free tier who runs their second audit in a month gets a clean `QUOTA_EXHAUSTED` error with upgrade CTA, not a surprise charge.**
- **A user on Team tier whose monthly Stripe invoice fails is gracefully downgraded with explicit user-visible communication, not silent quota cutoff.**
- **A DD engagement closes with a single invoice line item that ties to the audit + findings export artifacts.**

## Threat Model

- **Quota bypass via parallel sessions**: enforce quota at the user level, not the session level. Multiple concurrent `sl audit` invocations from the same user race-check the quota.
- **Replay of paid action**: idempotency key on the ledger entry. Retrying the same audit ID returns the cached result without re-consuming quota.
- **Tier downgrade arbitrage**: downgrade takes effect end-of-period, not immediately, so users cannot burn 14 audits on Team, downgrade to Indie, and pay $149 for what should have been $499.
- **Stripe webhook spoofing**: webhook handler validates signature using Stripe's verification SDK. SS K.2, strict signature check.
- **Card on file harvesting**: never store full card numbers; always rely on Stripe tokenization. CLI never sees card details. SS E.5 evidence: every charge maps to a Stripe payment intent ID that is auditable in Stripe dashboard.
- **Free tier abuse**: risk-based account creation controls, NOT a flat per-domain cap (a flat "3 accounts per domain" rule punishes legitimate `gmail.com`/`outlook.com` users and is trivially evadable via throwaway domains). The right controls:
  - **Normalized email**: lowercase + remove gmail-style dot variants and `+aliases` before uniqueness check.
  - **OAuth identity preferred**: GitHub/Google OAuth ties account creation to a real third-party identity, raising the cost of throwaway account creation.
  - **IP / device velocity**: flag bursts of accounts from the same IP / device fingerprint within a short window for manual review.
  - **Disposable-domain denylist**: maintained list (`mailinator`, `tempmail`, `guerrillamail`, etc.) blocks the easy evasion path.
  - **Payment / org reuse signals**: if Stripe sees the same card on multiple "new" accounts, flag for fraud review.
  - **Per-private-org-domain caps** only: domain-cap rules apply to *private* org domains (corporate emails like `@acme.com`) where reuse is expected, NOT to consumer email providers. Public domains are governed by the other controls above.
  - **Soft-then-hard**: first signal triggers human review and audit-quota throttle to 0 until cleared; second confirmed abuse triggers account suspension.
