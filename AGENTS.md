# AGENTS.md

Repository-level operating contract for AI agents working in `create-sentinelayer`.

## Mission
- Deliver secure, deterministic CLI behavior with reproducible artifacts.
- Keep one PR scope per branch and enforce Omar-loop quality gates.

## Required Workflow
1. Sync from `origin/main` and branch with roadmap naming (`roadmap/pr-<n>-<slug>`).
2. Implement only the scoped PR contract.
3. Run:
   - `npm run verify`
   - `node bin/create-sentinelayer.js /omargate deep --path . --json`
   - `node bin/create-sentinelayer.js /audit --path . --json`
4. Push and open PR.
5. Watch GitHub `Omar Gate` workflow to completion with `gh run watch`.
6. If Omar reports blocking findings, fix and rerun until green.
7. Merge only when checks are green and update `tasks/todo.md` and `tasks/lessons.md`.

## Security Boundaries
- Never hardcode or print secrets in logs/artifacts.
- Preserve least-privilege defaults for auth, MCP, daemon, and workflow permissions.
- Treat identity provisioning and networked automation as high-risk actions requiring explicit safeguards.

## Governance Files
- `CLAUDE.md` defines autonomous Omar loop behavior for this repo.
- `.github/instructions/*.instructions.md` define path-scoped coding/review rules.
- `.github/AI_CHANGE_CLASSIFICATION.md` defines required AI change classes used by PR template.

## Quality Requirements
- Keep `--json` outputs stable and machine-readable.
- Add or update tests for behavior changes.
- Avoid weakening CI/security gates to make tests pass.
