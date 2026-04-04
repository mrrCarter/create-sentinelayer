# PR 144 Eval Evidence - Ingest Refresh and Cache

## Scope
AI-impacting command surfaces changed:
- `src/commands/review.js`
- `src/commands/audit.js`

Supporting ingest and orchestration changes:
- `src/ingest/engine.js`
- `src/review/local-review.js`
- `src/audit/orchestrator.js`
- `src/commands/spec.js`
- `src/commands/prompt.js`

## Deterministic Validation
- `npm run verify` (pass)
- `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
- `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)

## Eval-specific Checks
- Added `tests/unit.ingest-refresh.test.mjs` for:
  - missing-ingest refresh generation
  - stale detection (`content_hash_mismatch` / commit drift)
  - explicit `--refresh` regeneration and cache-hit follow-up
- Extended command contract coverage in `tests/unit.commands-contracts.test.mjs` for `--refresh` flags on `review`, `spec`, `prompt`, and `audit` command trees.
- Added e2e `CLI ingest resolver marks stale spec context and refreshes on demand` in `tests/e2e.test.mjs` validating stale detection + explicit refresh behavior through CLI output payloads.

## Notes
- Ingest fingerprinting now excludes `.sentinelayer/` artifacts to prevent self-invalidating cache hashes.
