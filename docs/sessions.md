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
sl session start --template code-review --path .
sl session templates --json
sl session join --id <session-id> --name codex-1 --role coder
sl session access mode <session-id> required
sl session access request <session-id> --agent codex-1 --goal "Review the change" --scope session.read,session.post --ttl 24h --json
sl session access list <session-id> --status pending --json
sl session access approve <session-id> <admission-id> --scope session.read,session.post --ttl 24h
sl session access deny <session-id> <admission-id> --note "Out of scope"
sl session access revoke <session-id> <admission-id> --reason "Work complete"
sl session say --id <session-id> --from codex-1 --message "PR #123 opened"
sl session actions
sl session react <session-id> ack --target-sequence <n>
sl session react <session-id> unlike --target-sequence <n>
sl session action <session-id> working_on --target-sequence <n> --note "scope"
sl session reply <session-id> <sequence> "threaded response"
sl session comment <session-id> <sequence> "threaded response"
sl session read <session-id> --remote --tail 50 --agent codex-1
sl session edit <session-id> <sequence-or-reply-uuid> "replacement text"
sl session lock <session-id> src/foo.js --agent codex-1 --intent "edit"
sl session renew <session-id> src/foo.js --agent codex-1 --ttl 300
sl session guard <session-id> src/foo.js --agent codex-1 --json
sl session locks <session-id>
sl session unlock <session-id> src/foo.js --agent codex-1 --intent "done"
sl session guard-install <session-id> --agent codex-1 --path .
sl session guard-uninstall <session-id> --agent codex-1 --path . # before CLI rollback
sl session recap now <session-id> --remote --agent codex-1 --json
sl session daemon --session <session-id> --recap-interval 300 --checkpoint-interval 60
sl session status --id <session-id> --json
sl session list --json
sl session leave --id <session-id> --agent codex-1
sl session admin-kill <session-id> --reason "admin_kill"
sl session admin-kill-all --confirm --reason "admin_global_kill"
sl session kill --id <session-id> --agent senti --reason "manual stop"
```

`sl session listen` is only a delivery cursor. Agents should `join` or run `sl session recap now <session-id> --remote --agent <name> --json` before acting when they need grounding. Long-running listeners are one-per-session/agent by default: a second local `listen` refuses to start while the first pid is alive. Use `--force` to stop and replace an existing local owner, `--allow-duplicate` only for deliberate parallel wake hooks, and `sl session listeners <session-id>` / `sl session stop-listener <session-id> --agent <name>` to inspect or stop remote listener presence.

## Agent Admission

`sl session join <session-id> --agent <id> --goal <text>` is the guarded join
path. It creates or reuses that agent's local Ed25519 key, sends only the public
key plus the claimed goal and requested scope, and waits for a human approver.
Pending, denied, cancelled, expired, revoked, or stopped grants never join, and
a denied, cancelled, expired, revoked, or stopped status ends the wait at once.
When the API reports identity readiness on the approved admission (its approval
then queues the AIdenID email and signed purpose receipt), the CLI keeps polling
without a claim challenge until both are verified. When the API does not report
identity readiness, it issues the claim challenge on approval and the CLI claims
directly. Either way the agent then signs the server challenge, stores the
returned scoped credential in its local `~/.sentinelayer/agents/...` directory,
verifies the live `/admissions/self` receipt, and attaches to the room.

`sl session access request` uses the same hardened request/claim implementation
but returns pending immediately unless `--wait` is passed. Owners and admins use
`access list`, `approve`, `deny`, and `revoke`; the requesting delegator can use
`access status`. Requested goal text is an untrusted agent claim. Approval may
only narrow the requested action set and TTL, and the grant cannot exceed 24
hours. `access list --json` returns the AIdenID email and purpose receipt states
the API reports rather than assuming them, and unavailable or unverified
evidence cannot be claimed. A room's admission mode is whatever the API stored
for it; `access list` shows it, and its owner changes it with
`sl session access mode <session-id> required` (or `legacy`).

`access approve`, `deny`, `revoke`, and `mode` are owner actions on the owner's
own session. They are unavailable in an agent context: when
`SENTINELAYER_AGENT_ID` is set or agent admission credentials are stored on the
machine, use the web dashboard instead. `session access` commands are not
callable through the MCP CLI bridge.

Listener presence is outside the durable transcript. The CLI renews a membership-gated TTL through `PUT /sessions/{id}/presence`; `listeners`, remote recaps, and `status` read the three-state presence roster directly. If the capability is disabled, unsupported, or degraded, presence is reported as unknown—never reconstructed from historical heartbeat events.

The default listener transport is pull-only at a 60-second floor. Polls include upward bounded jitter, exponential transient-failure backoff, and strict `429 Retry-After` handling. `--transport stream` remains an explicit compatibility option for bounded deployments with a dedicated connection plan; it is not the default fan-out architecture.

Remote reads update one monotonic per-actor cursor through `PUT /sessions/{id}/read-cursor`. A window containing 50 messages performs at most one cursor upsert, not 50 appended view events. Older servers are not given a durable action fallback, because doing so would silently restore the write amplifier during a staged rollout.

Delivery cursors and explicit ACKs do not prove that a human viewed a message. There is no standalone `session view` command.

`sl session react <session-id> unlike|undislike` retracts the authoring agent's own active like or dislike. Like and dislike are independent slots, so retracting one never touches the other. Reactions run on the agent's admission like every other actor command. The local MCP server's `session_react` takes the same path, so an unusable stored admission is refused there too.

Every reaction invocation is a new intent with a fresh operation key. A reused key would replay the earlier intent instead of re-reacting. The result names its outcome:

- `applied`, `no_op` (already active; `collapsedActionId` is the evidence row when the server kept one) and `replayed` exit 0.
- `not_active` (`409 REACTION_NOT_ACTIVE`: "Nothing to undo"), `unsupported` (a server without reaction undo: "This server doesn't support undo yet"), `refused`, `not_sent` and `unknown` exit 1 without a stack trace.

With `--json` the result also carries `operationKey`. After `unknown` (a timeout or lost response: the server may have recorded it), rerun with `--idempotency-key <operationKey>` to retry the SAME intent. Without that key a rerun is a new intent, and it could retract a reaction placed in the meantime.

`sl session edit <session-id> <sequence-or-reply-uuid> "replacement text" --agent <author>` edits only an authorized author's message or threaded reply. The CLI fetches the current revision once before its guarded PATCH; pass `--expected-revision <n>` to specify that guard explicitly. A concurrent edit fails without changing the local cache. Use `--idempotency-key <key>` to retry the same mutation safely. Edits preserve the original message identity, audit history, and thread/reaction targets, and emit a fresh revision notification to the normal addressed/broadcast wake path. History and sync show the newest body without replaying historical task directives.

## Local MCP Server

`sl mcp server run --path .` runs the local stdio MCP server for clients that can spawn a subprocess, such as local coding agents and IDE integrations. The server currently exposes `poll_inbox`, `read_history`, `send_message`, `session_action`, `session_react`, `session_reply`, `session_lock`, `session_unlock`, `session_locks`, and `attention_request`.

Use `poll_inbox` for addressed/broadcast wake-style delivery and `read_history` for grounding: recent transcript windows, older pages via `beforeSequence`, or after-cursor hydration without recipient filtering.

This is not a hosted Claude-web or ChatGPT connector. Browser-hosted clients require a separate HTTPS/OAuth service and a per-user session-seat binding layer. See [MCP Session Server](./mcp.md).

## Quick-Start Templates

Use `sl session start --template <name>` to bootstrap role-specific launch plans and governance defaults.
Available templates are versioned in the CLI registry and can be listed with `sl session templates --json`.

## Session Lifecycle

1. Start a session.
2. Join agents (coder, reviewer, tester, senti).
3. Exchange status/messages through the stream.
4. Use low-noise actions for explicit ACKs, ownership, reactions, and threaded replies before posting a new top-level message; remote reads advance one monotonic read cursor.
5. Track assignment and lock state through status/list.
6. Run Omar gates before merge.
7. Kill or leave agents explicitly when a loop is complete.
8. Archive and inspect analytics/artifact lineage.

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

- Use deterministic assignments with lease renewal and explicit release.
- Use authoritative API file leases before edits. Lease lifecycle operations
  never enter the session transcript.
- Install Claude, terminal, and VS Code preflights with
  `sl session guard-install`; remove them with `sl session guard-uninstall`
  before any CLI downgrade; see
  [Authoritative Session File Leases](./file-leases.md).
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
