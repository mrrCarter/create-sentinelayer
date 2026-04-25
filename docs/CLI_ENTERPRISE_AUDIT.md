# SentinelLayer CLI — Enterprise / Standalone Readiness Audit

Last refreshed: 2026-04-25.
Scope: `create-sentinelayer/` (the `sentinelayer-cli` npm package).

This audit treats the CLI as an **agent-coordination bus** — anywhere
an open-internet agent (Claude / Codex / GPT / a custom shell-resident
agent) can `npm install -g sentinelayer-cli`, `slc auth login`, join a
session, and coordinate with humans + other agents — and lists the
gaps blocking that vision plus what already works.

## What already works (confirmed by reading `src/`)

| Capability | Surface | Notes |
|---|---|---|
| Browser-based auth + token rotation | `slc auth login`, `src/auth/*` | OAuth via web; refresh-on-expiry implemented |
| Session create / join / leave / kill | `slc session ...`, `src/session/store.js` | Multi-agent registry per session |
| Bidirectional human ↔ agent messaging | `slc session say`, `slc session sync`, `slc session read --remote` (#407) | Web posts now hydrate into local NDJSON |
| Past-conversation browsing | `slc session list --include-archived`, `slc session history` (#408) | Local cache; remote merge queued |
| 13-persona AI review (Omar Gate) | `slc /omargate deep`, `slc /omargate investor-dd` | Investor-DD adds compliance + live-web validation |
| Multi-tenant token isolation | `src/auth/session-store.js` | Per-user keyring fallback |
| MCP registry | `src/mcp/registry.js` | MCP servers are registerable |
| Telemetry sync to dashboard | `src/telemetry/sync.js` | Fire-and-forget |
| Cost tracking + budget eval | `src/cost/*` | Per-model pricing, budget governance |
| Daemon (Senti orchestrator) | `src/session/daemon.js` | Monitors session health, idle, stale agents, file locks |
| Session export (this PR) | `slc session export` | JSON or NDJSON; metadata + agents + events + tasks |
| Audit replay | `slc /audit`, `src/audit/replay.js` | Reproducible findings |
| Spec-aware bridge | `src/review/spec-binding.js` | Spec-grounded reviews |
| Coordination primitives | `src/coord/*` | priority queue, handshake, events log, file locks |

## Confirmed gaps (ordered by leverage to the "open agent on the bus" vision)

### G1. No SSE / WebSocket streaming surface

**Today:** clients poll the local NDJSON file; remote sync is HTTP
GET-with-cursor on a 1-3s loop in the daemon, manual via
`session sync` for one-shots.

**Cost:** sub-second cross-agent communication is impossible. An
external agent on a Worker / serverless can't get a real-time push
of session events without burning a long-lived process to poll.

**Fix shape:** add `GET /api/v1/sessions/<id>/stream` (Server-Sent
Events) on `sentinelayer-api`; CLI ships `slc session tail --remote`
that subscribes to it. Streaming keeps a TCP connection open, no
poll, no cursor drift.

### G2. No outbound webhooks for session events

**Today:** events live in the dashboard + local NDJSON. External
systems (Slack / Datadog / a custom dispatcher) have no push channel
for "human posted in session X" or "Senti detected idle".

**Fix shape:** `slc session webhook add <url> --events session_message,daemon_alert`
+ API table. Sign payloads with HMAC-SHA256, retry with backoff,
suppress duplicates by event id.

### G3. No agent role-based permissions inside a session

**Today:** every agent that joins can post, claim leases, hold file
locks. No write/admin distinction.

**Fix shape:** add `role` enum to agent registration:
`observer | reviewer | coder | admin`. Enforce on `say` / `assign-lease` /
`kill`. Already partially typed in `src/session/agent-registry.js`
but unenforced.

### G4. No rate limiting on the CLI → API path

**Today:** a misconfigured agent can flood `appendToStream` →
`syncSessionEventToApi` and saturate the API. Circuit breaker exists
(`outboundCircuit` in `src/session/sync.js`) but only for failures, not
for excess success traffic.

**Fix shape:** add a token-bucket rate limiter in `src/auth/http.js`
keyed by `(agentId, sessionId)`. Default 60 messages/min/agent. Make
the soak window configurable via `vars.SENTI_RATE_LIMIT_PER_MIN`.

### G5. No session export → S3 archive in CLI

**Today:** `archiveSession` in `src/session/store.js` already wires S3
upload, but only via a code path most users don't reach. No CLI
surface to invoke it.

**Fix shape:** wire `slc session archive <id> --bucket <s3>` to the
existing `archiveSession()`. Needed for compliance / data retention.

### G6. No "claim a session by handle" flow for headless agents

**Today:** agents need both the sessionId AND the bearer token. A
human running `slc session create` then DMing the id to a Worker
agent is fine, but there's no claim/grant workflow with optional
expiring tokens.

**Fix shape:** `slc session grant <id> --to <agentId> --ttl 1h
--scope post,read` mints a scoped JWT that any agent can use to join
without the human's full token. Already partially shaped via
`src/auth/gate.js`.

### G7. Session search / full-text query

**Today:** `slc session list --include-archived` lists by id. To find
a past conversation about "investor-DD", you `grep` the NDJSON
manually.

**Fix shape:** local sqlite fts on `.sentinelayer/sessions/*/stream.ndjson`,
exposed as `slc session search "<query>"`. Indexes on every append.

### G8. No multi-session reconnect for a single agent

**Today:** an agent picking work across two sessions has to invoke
the CLI twice. There's no per-agent inbox view.

**Fix shape:** `slc agent inbox` (alias `slc me`) — lists every
session the current agent is registered in, last activity, unread
count.

### G9. No browser-launched session (deep link from web)

**Today:** the dashboard shows sessions but you cannot click "open
in CLI". Users copy the id manually.

**Fix shape:** dashboard "Open in CLI" link → custom protocol
handler `slc://session/<id>` that runs `slc session join <id>`. Adds a
one-line registration on first install.

### G10. No SSO / SCIM

**Today:** auth is OAuth + opaque tokens scoped to one user. Enterprise
buyers want SAML/OIDC + SCIM provisioning of seats.

**Fix shape:** owned by `sentinelayer-api`, but CLI needs `slc auth
login --sso <orgSlug>` to support an `org` claim end-to-end.

### G11. No CLI-side audit log of sensitive operations

**Today:** kill / archive / lease-revoke happen but there's no local
append-only audit log Carter can review six months later.

**Fix shape:** `.sentinelayer/audit.log` (NDJSON, signed-rolling).
Every command that mutates remote state appends; never deletable.

### G12. No "warm join" for a long-running session

**Today:** `slc session join` registers the agent but doesn't fetch
context. The agent has to issue a separate `read --tail 100`.

**Fix shape:** `slc session join --warm` returns the last N events +
the recap so an agent has full context after one call.

## Things already partially shipped that need follow-up to be enterprise-ready

- **`investor-dd` pipeline** (#388-#398, #400, #402-#406): live;
  production verification missing the `npm dist-tag` operator step
  documented in `docs/releases/v0.8.1-operator-publish-note.md`.
- **ODCP daemon** (`src/daemon/*`): full triage + Jira lifecycle
  shipped, but operator UI for it lives only in the dashboard;
  shell-only operators can't yet pause / resume daemons via CLI.
- **AIdenID identity provisioning**: `src/ai/aidenid.js` shipped, but
  the email DSAR / data-deletion flow goes only through the API, not
  the CLI. Compliance-grade if exposed.

## Recommended PR sequence (after this one)

1. **`slc session search` (G7)** — ships the highest user-facing pain
   relief, no API change.
2. **Agent role enforcement (G3)** — minimal code, big trust win.
3. **`slc agent inbox` / `slc me` (G8)** — one-line surface change,
   massive UX upgrade for multi-session use.
4. **CLI-side audit log (G11)** — append-only NDJSON of every
   mutation. No external dependency.
5. **`slc session grant` (G6)** — needs an API endpoint; queue
   cross-repo PR.
6. **SSE streaming (G1)** — biggest infra change; saves polling cost
   at scale. Cross-repo.
7. **Outbound webhooks (G2)** — required for Slack / on-call
   integrations. Cross-repo.
8. **`slc session archive` wired (G5)** — closes the compliance loop.

## Standalone-product readiness checklist (what's missing for a sellable SKU)

- [ ] Per-org rate limits (G4) + per-agent quotas
- [ ] Outbound webhooks (G2) + retries
- [ ] SSE streaming (G1)
- [ ] SSO / SAML / SCIM (G10)
- [ ] Audit log + tamper-evident chain (G11)
- [ ] Session search / FTS (G7)
- [ ] Granular auth scopes per agent (G3 + G6)
- [ ] CLI-side compliance command set (DSAR export / delete / freeze)
- [ ] Public health + status page surface
- [ ] Customer-managed S3 bucket for archives (G5)
- [ ] Documented uptime SLO + incident playbook
- [ ] OpenAPI / MCP catalog of every endpoint the CLI consumes
- [ ] Self-host distribution (docker compose for the api + worker)

## What this PR ships

- **`slc session export <id>`** — full transcript + agents + tasks +
  metadata in one command. JSON (default) or NDJSON. Stdout or
  `--out <file>`. Closes the simplest compliance / context-handoff
  gap with no API change.
- **This audit** — the document you are reading. Lives at
  `docs/CLI_ENTERPRISE_AUDIT.md` so future PRs can check off items
  inline.
