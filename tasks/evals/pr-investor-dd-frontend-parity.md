# PR Eval Evidence: Investor-DD Frontend Persona Parity

Date: 2026-06-22
Scope trigger: Investor-DD persona routing/orchestration and review execution behavior changed in `src/review/investor-dd-orchestrator.js`, `src/review/investor-dd-persona-runner.js`, `src/review/scan-modes.js`, and the new Jules adapter.

## What Changed

- Exported the canonical full-depth 13-persona roster from `src/review/scan-modes.js`.
- Updated Investor-DD's default roster to derive from the canonical full-depth personas instead of maintaining a separate 12-persona list.
- Added a deterministic Jules/frontend Investor-DD adapter at `src/agents/jules/tools/investor-dd.js`.
- Added support for repo-scoped Investor-DD tools so Jules' `frontend-analyze` runs once against the routed frontend surface, while existing file-scoped persona tools keep their per-file behavior.
- Fixed the legacy CLI dispatch path so `omargate investor-dd --persona` / `--skip-persona` filters are honored before the orchestrator runs.
- Updated the markdown summary to render the actual selected persona list when callers pass a subset.

## Eval Impact Assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: yes. Investor-DD now includes `frontend` with a deterministic `frontend-analyze` tool.
- Policy/routing changes: yes. Investor-DD default persona roster now matches full-depth Omar's 13-persona roster.
- Command behavior changes: yes. `omargate investor-dd` default runs now include frontend/Jules coverage instead of reporting frontend as missing.
- Persona filtering changes: yes. `omargate investor-dd --persona <ids>` now passes the filtered roster to the Investor-DD orchestrator instead of silently running the full default roster.

## Baseline Behavior

Before this PR, `omargate investor-dd` used a hard-coded 12-persona default roster:

- `frontend` was excluded even though full-depth Omar and progress reporting define it as canonical.
- The file router already knew how to route frontend files, but no Investor-DD runner registry entry consumed those routes.
- Dry-run/progress evidence could report a missing frontend capability, making Investor-DD less sellable as an end-to-end due-diligence scan.

## Candidate Behavior

The candidate uses one canonical full-depth roster for Investor-DD defaults and dispatches `frontend` through Jules' existing deterministic analyzer.

- `plan.personas` now includes 13 entries by default, including `frontend`.
- `progress.missingPersonas` no longer includes `frontend` for default runs.
- `persona-frontend.json` is produced with a single repo-scoped `frontend-analyze` invocation for the routed frontend files.
- Existing file-scoped persona tools retain their previous per-file invocation contract.
- `--persona frontend` command runs now produce `summary.personas=["frontend"]` and `localBudgetToolCalls=1`, proving the CLI bridge no longer drops persona filters.

## Validation Evidence

Focused tests:

- `node --import ./tests/setup-env.mjs --test tests/unit.investor-dd-persona-runner.test.mjs tests/unit.investor-dd-orchestrator.test.mjs tests/unit.investor-dd-progress.test.mjs tests/unit.investor-dd-file-router.test.mjs`
  - result: `44/44` passed
- `node --import ./tests/setup-env.mjs --test --test-name-pattern "investor-dd honors --persona|Investor-DD|investor-dd" tests/e2e.test.mjs tests/unit.investor-dd-persona-runner.test.mjs tests/unit.investor-dd-orchestrator.test.mjs tests/unit.investor-dd-progress.test.mjs tests/unit.investor-dd-file-router.test.mjs`
  - result: `6/6` passed, including the CLI filter regression

Static and full branch checks:

- `npm run check`
  - result: passed
- `npm run test:unit`
  - result: `1531/1531` passed
- `npm run test:e2e`
  - result: `100/100` passed
- `git diff --check`
  - result: passed with expected LF/CRLF warnings in changed files

Command-level proof:

- `node bin\sl.js /omargate investor-dd --path . --dry-run --no-email --no-dashboard --no-devtestbot --json`
  - result: `activePersonaCount=13`, `plannedPersonaCount=13`, `missingPersonas=[]`
- `node bin\sl.js /omargate investor-dd --path . --persona frontend --no-email --no-dashboard --no-devtestbot --json`
  - result: `summary.personas=["frontend"]`, `totalFindings=3`, `localBudgetToolCalls=1`, `routingSummary.routedPersonas=1`
- `npm pack --dry-run`
  - result: package dry-run passed and included `src/agents/jules/tools/investor-dd.js`
- `node bin\sl.js /omargate deep --path . --no-ai --json`
  - result: `P0=0`, `P1=0`, `P2=33`, `blocking=false`

## Residual Risk

The frontend adapter is deterministic and intentionally reuses Jules' existing static analyzer. It does not add live browser validation, LLM judgment, or runtime accessibility tooling; those remain future Investor-DD enhancements. The goal of this slice is roster/tool parity and truthful default coverage, not full Jules live-web validation.
