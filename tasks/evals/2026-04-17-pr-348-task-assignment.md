# Eval Evidence - PR #348 (Task Assignment Delegation Protocol)

Date: 2026-04-17 (backfilled 2026-04-18 per audit `tasks/codex-session2-audit-summary.md` §2.3)
PR: create-sentinelayer#348
Spec section: `docs/MULTI_AGENT_SESSION_SPEC.md` §PR 8
Scope trigger: task-lease routing logic (deterministic), claim/heartbeat/release protocol.

## What changed
- `src/session/tasks.js` — TTL-based lease holder with heartbeat
- `src/commands/session.js` — `sl session claim`/`heartbeat`/`release` subcommands
- JSON-backed task store at `.sentinelayer/sessions/<id>/tasks.json`

## Eval impact assessment
- **Prompt changes:** NO
- **Model-route changes:** NO
- **Tool allowlist changes:** NO
- **Policy/routing changes:** YES but deterministic — work items route to agents based on capability tags on the task + declared capability on the agent (both string-match, no LLM involvement).

## Validation evidence
- `node --test tests/unit.session-tasks.test.mjs` — 7 tests pass (claim, double-claim-same-work, heartbeat-extends-lease, lease-expiry, release, capability-matching, orphan-recovery)
- Omar Gate on merge: P0=0, P1=0, P2=5
- Manual smoke: agent A claims work `refactor-auth`, crashes (simulated via `sl session kill --agent a`), lease expires after TTL, agent B picks it up and completes. Audit trail shows both claim and handoff events.

## Risk summary
- **Primary risk:** lease-expiry race where two agents both hold active claims briefly. Mitigated by single-writer file lock on `tasks.json` + atomic updates.
- **Residual risk:** low; no LLM or behavior surface changed.

## Follow-ups
- Add CLI-driven kill-switch test covering task-holder (tracked and shipped in PR #357).
