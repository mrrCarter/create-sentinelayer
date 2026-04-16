# Eval Evidence - 2026-04-16 - AIdenID/AuthAudit Coverage Flake Stabilization

## Scope
- `src/ai/aidenid.js`
- `tests/unit.ai-aidenid.test.mjs`
- `src/agents/jules/tools/auth-audit.js`

## Problem
- Aggregate coverage execution (`c8 node --test tests/unit*.test.mjs`) intermittently failed:
  - AIdenID credential test resolved host-local session creds instead of env-only fixture.
  - AuthAudit provisioning retry path emitted late async rejection after timeout race settled.

## Change
- Added `autoResolveSession` control to AIdenID credential/session resolution and set unit env-fixture tests to `autoResolveSession: false`.
- Hardened AuthAudit retry timer cleanup by swallowing `finally()` chain rejection to prevent post-test `unhandledRejection`.

## Evaluation
- `node --test tests/unit.ai-aidenid.test.mjs`
- `node --test tests/unit.jules-auth-audit.test.mjs`
- `npm run verify`
- `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p0=0`, `p1=0`)
- `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1=0`)

## Outcome
- Verification and coverage gates pass deterministically for this change set.
