# Eval Evidence - PR 198 AIdenID Async Regression Fix

Date: 2026-04-08
Branch: roadmap/pr-198-aidenid-async-fixes

## Impacted AI Surface
- `src/ai/aidenid.js` (`resolveAidenIdCredentials` lazy-fetch/precedence path)
- `src/commands/ai/provision-governance.js` (async credential resolution)
- `src/commands/ai/identity-lifecycle.js` (async credential resolution)
- `src/agents/jules/tools/auth-audit.js` (async credential resolution)

## Risk
- Promise misuse at call sites caused runtime failures (`missing.length` on unresolved Promise).
- Token-only sessions could not lazy-fetch AIdenID credentials.

## Deterministic Verification
- `node --test tests/unit.ai-aidenid.test.mjs` -> pass (10/10)
- `node --test tests/unit.jules-auth-audit.test.mjs` -> pass (7/7)
- `node --test tests/unit.auth-service.test.mjs` -> pass (5/5)

## Assertions Added
- Async credential-resolution tests now await and enforce rejection semantics.
- Added token-only session lazy-fetch success case.
- Added auth-service shape check asserting `aidenid` presence in active session/status payload.
