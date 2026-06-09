# Project Senti Session Bootstrap + Audit Relay Eval Evidence

Date: 2026-06-09
Branch: `feat/project-senti-session`
PR: #588

## Change Class

Command/orchestration behavior change in `src/commands/audit.js` (audit run wiring) plus new session modules. No prompt, model, or LLM-call-path changes: the audit personas' agentic loop, providers, and prompts are untouched — the change relays already-emitted orchestrator lifecycle events into a senti session.

## Baseline Gap

- `origin/main` audit runs were silent outside the terminal: personas in a swarm had no shared room to announce start/completion, so coordinating agents lost context or polled artifacts.
- New projects scaffolded by `create-sentinelayer` had no senti session until someone manually ran `sl session start`.

## Implemented Guard

- `sentinel audit` gains `--session <id>` / `--no-session`; default resolves the workspace's most recent active local session. Relay is best-effort: posts are queued in order, failures counted and swallowed, a session outage can never fail an audit (fail-safe default).
- Orchestrator emits a deterministic `agent_complete` lifecycle event per persona (id, status, finding count, severity summary, duration) — additive; existing `--stream` consumers see one new event type.
- `bootstrapProjectSession` creates the project room at init, local-first with best-effort remote sync; init completes offline.

## Eval Runs

- Unit: `tests/unit.audit-session-reporter.test.mjs` (4 tests) asserts event→message mapping (start, per-persona start/finish, dispatch complete, final summary), strict transcript ordering, recency-based session resolution, disable flag, and failure-swallowing against a nonexistent session.
- Unit: `tests/unit.session-project-bootstrap.test.mjs` (3 tests) asserts session materialization, guide upsert markers, welcome message content, and `skipGuides` no-op.
- Full suite: 1479 pass / 0 fail (`npm run test:unit`).
- Live dogfood: scratch workspace + `sl session start` + `sentinel audit . --dry-run --agents frontend` relayed 5 ordered `session_message` events into the real session stream; summary printed `Senti session: 18b6abd3… (posted 5 update(s))`.

## Determinism

Relay messages are pure functions of orchestrator lifecycle payloads (no LLM in the relay path), so behavior is fully covered by the deterministic unit suite above.
