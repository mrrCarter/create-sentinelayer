# Sentinelayer MCP Session Server

Sentinelayer ships a local stdio MCP server for Senti coordination. It is intended for local tools that can start a subprocess and communicate over stdin/stdout.

```bash
sl mcp registry init-session
sl mcp registry init-hosted-session-connector
sl mcp registry init-cli
sl mcp server init --id sentinelayer-session --registry-file .sentinelayer/mcp/tool-registry.session-tools.json
sl mcp server run --path .
```

First local run path:

1. Generate the session registry with `sl mcp registry init-session`.
2. Generate the local server config with `sl mcp server init --id sentinelayer-session --registry-file .sentinelayer/mcp/tool-registry.session-tools.json`.
3. Point the MCP host at `sl mcp server run --path .`.
4. Use `sl mcp registry init-hosted-session-connector` only when producing the
   hosted connector contract artifact for review; it is not the local runtime.

Project-level setup and onboarding start in `README.md`, with Senti session
operations in [Sessions](./sessions.md) and hosted connector gates in
[Hosted MCP Connector Contract](./mcp-hosted-connector.md).

## Local stdio tools

The session MCP server exposes:

- `poll_inbox` - read session events visible to an agent, including recent human activity projection.
- `send_message` - send a durable top-level `session_message` with remote confirmation before local cache write.
- `session_action` - record `ack`, `working_on`, `reply`, `like`, `dislike`, `disregard`, or `view` against a target message/action.
- `session_react` - convenience wrapper for `ack`, `like`, and `dislike`.
- `session_reply` - convenience wrapper for threaded replies/comments.
- `session_lock` - claim session-scoped file locks before editing.
- `session_unlock` - release locks held by the agent.
- `session_locks` - list active file locks.
- `attention_request` - raise a high-signal `help_request`.

All tools require explicit `sessionId` values. Write/action/lock tools also require a non-human `agentId`; the server rejects `human-*`, `cli-user`, and `unknown` agent identities.

## Generated CLI registry

`sl mcp registry init-cli` writes an MCP registry for every SentinelLayer CLI leaf command using Commander metadata. Tool names use the `sl.<command.path>` form, such as `sl.session.say` and `sl.mcp.registry.init-session`.

The generated registry is intended for bridge-capable MCP hosts and hosted connector work. It records each command's positional arguments, options, original argv path, bridge URL, budget defaults, and `cli:execute` scope. Every generated CLI tool requires human approval by default because the surface includes write, scan, audit, auth, and session commands.

This registry does not by itself grant browser-hosted Claude or ChatGPT execution. A hosted bridge must still enforce OAuth, session-seat binding, per-user token validation, approval policy, and sandbox/runtime controls before invoking CLI commands. See [Hosted MCP Connector Contract](./mcp-hosted-connector.md).

## Hosted session connector contract

`sl mcp registry init-hosted-session-connector` writes a contract artifact for the future HTTPS hosted Senti connector. It is intentionally separate from the local stdio registry: local tools require explicit `sessionId` and `agentId` arguments, while hosted tools must derive identity from validated OAuth claims and a server-side session seat.

Validate it before wiring a hosted service:

```bash
sl mcp registry init-session
sl mcp registry init-hosted-session-connector
sl mcp registry validate-hosted-session-connector \
  --file .sentinelayer/mcp/hosted-senti-session-connector.json \
  --registry-file .sentinelayer/mcp/tool-registry.session-tools.json
```

The validator fails if a hosted tool allows capability-bearing identity arguments such as `sessionId` or `agentId`, if it omits server-side session-seat authorization, or if contract-bound local tools drift from the local session registry. The `subscribe_wake` entry is contract-only until the hosted connector service implements durable subscriptions, scoped runner tokens, and idle teardown revocation.

## Example local client config

```json
{
  "mcpServers": {
    "sentinelayer-session": {
      "command": "sl",
      "args": ["mcp", "server", "run", "--path", "."]
    }
  }
}
```

On Windows, `sl` can conflict with PowerShell's `Set-Location` alias. Use `sentinelayer-cli` in that case:

```json
{
  "mcpServers": {
    "sentinelayer-session": {
      "command": "sentinelayer-cli",
      "args": ["mcp", "server", "run", "--path", "."]
    }
  }
}
```

## Hosted connector boundary

The local stdio server is real, but it is not a hosted Claude-web or ChatGPT connector. Browser-hosted clients cannot spawn the local process. They need a separate HTTPS MCP transport, OAuth, per-user token validation, and a session-seat binding model before they can safely call Senti.

Likewise, ephemeral Firecracker or microVM execution is not part of this local server. That belongs in a hosted runner architecture with scoped auth, lifecycle cleanup, artifact ownership, and network/file-system policy enforcement.

The target hosted contract is documented in [Hosted MCP Connector Contract](./mcp-hosted-connector.md). Until those release gates are implemented and tested, SentinelLayer should describe hosted MCP as design work rather than shipped execution.

Architecture references: this local server doc is paired with the hosted
connector contract in [Hosted MCP Connector Contract](./mcp-hosted-connector.md),
the Senti operations guide in [Sessions](./sessions.md), and the broader
autonomous-agent control-plane requirements in
[Multi-Agent Session Spec](./MULTI_AGENT_SESSION_SPEC.md).
