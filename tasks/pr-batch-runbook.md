# PR Batch Runbook (SWE Excellence + CLAUDE Loop)

## Purpose
Operational checklist for executing Sentinelayer CLI roadmap PRs safely, one PR at a time, inside planned batches.

## Branching Convention
- Batch branch prefix: `roadmap/batch-<letter>-<theme>`
- PR branch prefix: `roadmap/pr-<phase>-<id>-<slug>`
- Example: `roadmap/pr-0-1-cli-commander-tree`

## Per-PR Execution Loop
1. Copy PR scope from roadmap into `tasks/todo.md` and mark only one PR id as `in progress`.
2. Confirm dependency PR ids are merged.
3. Implement only that PR scope.
4. Run local gates for touched surfaces.
5. Run local Omar checks (`/omargate deep`, `/audit`) and capture report paths.
6. Open PR with evidence block.
7. Run CI + Omar Gate workflow.
8. Resolve findings until P0/P1 are zero and agreed P2 policy is satisfied.
9. Update `tasks/todo.md` Review and `tasks/lessons.md`.
10. Merge and start next PR id.

## Minimum Gate Set
- CLI package gate: `npm run verify`
- Expanded gate when TypeScript migration lands:
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm test`
  - `npm run build`
- Security gate set (as introduced): dependency audit + secret scan + SAST

## Omar Loop Evidence Template
- Local deep scan command: `npx create-sentinelayer@latest /omargate deep --path .`
- Local audit command: `npx create-sentinelayer@latest /audit --path .`
- CI evidence:
  - workflow run URL
  - Omar run id
  - finding counts by severity
  - disposition for any non-zero P2

## SWE Framework Controls To Enforce In PR Descriptions
- AI change class and required reviewer level.
- Provenance metadata for AI-assisted modifications.
- Eval impact statement (prompt/policy/model-route changes).
- Tool/MCP security impact statement.
- Rollback and kill-switch path for high-risk changes.

## Batch-Level Exit Criteria
- All PR ids in batch merged with passing gates.
- No unresolved P0/P1 findings.
- Lessons updated with any newly observed failure pattern.
- Next batch dependencies explicitly confirmed before branch cut.
