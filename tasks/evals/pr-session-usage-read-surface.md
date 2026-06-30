# PR: session usage read surface

Date: 2026-06-30
Branch: codex/session-usage-read-surface-20260630

## Scope

- Adds `sl session usage <sessionId>` for sanitized session token/cost reports.
- Local mode reads existing local session events and reuses the pricing ledger.
- `--remote` first calls the hosted account-scoped `GET /api/v1/sessions/{id}/usage` endpoint; older API fallback hydrates events and marks that fallback in JSON.
- Outputs summary, markdown, or JSON without raw prompt text, response text, config values, or raw idempotency keys.

## Security Gate Notes

- Tenant scope: remote mode uses the existing authenticated session token and hosted `/usage` endpoint, which is server-side scoped by session access. The CLI never accepts a tenant/user override.
- Redaction: report entries include totals, ledger ids, and `idempotencyKeyHash`; raw `idempotencyKey`, prompt, and response fields are not serialized.
- Config secret non-leak: the report builder only consumes usage ledger fields and does not traverse config objects.
- Bounded filters: the only new bound is recent entries `0-50`; hosted fetch uses `limit=500` max.

## Verification

- `node --test tests\unit.session-usage-report.test.mjs tests\unit.session-sync.test.mjs tests\unit.commands-contracts.test.mjs tests\e2e.session-download.test.mjs` - pass, 55/55
- `npm run check` - pass, 341 files
- `npm run test:unit` - pass, 1651/1651
- `npm run test:e2e` - pass, 112/112
- `node bin\create-sentinelayer.js review scan --mode diff --json` - pass, P1=0/P2=0, blocking=false
- `node bin\create-sentinelayer.js /omargate deep --path . --json` - pass, P0=0/P1=0, P2=2 broad testing-inventory advisories, blocking=false
- Live smoke: `node bin\create-sentinelayer.js session usage 954233b7-1822-42bc-9cfe-1eb95eb0357a --remote --recent 3 --json` returned `source=remote_usage`, HTTP 200, sanitized schema `session_usage_report/v1`.
