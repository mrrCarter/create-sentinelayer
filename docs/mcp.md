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

Secret-bearing commands are blocked from bridge execution even when they appear in the generated registry. `sl mcp token mint` is one of those blocked commands because it returns a fresh bearer token; operators must run it directly:

```bash
sl mcp token mint --scope "sessions:read sessions:usage:read" --ttl-seconds 300 --json
```

## Hosted MCP Token Operator Flow

Use this flow when an operator needs a short-lived bearer for the hosted MCP
resource:

1. Confirm local auth with `sl auth status`.
2. Mint the shortest practical credential:

   ```bash
   sl mcp token mint --scope "sessions:read sessions:usage:read" --ttl-seconds 300 --json
   ```

3. Store the returned `accessToken` only in the target MCP host secret field or
   local shell variable. Do not paste it into Senti, tickets, PR comments, or
   durable logs.
4. Smoke the hosted resource without printing the token:

   ```bash
   curl -sS https://api.sentinelayer.com/mcp \
     -H "Authorization: Bearer $SENTINELAYER_MCP_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","id":"smoke","method":"tools/list","params":{}}'
   ```

5. For local stdio demos, skip hosted token minting entirely and point the MCP
   host at `sl mcp server run --path .`.

### Hosted Token Request And Response Schema

`sl mcp token mint` calls `POST /api/v1/auth/mcp-token` with the existing
Sentinelayer CLI API token in the `Authorization` header. The CLI does not sign,
verify, or decode MCP credentials locally.

Request body:

```json
{
  "scope": "sessions:read sessions:usage:read",
  "ttl_seconds": 300
}
```

The `scope` field is optional; callers may pass a space-separated or
comma-separated string. The `ttl_seconds` field is optional and must be a
positive integer when supplied. The server enforces the final minimum and
maximum TTL.

Successful response body:

```json
{
  "access_token": "<bearer>",
  "token_type": "Bearer",
  "expires_in": 300,
  "expires_at": "2026-04-01T00:10:00.000Z",
  "issuer": "https://api.sentinelayer.com",
  "audience": "https://mcp.sentinelayer.com",
  "scope": "sessions:read sessions:usage:read"
}
```

CLI JSON output maps `access_token` to `accessToken`. Text output intentionally
omits `accessToken`.

## Diagnosing Hosted MCP Auth (`sl mcp doctor`)

`sl mcp doctor` checks whether the hosted MCP server is correctly set up for
remote-agent (ChatGPT / Claude) OAuth authentication and reports each check as
**PASS / WARN / FAIL**. All network probes are **unauthenticated**: no bearer
token is sent and none is minted, so the diagnostic is side-effect-free. To run
it before `sl auth login`, pass `--api-url`; otherwise the command only reads
the stored CLI session to find the API base URL.

```bash
sl mcp doctor                                              # probe the API resolved from your CLI session
sl mcp doctor --api-url https://api.sentinelayer.com --json
```

The API base URL comes from `--api-url`, or is resolved read-only from the stored
CLI session (token rotation is disabled for this lookup, so the diagnostic never
mutates your credential). `--json` emits the structured result and `--timeout-ms`
bounds each probe. The command exits non-zero if any probe is `FAIL`.

The checks:

1. **Protected Resource Metadata** (RFC 9728) — `GET /.well-known/oauth-protected-resource`. Confirms the resource advertises itself and, optionally, its authorization server.
2. **Authorization Server Metadata** (RFC 8414) — `GET /.well-known/oauth-authorization-server`. Confirms the AS discovery document is published.
3. **JSON Web Key Set** — `GET /.well-known/jwks.json`. Confirms signing keys are published and are asymmetric.
4. **Enforcement** — `POST /mcp` with no token. Confirms the resource server rejects unauthenticated calls.

Verdicts worth knowing:

- **AS metadata `503` severity depends on PRM.** If PRM advertises
  `authorization_servers` but the AS metadata returns `503`, clients follow the
  advertised pointer into an unconfigured authorization server — a broken
  discovery chain → **FAIL**. If PRM omits the AS and the metadata is `503`, that
  is a consistent fail-closed state (discovery simply not wired) → **WARN**.
  Configure `MCP_OAUTH_AUTHORIZATION_ENDPOINT` + `MCP_OAUTH_TOKEN_ENDPOINT` to
  advertise it.
- **A symmetric key in the public JWKS is a hard FAIL.** A `kty: "oct"` / `HS*`
  key published at `/.well-known/jwks.json` *is* the shared HMAC signing secret;
  anyone who can read the public endpoint could forge MCP access tokens.
  Production must publish only asymmetric (e.g. RS256) public keys.
- **Unauthenticated `/mcp` returning `200` is a hard FAIL** — the resource server
  is not enforcing authentication. A correctly configured server returns `401`
  with a `WWW-Authenticate` challenge that points back at the protected-resource
  metadata.

Run `doctor` after configuring the hosted MCP OAuth environment, and again from
an operator workstation before pointing a remote agent at the server.

## Bearer Exposure Response

If a hosted MCP bearer value is pasted into a transcript, log, ticket, or tool output:

1. Treat it as exposed until it expires. The hosted API caps MCP credential lifetime server-side between 60 and 3600 seconds; prefer the shortest TTL that supports the task.
2. Stop generated CLI bridge execution for local MCP hosts, then restart the
   host process:

   ```bash
   export SENTINELAYER_MCP_CLI_BRIDGE_DISABLED=1
   # PowerShell: $env:SENTINELAYER_MCP_CLI_BRIDGE_DISABLED = "1"
   ```

3. Rotate or revoke the long-lived Sentinelayer CLI session that requested the
   bearer value with `sl auth revoke` or from the dashboard, then re-run
   `sl auth login` for a fresh session.
4. Remove the exposed value from local logs and exported transcripts where
   possible. Do not repost the bearer value into Senti.
5. Verify containment by calling the hosted `/mcp` resource with the exposed
   value after expiry/revocation and confirming it returns an auth failure. The
   expected failure is `401 AUTH_REQUIRED` or an equivalent token-expired error.
6. If bridge execution was disabled, keep it disabled until the host config and
   logs have been inspected for the leaked token.

This registry does not by itself grant browser-hosted Claude or ChatGPT execution. A hosted bridge must still enforce OAuth, session-seat binding, per-user token validation, approval policy, and sandbox/runtime controls before invoking CLI commands. See [Hosted MCP Connector Contract](./mcp-hosted-connector.md).

## Worked CLI examples

List local MCP artifacts:

```bash
sl mcp list --json
```

Create and run the local Senti stdio server:

```bash
sl mcp registry init-session --force
sl mcp server init --id sentinelayer-session --registry-file .sentinelayer/mcp/tool-registry.session-tools.json
sl mcp server run --path .
```

Generate guarded CLI bridge metadata:

```bash
sl mcp registry init-cli --json
```

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

## Architecture Decision Trail

The MCP/token design intentionally follows these decisions:

1. Local stdio runtime and hosted HTTPS MCP are separate surfaces. Local clients
   can spawn `sl mcp server run --path .`; browser-hosted clients must use an
   HTTPS service with OAuth and session-seat binding.
2. Hosted bearer minting is server-owned. `sl mcp token mint` sends an
   authenticated request to `POST /api/v1/auth/mcp-token`; the CLI never signs,
   verifies, or derives token claims locally.
3. Generated CLI bridge execution is approval-oriented and fail-closed for
   secret-bearing commands. `sl mcp token mint` is listed for operator
   discoverability but blocked from bridge execution.
4. Incident response favors containment before cleanup: disable bridge
   execution with `SENTINELAYER_MCP_CLI_BRIDGE_DISABLED=1`, restart the MCP
   host, rotate/revoke the source CLI session, then verify `/mcp` rejects the
   exposed bearer.

Architecture references: this local server doc is paired with the hosted
connector contract in [Hosted MCP Connector Contract](./mcp-hosted-connector.md),
the Senti operations guide in [Sessions](./sessions.md), and the broader
autonomous-agent control-plane requirements in
[Multi-Agent Session Spec](./MULTI_AGENT_SESSION_SPEC.md).
