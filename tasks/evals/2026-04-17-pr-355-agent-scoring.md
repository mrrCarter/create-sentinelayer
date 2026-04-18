# Eval Evidence - PR #355 (Agent Scoring + Wildcard Routing)

Date: 2026-04-17 (backfilled 2026-04-18 per audit `tasks/codex-session2-audit-summary.md` §2.3)
PR: create-sentinelayer#355
Spec section: `docs/MULTI_AGENT_SESSION_SPEC.md` §PR 15
Scope trigger: scoring weights feeding wildcard task routing; routing-logic change, not prompt-level.

## What changed
- `src/session/scoring.js` — agent score aggregator (findings confirmed/disputed, heartbeat reliability, cost efficiency)
- Wildcard routing: when a task has capability tag `*` or `any`, Senti routes based on scoring ranking
- Score-decay over session age to prevent early-session sample bias

## Eval impact assessment
- **Prompt changes:** NO
- **Model-route changes:** NO
- **Tool allowlist changes:** NO
- **Policy/routing changes:** YES — new scoring-based routing path. Deterministic formula: score = (truth_verdicts_confirmed / total) * 0.5 + (heartbeat_timely / total) * 0.3 + (cost_within_budget) * 0.2

## Validation evidence
- `node --test tests/unit.session-scoring.test.mjs` — 6 tests pass (score calc, decay application, tie-breaking by earliest-joined, routing integration, zero-history agent default, score persistence across archive)
- Omar Gate on merge: P0=0, P1=0, P2=5

## Risk summary
- **Primary risk:** scoring feedback loop creates a rich-get-richer dynamic where the first agent to claim a few wins gets all future routing. Mitigated by decay + minimum sample threshold (5 work items) before any score weight applied.
- **Residual risk:** low; routing is deterministic and observable in the audit trail.

## Follow-ups
- Add eval regression test asserting score-weighted routing converges on higher-quality agents in adversarial scenarios (tracked).
