# PR 611 Eval Evidence: Omar Changed-File Persona Routing

Date: 2026-06-22
PR: create-sentinelayer#611
Scope trigger: Omar Gate persona routing and prompt scope affect review coverage and cost behavior.

## What Changed

- `sl omargate deep` now accepts `--scope-mode full|diff|staged` plus `--diff` and `--staged` aliases.
- `full` remains the default, so existing deep/full-depth runs still dispatch the full 13-persona roster.
- `diff` and `staged` reuse the deterministic review pipeline's git-aware file scope.
- When no explicit `--persona` include filter is present, changed-file scope routes only impacted personas through the existing ownership router.
- Each routed persona receives only its own scoped deterministic files and findings instead of the entire changed-file set.
- JSON output, saved review artifacts, stream events, and the markdown report expose `personaRouting` metadata so users can tell routed runs from full audits.

## Eval Impact Assessment

- Prompt changes: scoped prompt inputs change for `diff`/`staged` Omar runs only.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: yes. Changed-file Omar runs can reduce persona dispatch based on owned changed files.
- Review evidence surface changes: yes. Output now includes scope mode, scoped files, base/effective persona lists, routed files, and routing reason.

## Baseline Behavior

Before this PR, `/omargate deep` always ran deterministic review in `full` mode and dispatched personas from `--scan-mode` only. For PR-sized changes this meant:

- every persona saw the whole deterministic file scope,
- local dry-run and AI estimates overstated cost/coverage,
- diff/staged review semantics existed in `review scan` but not Omar,
- users could not prove which files each persona was asked to inspect.

## Candidate Behavior

- Default `omargate deep` still performs full deterministic scope and full scan-mode persona dispatch.
- `omargate deep --diff --ai-dry-run --json` scopes deterministic review to changed git files and routes personas by ownership.
- Manual `--persona` remains authoritative. A user can still force a persona over the changed-file scope.
- Reports and JSON explicitly label `scopeMode` and `personaRouting` so a routed PR check is not mistaken for acquisition-grade full audit coverage.

## Validation Evidence

Focused checks:

- `node --import ./tests/setup-env.mjs --test tests/unit.omargate-orchestrator.test.mjs tests/unit.commands-contracts.test.mjs`
  - result: `29/29` passed
- `node --test --test-name-pattern "omargate deep diff mode routes changed files" tests/e2e.test.mjs`
  - result: `1/1` passed

Full branch checks:

- `npm run check`
  - result: `335` files passed
- `npm run test:unit`
  - result: `1534/1534` passed
- `npm pack --dry-run`
  - result: package dry-run passed
- `git diff --check`
  - result: passed with expected LF/CRLF warnings in changed files

## Residual Risk

Changed-file routing is an opt-in PR/review acceleration path. It is not a replacement for `full` acquisition-grade or release-blocking audits. The output intentionally exposes the reduced effective persona list so downstream automation can require `scopeMode=full` when full coverage is mandatory.
