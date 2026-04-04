# PR 119 Eval Evidence - Spec-Bound Deterministic Review

Date: 2026-04-04  
PR: `roadmap/pr-140-spec-bound-review`

## Impacted AI-sensitive surface

- `src/review/ai-review.js` (prompt context now includes deterministic spec-binding metadata)
- `src/commands/review.js` (`--spec <path>` threading into review execution context)

## Change class

- Functional enhancement with deterministic guardrail additions.
- Introduces spec-bound findings (`SL-SPEC-001`, `SL-SPEC-002`) into deterministic review pipeline.
- AI review path receives additional grounded context only (spec path/hash/signals); no model/provider switch.

## Deterministic validation

1. `npm run verify`
- Result: pass.

2. `node bin/create-sentinelayer.js /omargate deep --path . --json`
- Result: pass with non-blocking baseline findings.
- Counts: `p1=0`, `p2=10`, `blocking=false`.

3. `node bin/create-sentinelayer.js /audit --path . --json`
- Result: `overallStatus=PASS`, `p1Total=0`, `p2Total=10`.

4. PR CI state before this evidence file
- `Eval Impact Gate`: fail (expected; missing eval artifact for AI-sensitive changes).
- Omar Gate + syntax/unit/e2e: pass.

## Risk assessment

- Main risk: false positives in scope drift/coverage-gap findings when spec intent is underspecified.
- Mitigation:
  - deterministic `--spec` path + hash emission for replayability,
  - mode-aware scope checks (`diff|staged`),
  - unit + e2e coverage for spec parsing, route extraction, and CLI contract.
