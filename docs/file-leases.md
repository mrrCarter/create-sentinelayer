# Authoritative Session File Leases

SentinelLayer file leases are an API-backed edit precondition. The PostgreSQL
lease table is the authority; the session transcript and local JSON files are
not.

Acquire, renew, release, expiry, list, and guard operations never append a
`SessionEvent` and never emit `file_lock`, `file_unlock`, or
`file_lock_expired` chat events.

## Core workflow

```bash
sl session lock <session-id> src/auth --agent codex --ttl 300 --intent "auth refactor"
sl session renew <session-id> src/auth --agent codex --ttl 300
sl session guard <session-id> src/auth/login.ts --agent codex --json
sl session unlock <session-id> src/auth --agent codex --intent "done"
```

`session guard` is machine-readable and fail-closed:

- exit `0`: the API returned an authoritative allow decision;
- exit `2`: the target is unleased, held by someone else, the holder
  capability is missing/mismatched, the lease expired, or the authority was
  unavailable.

The holder capability is a client-generated 256-bit token. Only its SHA-256
digest is stored by the API. The plaintext capability is cached in
`.sentinelayer/sessions/<session-id>/file-lease-capabilities.json` with
owner-only permissions where the OS supports them. That cache is marked
`"authoritative": false`; every guard still calls the API. The old
`file-locks.json` registry is ignored.

Paths are NFC/slash normalized, case-conservatively compared, and checked as
repository-relative segments. Existing symlinks and junctions are resolved
through their nearest existing ancestor before the API call, so two aliases of
the same in-workspace file produce the same lease path. A symlink that escapes
the workspace is rejected.

## Install editor and terminal preflights

```bash
sl session guard-install <session-id> --agent codex --path .
```

The installer merges, without deleting unrelated settings:

- `.claude/settings.local.json`: a `PreToolUse` command hook for
  `Edit|Write|NotebookEdit`;
- `.vscode/tasks.json`: process tasks for guarding and renewing the current
  file;
- `.sentinelayer/hooks/file-lease-guard.sh` and
  `file-lease-guard.ps1`: direct machine-readable preflights;
- `.sentinelayer/hooks/file-lease-exec.sh` and
  `file-lease-exec.ps1`: guard a declared target immediately before spawning a
  mutation command;
- `.sentinelayer/file-lease-enforcement.json`: non-authoritative integration
  metadata and explicit security limits.

Claude's hook reads the tool JSON from stdin. A denied or unavailable guard
exits `2`, which Claude treats as a blocking `PreToolUse` error even in
permission-bypass mode. See the
[Claude hook contract](https://code.claude.com/docs/en/hooks).

Terminal guarded-exec examples:

```bash
.sentinelayer/hooks/file-lease-exec.sh src/auth/login.ts -- sed -i 's/old/new/' src/auth/login.ts

powershell -File .sentinelayer/hooks/file-lease-exec.ps1 `
  src/auth/login.ts -- node scripts/update-auth.mjs
```

The declared target must cover every path the spawned command will mutate.
For a multi-file command, acquire and guard a parent directory scope or run
separate preflights.

VS Code's generated task uses a process invocation (not shell interpolation)
and `${file}` for the current editor. A non-zero guard exit prevents dependent
tasks from running. VS Code's public `onWillSaveTextDocument` API allows
pre-save edits but does not expose a reliable save-cancellation primitive, so
the task cannot honestly claim to block every native Ctrl+S. See the
[VS Code save-event API](https://code.visualstudio.com/api/references/vscode-api#TextDocumentWillSaveEvent).

## Mutation-path coverage audit

The CLI contains several classes of filesystem mutation. Their lease coverage
is intentionally explicit:

| Mutation path | Coverage |
| --- | --- |
| `session lock`, `renew`, `unlock`, `locks`, `guard` | API authority on every call; no transcript writes |
| Claude `Edit`, `Write`, `NotebookEdit` after `guard-install` | Blocking API preflight immediately before every matched tool call |
| Terminal commands run through `file-lease-exec.*` | Blocking API preflight immediately before command spawn for the declared target |
| VS Code guard/renew tasks | Blocking for the task itself and any task that declares it as a dependency; not native-save interception |
| MCP `session_lock`, `session_unlock`, `session_locks` | API-backed lease lifecycle; the MCP host must invoke `session guard` before its separate edit tool |
| Source-edit helper `src/agents/shared-tools/file-edit.js` | Not intrinsically mediated; cover its invocation with Claude's hook or guarded-exec |
| Project generators (`init`/scaffold, `spec`, `prompt`, `guide`, scan workflow, config, MCP/plugin registry) | Not intrinsically mediated; use guarded-exec with the exact output or a leased parent scope |
| Audit/review/devtestbot/swarm/session export reports | Artifact writers, not edit authority; use guarded-exec when their output overlaps collaboratively edited paths |
| `.sentinelayer` session state, auth state, telemetry, caches, pid/cursor/log files | Internal control-plane data; deliberately exempt from project-source leases |

This is the full practical boundary, not an OS security claim. A process that
skips the generated hooks and writes through a raw shell can bypass the
preflight. Processes running as the same OS user can also read the local
capability cache or modify hook configuration. Enforcing against those actors
requires separate OS identities, containers/VMs, or a mediated filesystem.

The legacy MCP `syncRemote` and `awaitRemoteSync` inputs remain accepted for
client compatibility, but they are ignored. They cannot disable or replace API
authority.

## API contract

The authenticated session member routes are:

- `GET /api/v1/sessions/{sessionId}/file-leases`
- `POST /api/v1/sessions/{sessionId}/file-leases`
- `POST /api/v1/sessions/{sessionId}/file-leases/{leaseId}/renew`
- `POST /api/v1/sessions/{sessionId}/file-leases/{leaseId}/release`
- `POST /api/v1/sessions/{sessionId}/file-leases/guard`

Acquire, renew, release, and guard require contributor access. List requires
viewer access. Mutations bind the authenticated user, granted/scoped holder
identity, capability token, TTL, and lease id. Ancestor and descendant scopes
conflict atomically under a session-row database lock. A parent lease covers a
child edit; a child lease never authorizes a parent edit.
