# Hosted MCP Connector Contract

This document defines the target contract for a hosted SentinelLayer MCP connector. It is a design target for W2/W3/W4/W5 work, not a shipped runtime claim.

The shipped local surface is:

- `sl mcp server run` for local stdio MCP clients.
- `sl mcp registry init-session` for native Senti session tools.
- `sl mcp registry init-cli` for generated `sl.*` CLI tool schemas.

Browser-hosted Claude or ChatGPT connectors need a separate HTTPS transport, OAuth authorization, session-seat binding, approval enforcement, and isolated execution before they can safely invoke CLI-backed tools.

## Non-Goals

- Do not pass a user's long-lived local CLI token through an MCP tool call.
- Do not trust `agentId`, `sessionId`, `orgId`, `userId`, or identity claims from tool arguments.
- Do not run hosted CLI commands on the web process host.
- Do not claim Firecracker, OAuth, S3 artifact retention, or browser-hosted connector support until the gates below are implemented and tested.
- Do not let local stdio bridge metadata stand in for hosted server-side policy.

## Actors

- Human owner: the authenticated SentinelLayer account owner who controls the session.
- Agent seat: an invited agent identity bound to a specific session, role, model, and host client.
- MCP client: Claude, ChatGPT, an IDE, or another host that lists and calls tools.
- Connector service: the HTTPS MCP endpoint that authenticates users and brokers tool calls.
- Runner: the isolated process or microVM that executes allowed CLI actions.

## Required Flow

1. The human owner authenticates through hosted OAuth.
2. The connector validates token issuer, audience, expiry, subject, and resource binding.
3. The connector resolves the user-owned session seat from server-side state.
4. The MCP client lists tools. The connector includes policy metadata such as approval requirement, scopes, and disabled reasons.
5. For every tool call, the connector revalidates the user, session seat, tool policy, and approval state server-side.
6. If the call is allowed, the connector creates a short-lived runner credential scoped to that one invocation.
7. The runner executes in an isolated environment with bounded filesystem, network, time, and output.
8. The connector redacts token-like output, stores artifacts under the owner's account, and writes a durable audit receipt.

## Hosted Senti Session Tool Set

The hosted connector is a family of session tools, not one catch-all command
runner. The minimum Senti session surface is:

- Join and hydrate: create or bind the agent seat, allocate the hosted runner,
  install or verify the allowed `sentinelayer-cli@latest` package, and return
  the latest messages as structured JSON with stable cursors.
- Read history: fetch `tail`, `sinceCursor`, or full-history windows with
  monotonic cursors and view receipts recorded for the bound agent seat.
- Talk: send top-level messages, replies, comments, reactions, and explicit
  action acknowledgements under the bound agent identity.
- Coordinate: lock, unlock, list locks, and report lock conflicts without
  allowing force-unlock through hosted MCP.
- Subscribe and wake: create or update a notification subscription for the
  agent seat with server-approved cadence presets and wake triggers.
- Presence and lifecycle: renew presence, report active or idle state, and end
  the hosted runner without ending the durable web session.

The join-and-hydrate tool must return enough state for a browser or mobile MCP
client to continue safely after a reconnect: session id, agent seat id, current
cursor, recent messages, active locks, listener cadence, runner id, resolved CLI
version, package integrity metadata, and any disabled-tool reasons.

## Notification Subscription and Runner Lifecycle

Hosted Senti agents need a durable notification subscription that survives
runner teardown. The subscription belongs to the server-side session seat, not
to an individual VM process.

Minimum notification contract:

- Cadence is selected from server-defined presets or bounded intervals, for
  example active polling near one minute, slower idle polling, and an enforced
  minimum floor.
- The subscription wakes immediately on human messages, direct mentions,
  threaded replies, lock conflicts, deploy or gate notices, and explicit
  attention requests.
- Delivery is fail-closed: if the connector cannot verify the session seat,
  cursor, subscription ownership, or approval state, it returns no privileged
  messages and requires rejoin.
- Every wake event includes a reason, the triggering cursor, and a bounded
  message window so the agent can resume without guessing what changed.
- Idle detection is server-side and based on recent activity, pending work,
  locks, open approvals, and listener heartbeats.
- The connector may terminate an idle runner, but it must preserve the durable
  session seat, subscription, cursors, receipts, and pending wake reasons.
- A later wake or client call may allocate a fresh runner, reinstall or verify
  the CLI, and rehydrate from the last acknowledged cursor.
- Presence updates must distinguish live, idle, stale, and stopped states so the
  room can tell whether an agent is reachable.

Notification tools do not authorize arbitrary command execution. They only
deliver wake reasons, message windows, and lifecycle state for the already
authenticated and bound session seat.

## OAuth and Session-Seat Binding

Hosted MCP auth must be identity-from-validated-claims, never identity-from-tool-args.

Minimum server-side checks:

- `iss` matches the SentinelLayer authorization server.
- `aud` or resource binding matches the hosted MCP connector, not a generic API audience.
- `sub` resolves to the human owner or a delegated service principal.
- Token expiry, not-before, revocation, and tenant membership are valid.
- The requested session belongs to the authenticated owner or an explicit delegation grant.
- The agent seat is looked up by server state and cannot be minted by passing `agentId`.

Tool arguments can reference `sessionId` for ergonomics, but authorization must come from server-side ownership and seat records.

## Approval and Tool Policy

The connector must enforce policy before execution, even if an MCP host hides tool metadata.

Every tool record must retain:

- `security.requires_human_approval`
- `security.scopes`
- `security.kill_switch`
- runtime block reasons for tools that are intentionally unavailable

Server-side approval is mandatory for:

- Auth and token mutation.
- Config mutation.
- Session kill/admin actions.
- File writes outside the approved workspace.
- Networked scans against unapproved targets.
- Any tool marked `requires_human_approval`.

The hosted connector must deny by default when policy metadata is missing, malformed, or ambiguous.

## Runner Isolation

Hosted CLI execution must run outside the connector service process. The target runner is a per-invocation microVM or equivalent isolation boundary.

Minimum runner contract:

- Fresh workspace per invocation or explicit session-scoped workspace with cleanup.
- No inherited host environment secrets.
- Egress deny by default, with allowlists per tool.
- IMDS and link-local metadata blocked, including `169.254.169.254`.
- Read-only base image.
- Bounded CPU, memory, process count, wall time, stdout, and stderr.
- SIGTERM followed by SIGKILL finalizer on timeout.
- Snapshot reuse cannot carry user secrets across invocations.

The runner receives a scoped invocation token, not the owner's long-lived CLI token.

## Artifact Ownership

Artifacts belong to the human owner's account and session.

Required metadata:

- owner user id
- org/project id when available
- session id
- agent seat id
- tool name and version
- invocation id
- source commit or package version
- runner image digest
- start/end timestamps
- policy decision and approval id
- redaction summary

Artifact storage must be scoped so one owner cannot list or fetch another owner's outputs.

## Output Redaction

The connector must redact before returning output to the MCP client and before storing artifacts.

Redaction must cover:

- raw stdout
- raw stderr
- parsed JSON
- command echo
- error messages
- debug metadata

Token-like values, bearer tokens, API keys, private keys, OTPs, session cookies, and local auth-store paths must not be returned.

## Required Receipts

Every hosted tool call writes an audit receipt with:

- authenticated subject
- session seat
- tool name
- normalized inputs after policy filtering
- policy decision
- approval id, if required
- runner id
- artifact ids
- output redaction summary
- terminal status
- deterministic idempotency key

Receipts must be durable before the connector reports success.

## OmarGate Hosted-MCP Rules

The hosted path must be blocked by review if code introduces:

- identity-from-tool-args
- token passthrough to MCP tools
- missing OAuth audience/resource validation
- env-injected sandbox secrets
- no egress deny policy
- IMDS access from the runner
- snapshot secret reuse
- tool execution without server-side approval enforcement
- unredacted token-like stdout/stderr/JSON output

These rules are the W7 MCP-security rule pack target.

## Release Gates

A hosted connector release is not ready until all gates are green:

- OAuth/resource binding tests.
- Session-seat ownership tests.
- Approval enforcement tests for destructive tools.
- Deny-by-default tests for unknown/malformed tool policy.
- Runner no-secret-in-env test.
- Egress-deny and IMDS-block tests.
- Timeout finalizer test.
- Artifact ownership and cross-tenant denial tests.
- Output redaction tests for raw and parsed outputs.
- Durable receipt tests.
- OmarGate MCP-security pack pass.

Until then, documentation and PRs must state that only local stdio MCP and registry generation are shipped.
