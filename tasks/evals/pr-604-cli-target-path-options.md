# PR 604 Eval Evidence: CLI Target Path Option Resolution

Date: 2026-06-22
PR: create-sentinelayer#604
Scope trigger: `src/commands/review.js` and `src/commands/audit.js` are eval-impacting command surfaces.

## What Changed

- Added shared nested-command option normalization in `src/commands/action-options.js`.
- Applied it to nested `review` commands so parent-provided `--path`, `--output-dir`, and related options are honored when the child command only has default values.
- Applied it to nested `audit` commands, including package/replay/diff/registry/specialist/local/frontend surfaces.
- Added cross-directory regressions proving `review scan --path <repo>` and `audit security --path <repo>` target the requested repo when invoked from a different current working directory.

## Eval Impact Assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: no.
- Command target-selection changes: yes. Nested commands now honor explicit parent/command-group options instead of silently using child defaults.

## Baseline Behavior

Before this PR, Commander bound duplicate nested flags such as `--path` to the parent command when the parent and child command both defined the option. Running from a CLI checkout:

- `review scan --path C:\tmp\sentinelayer-api-cli-audit-target --json`
- `audit security --path C:\tmp\sentinelayer-api-cli-audit-target --json`

silently scanned `C:\tmp\create-sentinelayer-cli-audit` instead of the requested API target. `--path=...` and global path variants did not fix the nested-command behavior.

## Candidate Behavior

The candidate merges parent command options into nested command action options only when the parent option was explicitly provided and the child value came only from a default or is undefined. Explicit child values still win. Top-level command behavior is unchanged.

Post-fix real command proof on sentinelayer-api `f929c1db90c5484528df413ac72b77be65af2d3f`:

- `node bin\sl.js review scan --path C:\tmp\sentinelayer-api-cli-audit-target --output-dir C:\tmp\sl-cli-audit-artifacts\postfix-review-scan --json`
  - target path: `C:\tmp\sentinelayer-api-cli-audit-target`
  - scanned files: `478`
- `node bin\sl.js audit security --path C:\tmp\sentinelayer-api-cli-audit-target --output-dir C:\tmp\sl-cli-audit-artifacts\postfix-audit-security --json`
  - target path: `C:\tmp\sentinelayer-api-cli-audit-target`
  - artifacts written under requested output directory
  - result: `P0=0`, `P1=0`, `P2=120`, non-blocking

## Validation Evidence

Focused checks:

- `node --import ./tests/setup-env.mjs --test --test-name-pattern "(review scan respects --path|audit security respects --path)" tests/e2e.test.mjs`
  - result: `2/2` passed
- `node --import ./tests/setup-env.mjs --test --test-name-pattern "(audit security|audit architecture|audit testing|audit performance|audit compliance|audit documentation|audit registry|review scan)" tests/e2e.test.mjs`
  - result: `11/11` passed
- `node --import ./tests/setup-env.mjs --test tests/unit.commands-contracts.test.mjs`
  - result: `18/18` passed

Full branch checks:

- `npm run check`
  - result: passed
- `npm run test:e2e`
  - result: `99/99` passed
- `npm run test:unit`
  - result: `1525/1525` passed
- `npm pack --dry-run`
  - result: package dry-run passed and included `src/commands/action-options.js`
- `git diff --check`
  - result: passed with expected LF/CRLF warnings in changed files
- `node bin\sl.js omargate deep --path . --no-ai --output-dir C:\tmp\sl-cli-audit-artifacts\cli-target-path-fix-omargate --json`
  - result: `P0=0`, `P1=0`, `P2=33`, non-blocking

## Residual Risk

Full local `sl audit --path . --no-session --json` still reports `P1=76` and `P2=35` on this repository with an ingest content-hash mismatch. That is tracked as the next severity-calibration and ingest-reconciliation remediation lane. It is not introduced by this target-path fix, and this PR intentionally keeps scope limited to command target resolution.
