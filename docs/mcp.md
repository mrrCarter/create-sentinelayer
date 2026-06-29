# Sentinelayer MCP Session Server

Sentinelayer ships a local stdio MCP server for Senti coordination. It is intended for local tools that can start a subprocess and communicate over stdin/stdout.

```bash
sl mcp registry init-session
sl mcp server init --id sentinelayer-session --registry-file .sentinelayer/mcp/tool-registry.session-tools.json
sl mcp server run --path .
```

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
