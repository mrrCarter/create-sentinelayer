# CLAUDE.md

Autonomous execution contract for this repository.

## Scope Discipline
- Work one roadmap PR scope at a time.
- Do not mix unrelated fixes into the active PR.
- Prefer small, reviewable commits with deterministic diffs.

## Omar Loop Contract
1. `git checkout main && git pull --ff-only`
2. `git checkout -b roadmap/pr-<n>-<slug>`
3. Implement scoped changes.
4. `npm run verify`
5. `node bin/create-sentinelayer.js /omargate deep --path . --json`
6. `node bin/create-sentinelayer.js /audit --path . --json`
7. `git push -u origin <branch>`
8. Open PR (`gh pr create`)
9. Watch only `Omar Gate`:
   - `gh run list --workflow "Omar Gate" --branch <branch> --limit 1 --json databaseId --jq ".[0].databaseId"`
   - `gh run watch <runId> --exit-status`
10. If P0/P1/P2 findings remain, fix and repeat.
11. Merge when gate is green.
12. Update `tasks/todo.md` and `tasks/lessons.md`.

## Non-Negotiables
- No secret leakage in code, logs, artifacts, or PR comments.
- No merge without green Omar Gate and quality checks.
- Keep generated artifacts reproducible under `.sentinelayer/`.
