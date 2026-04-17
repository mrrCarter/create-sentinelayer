# Sentinelayer Sessions

Sentinelayer Sessions are ephemeral coordination channels for multiple coding agents and human operators. The session stream provides shared context, event replay, assignment visibility, and deterministic evidence for review and incident response.

## Why Sessions Exist

When multiple agents operate on the same codebase, failure patterns repeat:

- overlapping edits and revert loops
- duplicated task execution
- stale context for newly joined agents
- no single record of who changed what and why

Sessions solve this with a common event stream, explicit assignment state, and enforceable kill controls.

## Core Commands

```bash
sl session start --path . --json
sl session join --id <session-id> --name codex-1 --role coder
sl session say --id <session-id> --from codex-1 --message "PR #123 opened"
sl session read --id <session-id> --tail 50
sl session status --id <session-id> --json
sl session list --json
sl session leave --id <session-id> --agent codex-1
sl session kill --id <session-id> --agent senti --reason "manual stop"
```

## Session Lifecycle

1. Start a session.
2. Join agents (coder, reviewer, tester, senti).
3. Exchange status/messages through the stream.
4. Track assignment and lock state through status/list.
5. Run Omar gates before merge.
6. Kill or leave agents explicitly when a loop is complete.
7. Archive and inspect analytics/artifact lineage.

## Omar Handshake Loop (P0/P1 Gate)

Use this loop between PRs:

1. Local pass-one:
   - `sl review scan --path . --json`
2. Local deep gate at PR-ready:
   - `sl omargate deep --path . --json` (or interactive `/omargate deep`)
3. Open PR and watch pass-two:
   - `gh pr checks <pr-number> --watch`
4. Extract Omar verdict:
   - `gh run view <omar-run-id> --log --job <omar-job-id> | rg "OMAR_P0|OMAR_P1|OMAR_P2"`
5. Merge only when:
   - `OMAR_P0=0`
   - `OMAR_P1=0`

P2 findings are non-blocking by policy unless elevated by governance.

## Assignment and File-Lock Guardrails

- Use deterministic assignments with lease heartbeat and explicit release.
- Use file lock reservations before broad edits.
- Use `session kill` when an agent is stalled or out-of-scope.
- Preserve event correlation IDs for cross-run observability.

## Runtime Artifacts

Session artifacts are stored under `.sentinelayer/` and observability paths:

- session stream records (`ndjson`)
- analytics sidecars (`analytics.json`)
- lineage sidecars (`artifact-chain.json`)
- daemon telemetry and kill-path evidence

## Human-in-the-Loop (HITL)

- Any high-risk autonomous remediation should route through HITL approval.
- Reviewer decisions and Omar outcomes should be retained for calibration.
- Every autonomous loop should have an explicit rollback path.

## Related Docs

- [Multi-Agent Session Spec](./MULTI_AGENT_SESSION_SPEC.md)
- [README Session Overview](../README.md#multi-agent-session-workflow)
