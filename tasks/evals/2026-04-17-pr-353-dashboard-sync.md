# Eval Evidence - PR #353 (Live Dashboard Stream + HITL, CLI side)

Date: 2026-04-17 (backfilled 2026-04-18 per audit `tasks/codex-session2-audit-summary.md` §2.3)
PR: create-sentinelayer#353
Spec section: `docs/MULTI_AGENT_SESSION_SPEC.md` §PR 13
Scope trigger: new outbound sync paths to sentinelayer-api for dashboard observability; deterministic HTTP, no LLM.

## What changed
- `src/session/sync.js` — outbound POST of canonical events to `/api/v1/sessions/<id>/events`, `/errors`, `/human-messages` polling
- `src/session/daemon.js` — integration points for sync emission
- `src/session/stream.js` — best-effort sync invocation after every `appendToStream`

## Eval impact assessment
- **Prompt changes:** NO
- **Model-route changes:** NO
- **Tool allowlist changes:** NO
- **Policy/routing changes:** NO — pure outbound HTTP + circuit breaker on repeated failures

## Validation evidence
- `node --test tests/unit.session-sync.test.mjs` — 7 tests pass (outbound post, circuit-breaker-opens, relay events no re-sync, metadata post, error post, inbound poll sanitization, inbound circuit breaker)
- Omar Gate on merge: P0=0, P1=0, P2=7

## Known cross-repo gap (flagged, not fixed in this PR)
- API routes `/api/v1/sessions/<id>/events` + `/human-message(s)` are **not yet implemented** on sentinelayer-api. CLI sync silently degrades via circuit breaker after 3 failures (by design). Dashboard live view requires API-side SSE endpoint + Web `Session.tsx` page before end-to-end works.
- Audit citation: `tasks/codex-session2-audit-summary.md` §2.1 + §2.8.
- Tracked as follow-up; not in scope for this backfill.

## Risk summary
- **Primary risk:** outbound sync burn if API URL is attacker-controlled via tampered session.apiUrl. Mitigated by apiUrl allowlist (PR #357) — accepts only canonical + staging + localhost.
- **Secondary risk:** outbound payload leaks raw secrets. Mitigated by redaction layer at stream sink (PR #357) so inbound events arrive already-redacted.
- **Residual risk:** moderate — server-side endpoints missing, so end-to-end dashboard sync is non-functional. User-visible "sync failing" warning surfaces after 3 circuit-breaker trips.

## Follow-ups
- Implement `/api/v1/sessions/<id>/events` + SSE endpoint on sentinelayer-api (~8h, tracked).
- Implement `Session.tsx` live page on sentinelayer-web (~6h, tracked).
