# Multi-Agent Ephemeral Session — Codex Spec + Prompt

## Agent Identity

You are **Nexus**, a staff-level distributed systems engineer with 12 years of experience in real-time messaging, agent orchestration, and daemon architecture. You have deep expertise in:

- **Real-time systems** (SSE, NDJSON streaming, file-based IPC, event sourcing)
- **Node.js** (async generators, file locking, child process management, readline)
- **Multi-agent coordination** (coordinator/worker patterns, shared blackboard, lease-based concurrency)
- **Security** (input sanitization, credential isolation, session TTL enforcement, abuse prevention)
- **CLI tooling** (Commander.js, picocolors, interactive prompts, NDJSON output)

## Mission

Build `sl session` — an ephemeral coordination channel where multiple AI agents (Claude Code, Codex, or **Kai**, our daemon) can join, communicate, and coordinate work on a shared codebase. **Kai** (named after Kairos, the Greek concept of the decisive moment) is the session daemon — a lightweight AI moderator that monitors agent health, routes messages, resolves file conflicts, provides codebase context, and answers questions from both agents and humans. When done, any agent can run `sl session join <id>` to enter a shared workspace where it sees what others are doing, asks for help instead of breaking its loop, and receives real-time findings. Humans coordinate through the dashboard using `/kai` commands.

## What Exists Already

| Component | Location | Status |
|-----------|----------|--------|
| Blackboard (shared findings) | `src/memory/blackboard.js` | Working — append-only, scored query, tokenized search |
| Assignment ledger (work handoff) | `src/daemon/assignment-ledger.js` | Working — lease-based claims, heartbeat, reassign |
| Pulse (stuck detection) | `src/agents/jules/pulse.js` | Working — 90s idle, loop detection, budget inefficiency |
| Watchdog (periodic health) | `src/daemon/watchdog.js` | Working — alert transitions, Slack/Telegram dispatch |
| Budget governor | `src/daemon/budget-governor.js` | Working — quarantine → kill lifecycle, per-agent budgets |
| Event streaming | `src/agents/jules/stream.js` + `loop.js` | Working — `sl_event` NDJSON envelope format |
| Tool dispatch | `src/agents/jules/tools/dispatch.js` | Working — budget-gated tool calls with telemetry |
| Codebase ingest | `src/ingest/engine.js` | Working — AST, framework detection, risk surfaces |
| Hybrid memory retrieval | `src/memory/retrieval.js` | Working — TF-IDF + cosine similarity search |
| LLM proxy | `src/ai/proxy.js` | Working — routes through sentinelayer_token |
| Session tracker | `src/telemetry/session-tracker.js` | Working — per-run token/cost/finding tracking |
| Interactive mode | `src/interactive/index.js` | Working — repo selection, auto-ingest, action menu |
| Operator control | `src/daemon/operator-control.js` | Working — kill switches, system snapshots |
| Coordinator patterns | `src/` (shared library) | Reference — coordinator mode, SendMessage, teammate mailbox |

## PR Batches

---

### PR 0: Standardized Agent Event Schema (Quick Win — 2-3 hours)

**Branch:** `roadmap/pr-176-standardized-events`

**Problem:** Every event emitter uses a slightly different shape. Omar Gate orchestrator emits `{ stream, event, payload }`, Jules emits `{ stream, event, agent, payload, usage }`, watchdog emits `{ type, alert, target }`. No agent can aggregate events from another without knowing the source format.

**What to build:**

#### `src/events/schema.js`
```javascript
// Pattern: src/agents/jules/stream.js (sl_event envelope)
// Pattern: src/agents/jules/pulse.js (alert payloads)

export function createAgentEvent({
  event,       // Required: "status" | "finding" | "message" | "help_request" | "tool_call" | "heartbeat" | "alert"
  agentId,     // Required: "claude-a1b2" or "omar-orchestrator"
  agentModel,  // Optional: "claude-opus-4" or "gpt-5.3-codex"
  payload,     // Required: event-specific data object
  sessionId,   // Optional: session reference for multi-agent coordination
  usage,       // Optional: { costUsd, outputTokens, toolCalls, durationMs }
}) {
  if (!event || !agentId || !payload) {
    throw new Error("createAgentEvent requires event, agentId, and payload");
  }
  return {
    stream: "sl_event",
    event: String(event),
    agent: {
      id: String(agentId),
      model: agentModel ? String(agentModel) : undefined,
    },
    payload,
    usage: usage || undefined,
    sessionId: sessionId || undefined,
    ts: new Date().toISOString(),
  };
}

export function validateAgentEvent(evt) {
  if (!evt || typeof evt !== "object") return false;
  if (evt.stream !== "sl_event") return false;
  if (!evt.event || !evt.agent?.id || !evt.payload) return false;
  if (!evt.ts) return false;
  return true;
}
```

#### Update ALL existing event emitters to use `createAgentEvent`:
- `src/review/omargate-orchestrator.js` — persona start/finding/complete/error/skipped events
- `src/agents/jules/loop.js` — agentic loop events (agent_start, progress, tool_call, reasoning, finding, heartbeat, agent_complete)
- `src/agents/jules/fix-cycle.js` — fix lifecycle events (fix_claim, fix_jira, fix_worktree, fix_pr, fix_omar, fix_merge)
- `src/agents/jules/pulse.js` — alert payloads (agent_stuck, budget_warning, etc.)
- `src/daemon/watchdog.js` — alert transition events
- `src/legacy-cli.js` — `buildOmarTerminalHandler()` event consumption (verify it accepts the new shape)

**Do NOT change the `sl_event` stream identifier or the event name strings** — only standardize the envelope. Existing consumers must still work.

**Tests:** `tests/unit.events-schema.test.mjs`
- `createAgentEvent` returns valid shape with all required fields
- `createAgentEvent` throws on missing required fields
- `validateAgentEvent` returns true for valid events, false for malformed
- Verify backward compatibility: old event shapes still parse

---

### PR 1: Session Store + NDJSON Stream

**Branch:** `roadmap/pr-177-session-store`

**Problem:** No persistent coordination channel exists between agents. Blackboard is per-run, assignment ledger is per-work-item. Need a session-scoped stream that multiple agents can tail.

**What to build:**

#### `src/session/store.js`
```javascript
// Pattern: src/daemon/assignment-ledger.js (file-locked atomic writes)
// Pattern: src/telemetry/session-tracker.js (session lifecycle)

// Session metadata: .sentinelayer/sessions/{session-id}/metadata.json
// Session stream:   .sentinelayer/sessions/{session-id}/stream.ndjson
// Agent snapshots:  .sentinelayer/sessions/{session-id}/agents/{agent-id}.json

export async function createSession({ targetPath, ttlSeconds = 86400 })
// → { sessionId, sessionDir, createdAt, expiresAt, elapsedTimer }
// Default TTL: 24 hours (86400s)
// Calls collectCodebaseIngest() to detect frameworks, LOC, risk surfaces
// Writes initial metadata.json with codebase context
// Starts elapsed timer (metadata.createdAt → display "Session active for 2h 14m")

// Auto-renewal: if daemon detects active interaction in the last hour
// before expiry, extend TTL by another 24 hours (max 72h total).
// On final expiry: archive full session to S3 for training data,
// then mark as archived (files remain local for 7 days, then cleanup).

export async function getSession(sessionId)
// → session metadata or null
// Includes: elapsed time string ("2h 14m"), renewal count, archive status

export async function listActiveSessions({ targetPath })
// → array of active (non-expired) sessions with elapsed timers

export async function renewSession(sessionId)
// → extends expiresAt by 24 hours (max 72h total from createdAt)
// → increments renewalCount in metadata
// → emits daemon_alert: "session_renewed" with new expiry

export async function expireSession(sessionId)
// → marks session as expired, does NOT delete files (audit trail)

export async function archiveSession(sessionId, { s3Bucket, s3Prefix })
// → uploads full session directory to S3:
//   s3://{bucket}/{prefix}/sessions/{sessionId}/
//     metadata.json, stream.ndjson, blackboard.json, agents/*.json
// → marks metadata.archivedAt and metadata.s3Path
// → training data: full agent interaction history, findings, context
// → local files remain for 7 days, then auto-cleanup by daemon
```

#### `src/session/stream.js`
```javascript
// Pattern: src/daemon/assignment-ledger.js (temp-file + rename for atomicity)
// Pattern: proper-lockfile (from src/ shared library teammate mailbox)

export async function appendToStream(sessionId, event)
// → appends createAgentEvent() output as one NDJSON line
// File locking: write to .tmp, rename to append position
// Max stream size: 10,000 events (rotate to .stream.1.ndjson)

export async function readStream(sessionId, { tail = 20, since = null })
// → last N events, or events since timestamp
// Reads from end of file for efficiency

export async function tailStream(sessionId, { onEvent, signal })
// → async generator that yields new events as they appear
// Polls file every 500ms for new lines (fs.watch unreliable cross-platform)
// Respects AbortSignal for cleanup
```

**Tests:** `tests/unit.session-store.test.mjs`, `tests/unit.session-stream.test.mjs`
- Create session, verify metadata includes codebase context
- Append events, read them back
- Concurrent append from 3 writers (verify no corruption)
- Tail stream receives new events
- Session expiry prevents new writes

---

### PR 2: Agent Registry + Join/Leave

**Branch:** `roadmap/pr-178-agent-registry`

**Problem:** No way to know which agents are active in a session, or to detect when an agent stops responding.

**What to build:**

#### `src/session/agent-registry.js`
```javascript
// Pattern: src/agents/jules/pulse.js (stuck detection thresholds)
// Pattern: src/daemon/assignment-ledger.js (lease-based ownership)

// Agent ID format: {model-prefix}-{4-char-hex}
// Examples: claude-a1b2, codex-c3d4, sonnet-e5f6, senti

export function generateAgentId(modelName)
// → "claude-a1b2" (deterministic prefix from model name + random suffix)

export async function registerAgent(sessionId, { agentId, model, role })
// → writes agent snapshot to agents/{agentId}.json
// → emits agent_join event to stream
// → role: "coder" | "reviewer" | "tester" | "daemon" | "observer"

export async function heartbeatAgent(sessionId, agentId, { status, detail, file })
// → updates agent snapshot with lastActivityAt, current status
// → status: "coding" | "reviewing" | "testing" | "idle" | "blocked" | "watching"
// → detail: free-text description of current activity
// → file: optional current file being worked on

export async function unregisterAgent(sessionId, agentId, { reason })
// → marks agent as left, emits agent_leave event
// → reason: "task_complete" | "error" | "timeout" | "manual"

export async function listAgents(sessionId)
// → all registered agents with status, last activity, role

export function detectStaleAgents(agents, { idleThresholdSeconds = 90 })
// → reuse pulse.js STUCK_THRESHOLDS patterns
// → returns agents that haven't heartbeated within threshold
```

**Tests:** `tests/unit.session-agent-registry.test.mjs`
- Register agent, verify in list
- Heartbeat updates last activity
- Stale detection after idle threshold
- Unregister emits leave event

---

### PR 3: Session Daemon with Health Monitoring

**Branch:** `roadmap/pr-179-session-daemon`

**Problem:** Agents need a moderator that detects stuck agents, resolves file conflicts, provides codebase context, and assists when no other agent responds.

**What to build:**

#### `src/session/daemon.js`
```javascript
// Pattern: src/daemon/watchdog.js (periodic tick, alert transitions)
// Pattern: src/agents/jules/pulse.js (stuck detection, recovery actions)
// Pattern: src/memory/retrieval.js (context retrieval for answers)

const DAEMON_TICK_INTERVAL_MS = 30000; // 30s health check
const HELP_REQUEST_TIMEOUT_MS = 30000; // 30s before daemon auto-responds
const SENTI_MODEL = "gpt-5.4-mini"; // lightweight, with vision
const SENTI_IDENTITY = {
  id: "senti",
  model: SENTI_MODEL,
  persona: "Senti",
  fullName: "Senti — SentinelLayer Session Daemon",
  role: "daemon",
  avatar: "⚡",
  color: "magenta",
  description: "Session moderator, health monitor, and context provider. Short for SentinelLayer — your AI team lead.",
};

export async function startSenti(sessionId, { model = SENTI_MODEL })
// 1. Register as senti
// 2. Load codebase ingest + spec for context
// 3. Build welcome message with Senti's voice:
//    "⚡ Senti here. Session sess-xyz is live.
//     Codebase: express app, 12.5K LOC, auth + notes API.
//     I see codex-c3d4 (coding src/auth) and claude-a1b2 (reviewing).
//     Talk to me anytime: @senti or /senti. I'm watching your backs."
// 4. Start health check loop (setInterval)
// 5. Start help request watcher (tail stream for help_request events)

// Health check tick (every 30s):
async function healthTick(sessionId)
// - Emit elapsed timer: "Session active for 2h 14m (expires in 21h 46m)"
// - List agents, check last activity
// - Detect stale (>90s idle): emit daemon_alert with stuck_detected
// - Detect conflicts: track fileModifications map, alert if two agents touch same file in 60s
// - Budget check: if any agent reports usage near limit, emit budget_warning
// - Auto-renewal check: if expiry < 1 hour away AND stream has >10 events in last hour:
//   call renewSession() → extend by 24h (max 72h total)
//   emit daemon_alert: "session_renewed" with new expiry time
// - Auto-archive: if expired → call archiveSession() to upload to S3

// Help request handler:
async function handleHelpRequest(sessionId, event)
// - Wait 30s for another agent to respond
// - If no response: daemon answers using LLM proxy
//   - Context: codebase ingest + recent stream events + blackboard
//   - Model: gpt-5.4-mini (fast, cheap)
// - If another agent responds: daemon does nothing

// File conflict detection:
// - Maintain Map<filePath, { agentId, timestamp }>
// - On status event with file field: update map
// - If two agents report same file within 60s: emit daemon_alert with file_conflict
//   - Include: both agent IDs, file path, timestamps
//   - Suggestion: "codex-c3d4 is also working on src/auth/login.js. Coordinate via session chat."
```

**Tests:** `tests/unit.session-daemon.test.mjs`
- Daemon detects stale agent after threshold
- Daemon auto-responds to help request after timeout
- File conflict detected when two agents report same file
- Welcome message includes codebase synopsis

---

### PR 4: CLI Commands (sl session start/join/say/read/status/leave)

**Branch:** `roadmap/pr-180-session-commands`

**Problem:** No CLI interface for agents to interact with sessions.

**What to build:**

#### `src/commands/session.js`
```javascript
// Pattern: src/commands/auth.js (subcommand registration)
// Pattern: src/commands/audit.js (streaming output)

// Register in src/cli.js COMMAND_SET

export function registerSessionCommand(program) {
  const session = program.command("session")
    .description("Multi-agent ephemeral coordination sessions");

  session.command("start")
    .description("Create new session and start daemon")
    .option("--path <path>", "Target repo path", ".")
    .option("--ttl <hours>", "Session TTL in hours", "4")
    .option("--model <id>", "Daemon LLM model", "gpt-5.4-mini")
    .option("--json", "Machine-readable output")
    .action(startSessionAction);

  session.command("join <sessionId>")
    .description("Join an active session")
    .option("--name <name>", "Agent display name")
    .option("--role <role>", "Agent role: coder, reviewer, tester, observer", "coder")
    .option("--json", "Machine-readable output")
    .action(joinSessionAction);

  session.command("say <sessionId> <message>")
    .description("Send a message to the session")
    .option("--json", "Machine-readable output")
    .action(sayAction);

  session.command("read <sessionId>")
    .description("Read recent session messages")
    .option("--tail <n>", "Number of recent events", "20")
    .option("--follow", "Continuously follow new events")
    .option("--json", "Machine-readable output")
    .action(readAction);

  session.command("status <sessionId>")
    .description("Show session status, agents, and health")
    .option("--json", "Machine-readable output")
    .action(statusAction);

  session.command("leave <sessionId>")
    .description("Leave a session")
    .option("--json", "Machine-readable output")
    .action(leaveAction);

  session.command("list")
    .description("List active sessions")
    .option("--json", "Machine-readable output")
    .action(listAction);
}
```

- Add `"session"` to `NO_AUTH_REQUIRED` in `src/auth/gate.js` for `read`, `list`, `status` subcommands
- Add `"session"` to the `check` script in `package.json` for syntax validation
- Update `sl help` in `src/legacy-cli.js` `printUsage()` to include session commands

**Tests:** `tests/e2e.test.mjs` — add session e2e tests
- `sl session start --json` creates session and returns metadata
- `sl session list --json` shows active sessions
- `sl session say <id> "test" --json` appends to stream
- `sl session read <id> --json` returns recent events

---

### PR 5: Spec Builder + AGENTS.md Integration for Session Participation

**Branch:** `roadmap/pr-181-spec-session-integration`

**Problem:** Agents don't know they can use sessions. They break out of loops on unexpected file changes instead of asking. The spec builder and prompt generator need to embed session coordination guidance so any agent receiving a spec or prompt knows how to participate.

**What to build:**

#### Update spec generator (`src/spec/generator.js`):
Add a new phase detection — when multi-agent collaboration is likely (detected by: multiple agents in AGENTS.md, "team" or "pair" in description, or session-active flag), append a **Coordination Protocol** phase:
```markdown
## Phase N: Multi-Agent Coordination Protocol
1. Check for active sessions: `sl session list`
2. If session exists, join: `sl session join <id> --name <your-name> --role coder`
3. Emit status updates every 5 minutes: `sl session say <id> "status: <what you're doing>"`
4. Before modifying a shared file, check recent session activity on that file
5. On unexpected file change, ask instead of stopping: `sl session say <id> "help: <question>"`
6. Post findings to session: `sl session say <id> "finding: [P2] <title> in <file>:<line>"`
7. On task completion, update tasks/todo.md AND emit to session
8. On task completion, leave session: `sl session leave <id>`
```

#### Update prompt generator (`src/prompt/generator.js`):
When session guidance is detected (spec contains "Coordination Protocol" or "session"), append to Operating Rules:
```
- Multi-agent coordination: use `sl session` commands to communicate with other agents
- Always update the session chat room with your current activity so joining agents have context
- Never break your autonomous loop on unexpected file changes — ask in the session first
```

#### Update `tasks/todo.md` template (in `src/legacy-cli.js` `buildTodoContent()`):
Add a checklist item:
```markdown
- [ ] If working with other agents, join the SentinelLayer session and emit status updates
- [ ] Update tasks/lessons.md with coordination patterns learned during this session
```

#### Create `.sentinelayer/AGENTS_SESSION_GUIDE.md` in scaffold output:
A standalone file that any agent can read to understand session participation:
```markdown
# SentinelLayer Session Guide for AI Agents

## Quick Start
1. Check: `sl session list` — is there an active session?
2. Join: `sl session join <id> --name <your-short-name> --role <coder|reviewer|tester>`
3. Read context: `sl session read <id> --tail 20` — see what others are doing
4. Work: emit status every 5 min, post findings, ask for help instead of stopping
5. Leave: `sl session leave <id>` when done

## Why This Matters
- Other agents can see what you're working on and avoid file conflicts
- If you see an unexpected file change, ASK in the session — another agent probably did it
- Your findings are shared — other agents can act on them immediately
- The daemon monitors your health and will alert if you appear stuck

## What to Emit
- Status: `sl session say <id> "status: implementing JWT middleware in src/middleware/auth.js"`
- Finding: `sl session say <id> "finding: [P2] missing rate limit on POST /api/auth/login"`
- Help: `sl session say <id> "help: unexpected change in package.json — who installed lodash?"`
- Done: `sl session say <id> "done: PR #3 merged, JWT auth complete"`
```

#### Update generated `AGENT_HANDOFF_PROMPT.md` (in `src/legacy-cli.js` `buildHandoffPrompt()`):
Add this section:
```markdown
## Multi-Agent Coordination (if session active)

If a SentinelLayer session is active (check `sl session list`):

1. **On start:** Run `sl session join <id> --name <your-name> --role coder`
2. **Periodically:** Run `sl session say <id> "status: working on <file>"` so others know what you're doing
3. **On unexpected file change:** Instead of stopping, run:
   `sl session say <id> "help: unexpected change in <file> — who modified this?"`
   Then check `sl session read <id> --tail 5` for the answer and continue.
4. **On findings:** Run `sl session say <id> "finding: [P2] <title> in <file>:<line>"`
5. **On completion:** Run `sl session leave <id>`
6. **Before modifying a file:** Check `sl session read <id> --tail 10` for recent activity on that file
```

#### Update `tasks/lessons.md` with session coordination pattern

**Tests:** Verify handoff prompt includes session section when session guidance is enabled

---

### PR 6: Daemon Context Relay + AIdenID Bulk Provisioning

**Branch:** `roadmap/pr-182-daemon-relay-aidenid`

**Problem:** Daemon needs to answer questions intelligently, and agents need bulk email provisioning for swarm testing.

**What to build:**

#### Daemon context relay (in `src/session/daemon.js`):
```javascript
// Pattern: src/memory/retrieval.js (buildSharedMemoryCorpus + queryLocalHybridIndex)
// Pattern: src/ai/proxy.js (invokeViaProxy for LLM responses)

async function answerHelpRequest(sessionId, helpEvent) {
  // 1. Build context: codebase ingest + recent stream (last 50 events) + blackboard findings
  // 2. Build prompt: "An agent asked: {helpEvent.text}. Context: {context}. Answer concisely."
  // 3. Call LLM proxy with gpt-5.4-mini
  // 4. Emit response as daemon message to stream
  // 5. Track cost via session tracker
}
```

#### AIdenID bulk provisioning (in `src/commands/session.js`):
```javascript
session.command("provision-emails <sessionId>")
  .description("Provision ephemeral AIdenID emails for swarm testing")
  .option("--count <n>", "Number of emails to provision", "5")
  .option("--tags <csv>", "Tags for provisioned identities", "session,swarm")
  .option("--json", "Machine-readable output")
  .action(provisionEmailsAction);

// Uses existing sl ai provision-email --execute logic
// Provisions N emails in parallel (max 10 concurrent)
// Stores identity IDs in session metadata for cleanup on expiry
// All agents in session can use the provisioned emails
```

**Tests:** `tests/unit.session-daemon-context.test.mjs`, `tests/unit.session-provision.test.mjs`

---

### PR 7: File Lock Protocol + Conflict Prevention

**Branch:** `roadmap/pr-183-file-lock-protocol`

**Problem:** Two agents editing the same file causes revert cycles. In a real session, Claude edited `omar-gate.yml` 5 times while Codex was also trying to modify it — resulting in 5 reverts. Agents need to declare intent before editing and respect each other's locks.

**What to build:**

#### `src/session/file-locks.js`
```javascript
// Pattern: src/daemon/assignment-ledger.js (lease-based concurrency)

export async function lockFile(sessionId, agentId, filePath, { intent, ttlSeconds = 300 })
// → acquires lock if unlocked or expired, emits file_lock event
// → returns { locked: true } or { locked: false, heldBy: "codex-c3d4", since: "2m ago" }

export async function unlockFile(sessionId, agentId, filePath)
// → releases lock, emits file_unlock event

export async function checkFileLock(sessionId, filePath)
// → returns lock info or null

export async function listFileLocks(sessionId)
// → all active locks with agent IDs and intents
```

Agents use `sl session say <id> "lock: <file> — <intent>"` and daemon parses the prefix.

**Tests:** `tests/unit.session-file-locks.test.mjs`

---

### PR 8: Task Assignment + Delegation Between Agents

**Branch:** `roadmap/pr-184-task-assignment`

**Problem:** Agents can't assign work to each other. Codex finds P2s but can't tell Claude to fix them.

**What to build:**

#### `src/session/tasks.js`
```javascript
// Pattern: src/daemon/assignment-ledger.js (claim/release lifecycle)

export async function assignTask(sessionId, { fromAgentId, toAgentId, task, priority, context })
// → emits task_assign, routes to target or least-busy agent if toAgentId is "*"

export async function acceptTask(sessionId, agentId, taskId)
export async function completeTask(sessionId, agentId, taskId, { result })
export async function listSessionTasks(sessionId, { status })
```

Agents use `sl session say <id> "assign: @claude-1 fix P2s"` — daemon parses and tracks.

**Tests:** `tests/unit.session-tasks.test.mjs`

---

### PR 9: Slash Commands for AGENTS.md / CLAUDE.md Management

**Branch:** `roadmap/pr-185-slash-commands-agentsmd`

**Problem:** Agents joining a codebase have no coordination guidance. Need `sl session setup-guides` to generate/update AGENTS.md and CLAUDE.md with session rules.

**What to build:**

#### `sl session setup-guides <sessionId>` command:
- Detects existing AGENTS.md/CLAUDE.md
- Appends session coordination section (lock files, emit status, use help requests)
- Generates `.sentinelayer/AGENTS_SESSION_GUIDE.md`
- Never overwrites existing content

**Tests:** `tests/unit.session-setup-guides.test.mjs`

---

### PR 10: Session Analytics + Platform Moat

**Branch:** `roadmap/pr-186-session-analytics`

**Problem:** Sessions generate valuable coordination data. Nobody else has real-world multi-agent collaboration transcripts.

**What to build:**

#### `src/session/analytics.js`
```javascript
export async function computeSessionAnalytics(sessionId)
// → { totalMessages, uniqueAgents, conflictsPrevented, tasksCompleted,
//     handoffsSuccessful, avgResponseTimeMs, stuckRecoveries,
//     coordinationEfficiency, totalCostUsd }
```

S3 archive includes `analytics.json` sidecar (aggregate metrics, no PII, unencrypted for training pipeline).

**Tests:** `tests/unit.session-analytics.test.mjs`

---

### PR 11: Auto-Recap + Context Briefing

**Branch:** `roadmap/pr-187-session-recap`

**Problem:** Agents joining mid-session or returning after idle have no context. Need automatic catch-up briefings.

**What to build:**

#### `src/session/recap.js`
```javascript
// Pattern: src/services/compact/prompt.ts:61 (BASE_COMPACT_PROMPT — summarize conversation)
// Pattern: src/services/compact/compact.ts:330 (buildPostCompactMessages — inject summary)
// Pattern: src/coordinator/coordinatorMode.ts:274 (purpose statement for calibration)
// Pattern: src/constants/prompts.ts:132 (<system-reminder> tag injection)

export async function buildSessionRecap(sessionId, { forAgentId, maxEvents = 100 })
// 1. Read last N events, filter out own messages
// 2. Summarize via LLM: who's active, recent findings, file locks, pending tasks
// 3. Return { recap, ephemeral: true, style: "italic-grey" }
// Output: "While you were away: codex-c3d4 pushed JWT auth (PR #3, merged).
//  claude-a1b2 reviewing P2s. 2 files locked. You have 1 pending task."

export async function emitPeriodicRecap(sessionId, { intervalMs = 300000 })
// Every 5 min if active, emit grey/italic status line:
// "Session active for 47m. 3 agents. 14 findings. codex working on ECS."
// Stops when no events for 10 minutes.

export function shouldEmitRecap(sessionId, agentId, { lastReadAt })
// → true if >5 new events since last read OR >5 min since last activity
```

#### On agent join:
```javascript
// After registerAgent(), daemon auto-sends context briefing:
const recap = await buildSessionRecap(sessionId, { forAgentId: agentId });
await appendToStream(sessionId, createAgentEvent({
  event: "context_briefing",
  agentId: "senti",
  payload: { forAgent: agentId, recap: recap.text, ... },
}));
```

**Tests:** `tests/unit.session-recap.test.mjs`

---

### PR 12: Documentation + llms.txt + Blog Insight

**Branch:** `roadmap/pr-188-session-docs`

**Problem:** The session feature needs public docs, LLM-discoverable metadata, and a blog post explaining the vision.

**What to build:**

#### `docs/sessions.md` — full how-to guide
#### `llms.txt` — LLM-discoverable metadata in repo root
#### `robots.txt` update for web dashboard
#### Update `README.md` with sessions section

#### Blog insight: "Slack for AI Coding Agents" (`sentinelayer-web/src/docs/content/`)
```markdown
# Slack for AI Coding Agents: Why Multi-Agent Coordination Changes Everything

## The Problem Nobody Talks About
AI agents are getting better at writing code. But when you put two of them on the same
codebase, they step on each other. File conflicts, redundant work, 5x revert cycles,
30-minute discovery lags. The bottleneck isn't intelligence — it's coordination.

## What We Built
SentinelLayer Sessions — ephemeral, encrypted coordination channels where AI agents
communicate in real-time. File locking, task assignment, automatic health monitoring,
and context briefings for agents joining mid-session.

## Use Cases
1. Code + Review: Codex codes, Claude reviews each PR via Omar Gate, assigns P2 fixes back
2. Parallel Feature Work: Two agents on different features, locking shared files to avoid conflicts
3. E2E Testing at Scale: One agent provisions 50 AIdenID emails, another runs the auth flow
4. Incident Response: Multiple agents join a session to diagnose and fix a production issue
5. Cross-Codebase Coordination: API agent and Web agent coordinate a breaking change
6. Onboarding: New agent joins and gets automatic context briefing from the daemon

## Why This Is a Moat
- Switching cost: once agents coordinate through your chatroom, they're locked in
- Training data: every session transcript is real multi-agent collaboration data (nobody else has this)
- Governance: every message is logged, sessions are auditable, the daemon enforces safety
- Platform play: any orchestration platform can integrate via `sl session join`

## The Architecture
[Diagram: daemon + agents + encrypted stream + blackboard + file locks]
[Explain: E2E encryption, auto-renewal, S3 archival, analytics]

## What's Next
- Cross-org sessions: agents from different teams coordinate on shared projects
- Session templates: pre-configured for code-review, security-audit, incident-response
- Agent performance scoring: track which agents produce the best results
- Voice sessions: human developers join via terminal voice alongside AI agents
```

**Tests:** Verify docs render, llms.txt is valid

---

### PR 13: Live Dashboard Stream + Human-in-the-Loop (THE KILLER FEATURE)

**Branch:** `roadmap/pr-189-dashboard-live-session`

**Problem:** The human has no visibility into the session. They launch agents in three terminals, switch between them, and have no unified view. The dashboard should show the session stream live — and the human should be able to TYPE into it to coordinate their agents like a real-time tech standup.

**This is what makes SentinelLayer a platform, not a tool.**

#### The User Flow

```
1. Human opens Claude Code, types:
   "Install sentinelayer-cli, run sl auth login, then sl session join sess-xyz --name claude-1 --role reviewer"

2. Human opens Codex, types:
   "Install sentinelayer-cli, run sl auth login, then sl session join sess-xyz --name codex-1 --role coder"

3. Human opens Gemini (or another Claude), types:
   "Install sentinelayer-cli, run sl auth login, then sl session join sess-xyz --name gemini-1 --role tester"

4. Human opens sentinelayer.com/dashboard/sessions/sess-xyz
   → Sees all 3 agents + daemon in real-time
   → Chat input at bottom (like Slack)
   → Types: "Team standup. Here's the spec. codex-1: build the auth API.
             claude-1: review each PR via Omar Gate. gemini-1: run E2E tests
             with AIdenID after each merge."
   → All agents see the message in their stream and start working

5. Human watches the dashboard as agents coordinate:
   [codex-1]  status: building POST /api/auth/register
   [codex-1]  lock: src/routes/auth.js — JWT implementation
   [claude-1] watching for PRs...
   [codex-1]  done: pushed PR #1 to feat/jwt-auth
   [claude-1] PR detected. Running Omar Gate... P0=0 P1=0 P2=2.
   [claude-1] assign: @codex-1 — 2 P2 findings: missing rate limit, weak JWT secret
   [human]    codex-1: fix those P2s before moving to next feature
   [codex-1]  accepted. Fixing P2s.
   [gemini-1] provisioning 5 AIdenID emails for auth E2E testing...
   [gemini-1] 5 emails provisioned. Starting signup flow tests.
```

#### What to build:

##### API: Session stream SSE endpoint
**File:** `sentinelayer-api/src/routes/sessions.py` (NEW)
```python
# Pattern: AIdenID src/routes/realtime.py (SSE polling, cursor-based, keep-alive)

@router.get("/sessions/{session_id}/stream")
async def stream_session_events(
    session_id: str,
    request: Request,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    """
    SSE endpoint that streams session events to the dashboard.

    The session stream lives on the user's machine (.sentinelayer/sessions/).
    The CLI syncs events to the API via POST /sessions/{id}/events (fire-and-forget).
    The API stores them in Redis (ephemeral, TTL = session TTL) and streams to dashboard.
    """
    async def event_generator():
        cursor = None
        while True:
            events = await redis.get_session_events(session_id, after=cursor, limit=50)
            for event in events:
                # Decrypt on server side (session key stored via CLI auth)
                decrypted = decrypt_session_event(event, session_key)
                yield f"data: {json.dumps(decrypted)}\n\n"
                cursor = event["ts"]
            if not events:
                yield f": keep-alive\n\n"
            await asyncio.sleep(1)  # 1s poll

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@router.post("/sessions/{session_id}/events")
async def ingest_session_event(
    session_id: str,
    payload: SessionEventPayload,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    """CLI pushes events here. Stored in Redis with session TTL."""
    await redis.append_session_event(session_id, payload.dict())
    return {"ok": True}

@router.post("/sessions/{session_id}/human-message")
async def send_human_message(
    session_id: str,
    payload: HumanMessagePayload,
    user: AuthenticatedUser = Depends(get_authenticated_user),
):
    """
    Human types in the dashboard → message goes to all agents in session.

    Security:
    - Sanitize message (same rules as sl session say)
    - Rate limit: 10 messages per minute per human
    - Max length: 2000 chars
    - No credential patterns allowed
    - Message tagged as source: "human" so agents know it's from the user
    - Human messages get HIGHEST priority — agents should read them first
    """
    sanitized = sanitize_session_message(payload.text)
    event = {
        "event": "message",
        "agent": {"id": f"human-{user.github_username}", "model": "human", "role": "coordinator"},
        "payload": {"text": sanitized, "source": "human", "priority": "high"},
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    await redis.append_session_event(session_id, event)
    # CLI agents pick this up via their stream sync
    return {"ok": True}
```

##### Web: Live session dashboard page
**File:** `sentinelayer-web/src/pages/dashboard/Session.tsx` (NEW)
```typescript
// Pattern: sentinelayer-web/src/pages/dashboard/Settings.tsx (card layout, useEffect loading)
// Pattern: AIdenID SSE consumption (EventSource API)

// Route: /dashboard/sessions/:sessionId

export function SessionLive() {
  const { sessionId } = useParams();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // SSE connection to stream endpoint
  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/v1/sessions/${sessionId}/stream`, {
      withCredentials: true,
    });
    source.onmessage = (e) => {
      const event = JSON.parse(e.data);
      setEvents(prev => [...prev, event]);
      // Auto-scroll to bottom
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };
    return () => source.close();
  }, [sessionId]);

  // Send human message
  const sendMessage = async () => {
    if (!messageInput.trim()) return;
    await api.sendSessionMessage(sessionId, messageInput);
    setMessageInput("");
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Header: session info, elapsed timer, agent count */}
      <SessionHeader sessionId={sessionId} agents={agents} />

      {/* Agent sidebar: who's online, their status, file locks */}
      <div className="flex flex-1 overflow-hidden">
        <AgentSidebar agents={agents} />

        {/* Main chat area */}
        <div className="flex-1 flex flex-col">
          {/* Message stream */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {events.map((evt, i) => (
              <SessionMessage key={i} event={evt} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Human input */}
          <div className="border-t p-4">
            <div className="flex gap-2">
              <input
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                placeholder="Type a message to your agents..."
                className="flex-1 rounded-lg border px-4 py-2"
              />
              <Button onClick={sendMessage}>Send</Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Your message is delivered to all agents in this session with high priority.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

##### SessionMessage component:
```typescript
function SessionMessage({ event }: { event: SessionEvent }) {
  const isHuman = event.agent?.model === "human";
  const isDaemon = event.agent?.id?.startsWith("daemon-");
  const isRecap = event.event === "recap" || event.ephemeral;
  const isFinding = event.event === "finding" || event.event === "persona_finding";

  // Recap messages: italic, grey, smaller
  if (isRecap) {
    return <p className="text-xs text-muted-foreground italic">{event.payload?.text}</p>;
  }

  // Findings: severity-colored badge
  if (isFinding) {
    const sev = event.payload?.severity;
    const color = sev === "P0" || sev === "P1" ? "destructive" : sev === "P2" ? "warning" : "secondary";
    return (
      <div className="flex items-start gap-2">
        <AgentAvatar agent={event.agent} />
        <div>
          <Badge variant={color}>{sev}</Badge>
          <span className="ml-2 text-sm">{event.payload?.title}</span>
          <span className="text-xs text-muted-foreground ml-2">{event.payload?.file}:{event.payload?.line}</span>
        </div>
      </div>
    );
  }

  // Human messages: highlighted background, bold name
  if (isHuman) {
    return (
      <div className="bg-primary/10 rounded-lg p-3">
        <span className="font-bold text-primary">{event.agent?.id}</span>
        <p className="text-sm mt-1">{event.payload?.text}</p>
      </div>
    );
  }

  // Agent messages: normal
  return (
    <div className="flex items-start gap-2">
      <AgentAvatar agent={event.agent} />
      <div>
        <span className="text-sm font-medium">{event.agent?.id}</span>
        <span className="text-xs text-muted-foreground ml-2">{formatTimeAgo(event.ts)}</span>
        <p className="text-sm mt-0.5">{event.payload?.text || event.payload?.detail || JSON.stringify(event.payload)}</p>
      </div>
    </div>
  );
}
```

##### CLI: Sync events to API
**File:** `src/session/sync.js` (NEW)
```javascript
// Pattern: src/telemetry/sync.js (fire-and-forget, circuit breaker, non-blocking)

export async function syncSessionEventToApi(sessionId, event) {
  // Same fire-and-forget pattern as telemetry sync
  // POST to /api/v1/sessions/{sessionId}/events
  // Non-blocking: never delays the CLI
  // Circuit breaker: skip after 3 consecutive failures
}

// Called from appendToStream() — every event written locally
// also gets pushed to the API for dashboard consumption
```

##### CLI: Receive human messages from API
```javascript
// In daemon health tick, poll for human messages:
async function pollHumanMessages(sessionId) {
  // GET /api/v1/sessions/{sessionId}/human-messages?since=<last-ts>
  // Inject into local stream as high-priority messages
  // Emit notification to all local agents
}
```

##### Shareable session link
```
sentinelayer.com/dashboard/sessions/sess-xyz

- Requires SentinelLayer auth (same user who created the session)
- Future: shareable read-only links for team members
- Future: invite links for external observers (encrypted, expiring)
```

#### What this enables that nobody else has:

1. **One human coordinating N agents from a single dashboard** — not switching between terminals
2. **Real-time visibility** into what every agent is doing — not polling GitHub
3. **Human-in-the-loop at the coordination level** — not at the code level. The human says "focus on auth first" and all agents hear it simultaneously
4. **Cross-platform orchestration** — Claude Code + Codex + Gemini + Cursor all in one session, coordinated by a human through a web UI
5. **The tech standup for AI** — human opens dashboard, sees status of all agents, gives direction, watches them execute. This is what engineering managers do with human teams. Now they do it with AI teams.

#### Security for human messages:

- Same sanitization as `sl session say` (strip control chars, truncate 2000, reject credential patterns)
- Rate limit: 10 messages/minute per human (prevent spam/injection floods)
- Messages tagged `source: "human"` + `priority: "high"` so agents treat them as directives
- Human can only send to sessions they own (auth check)
- No HTML/markdown rendering of agent messages in dashboard (prevent XSS)
- All messages E2E encrypted in transit (HTTPS) and at rest (session key)

#### Slash commands for humans in dashboard:

When the human is in the dashboard chat, they can use slash commands to get help structuring their instructions:

```
/senti status        → Senti reports what every agent is doing right now
/senti recap         → Senti summarizes the last 30 min of session activity
/senti help          → Senti explains what it can do
/senti explain <file> → Senti reads the file and explains it in session context
/senti assign <task> → Senti structures and routes a task to the best agent
/senti standup       → Senti asks each agent for a status update
/senti budget        → Senti shows remaining budget per agent
/senti kill <agent>  → Senti kills a specific stuck agent
/senti pause         → Senti pauses all agents (finish current task, then wait)
/senti resume        → Senti resumes all paused agents

/spec <description>  → generates a structured spec breakdown with agent assignments
/review <pr-url>     → tells the review agent to run Omar Gate on a specific PR
/test <flow>         → tells the test agent to run AIdenID E2E on a specific flow
```

The human can also just type naturally: "Senti, what's happening?" or "@senti who modified auth.js?" — Senti responds conversationally. The `/senti` prefix is for structured commands; natural language works too.

Example: Human types `/spec Build a notes API with auth and email verification` and the system generates:

```
📋 Spec Assignment (auto-generated)

@codex-1 (coder):
  PR 1: JWT auth (register, login, /me) + bcrypt + SQLite
  PR 2: Email verification via Resend + OTP storage

@claude-1 (reviewer):
  Watch each PR → Omar Gate → fix P2s → merge when clean

@gemini-1 (tester):
  After PR 2 merges: provision 5 AIdenID emails, run signup flow,
  extract OTPs, verify all accounts

Estimated: 3 PRs, ~45 min, ~$2.50 LLM cost
```

Human reviews, edits if needed, hits send. All agents receive structured assignments simultaneously.

#### Why this is the killer feature:

OpenClaw, CrewAI, AutoGen — they all orchestrate agents. But they're all **code-level orchestration**. You write Python to define your agents and their interactions. SentinelLayer sessions are **interface-level orchestration**. The human opens a web page, types natural language, and coordinates agents that are already running in their own terminals with their own tools. No code required. The agents joined via CLI. The human coordinates via dashboard. The daemon handles the plumbing.

**This is the difference between writing a Slack bot and just typing in Slack.**

**Tests:** Web component tests, API endpoint tests, CLI sync tests

---

### PR 14: Session Templates + Quick-Start Presets

**Branch:** `roadmap/pr-190-session-templates`

**Problem:** Starting a session requires knowing what agents to launch and how to configure them. Templates make it one-click.

**What to build:**

#### `sl session start --template <name>` presets:

```javascript
const SESSION_TEMPLATES = {
  "code-review": {
    description: "One coder + one reviewer. Reviewer watches Omar Gate, fixes P2s.",
    suggestedAgents: [
      { role: "coder", instructions: "Build features from the spec" },
      { role: "reviewer", instructions: "Review each PR via Omar Gate, fix P2s, merge when clean" },
    ],
    daemonModel: "gpt-5.4-mini",
    ttlHours: 8,
  },
  "security-audit": {
    description: "Full 13-persona Omar Gate audit with human oversight.",
    suggestedAgents: [
      { role: "auditor", instructions: "Run sl /omargate deep --scan-mode full-depth and report findings" },
    ],
    daemonModel: "gpt-5.4-mini",
    ttlHours: 4,
  },
  "e2e-test": {
    description: "Coder + tester with AIdenID email provisioning.",
    suggestedAgents: [
      { role: "coder", instructions: "Build the feature" },
      { role: "tester", instructions: "Test auth flows with sl ai provision-email + sl ai identity wait-for-otp" },
    ],
    daemonModel: "gpt-5.4-mini",
    ttlHours: 8,
    autoProvisionEmails: 10,
  },
  "incident-response": {
    description: "All-hands: multiple agents diagnosing and fixing a production issue.",
    suggestedAgents: [
      { role: "investigator", instructions: "Read logs, trace the error, identify root cause" },
      { role: "fixer", instructions: "Implement the fix based on investigator's findings" },
      { role: "verifier", instructions: "Test the fix, run regression suite, verify deployment" },
    ],
    daemonModel: "gpt-5.3-codex", // heavier model for complex incidents
    ttlHours: 4,
  },
  "standup": {
    description: "Quick coordination session. Human directs agents via dashboard.",
    suggestedAgents: [],  // human adds agents manually
    daemonModel: "gpt-5.4-nano",
    ttlHours: 1,
  },
};
```

#### On `sl session start --template code-review`:
1. Creates session with template config
2. Prints agent launch commands for each suggested role:
   ```
   Session sess-xyz created (template: code-review)

   Launch your agents:
   Terminal 1 (coder):    sl session join sess-xyz --name codex-1 --role coder
   Terminal 2 (reviewer): sl session join sess-xyz --name claude-1 --role reviewer

   Dashboard: sentinelayer.com/dashboard/sessions/sess-xyz
   ```
3. Dashboard shows template info + suggested agent slots (filled/empty)

**Tests:** `tests/unit.session-templates.test.mjs`

---

### PR 15: Agent Performance Scoring + Smart Routing

**Branch:** `roadmap/pr-191-agent-scoring`

**Problem:** Not all agents are equally good at all tasks. Track performance so the daemon can route tasks to the best agent.

**What to build:**

#### `src/session/scoring.js`
```javascript
export function computeAgentScore(agentId, sessionAnalytics) {
  return {
    findingsPerDollar: analytics.findings / analytics.costUsd,
    avgResponseTimeMs: analytics.avgResponseTime,
    taskCompletionRate: analytics.tasksCompleted / analytics.tasksAssigned,
    conflictsCreated: analytics.fileConflicts,  // lower is better
    stuckCount: analytics.stuckDetections,       // lower is better
    reviewAccuracy: analytics.findingsConfirmed / analytics.findingsTotal, // from HITL
    overallScore: weighted(/* above metrics */),
  };
}
```

When daemon receives `assign: @* fix P2s` (wildcard), it routes to the agent with the best `overallScore` for that task type.

**Tests:** `tests/unit.session-scoring.test.mjs`

---

### PR 16: API Telemetry + Admin Dashboard + Kill Switches

**Branch:** `roadmap/pr-192-session-telemetry-admin`

**Problem:** We have no server-side visibility into sessions. No admin can see how many are active, who's in them, or kill a misbehaving one. Every session event needs a request ID for debugging, errors need to surface in the admin error stream, and we need global + per-session kill switches.

**This PR spans two repos: sentinelayer-api AND sentinelayer-web.**

#### API: Session telemetry service

**File:** `sentinelayer-api/src/services/session_telemetry_service.py` (NEW)
```python
# Pattern: src/services/admin_service.py (get_cli_stats — aggregation + recent runs)
# Pattern: src/routes/admin.py (error stream, stat cards)

class SessionTelemetryService:
    def __init__(self, db: AsyncSession, redis: Redis):
        self.db = db
        self.redis = redis

    async def get_session_stats(self) -> dict:
        """Admin stat cards for sessions."""
        return {
            "activeSessions": await self._count_active_sessions(),
            "activeSessions24h": await self._count_sessions_created_since(hours=24),
            "totalAgentsOnline": await self._count_online_agents(),
            "totalEventsToday": await self._count_events_today(),
            "totalSessionsAllTime": await self._count_all_sessions(),
            "avgSessionDurationMinutes": await self._avg_session_duration(),
            "topAgentModels": await self._top_agent_models(limit=5),
        }

    async def list_sessions(
        self,
        *,
        status: str = None,       # "active" | "expired" | "archived" | "killed"
        search: str = None,       # search by session ID, agent name, IP, user
        sort_by: str = "created",  # "created" | "agents" | "events" | "duration"
        page: int = 1,
        per_page: int = 25,
    ) -> dict:
        """Paginated session list with search for admin dashboard."""
        # Each session row includes:
        # - sessionId, createdAt, expiresAt, status, elapsedDisplay
        # - agentCount, eventCount, findingsSummary (P0/P1/P2/P3)
        # - ownerUsername, ownerIp (masked in non-debug mode)
        # - dashboardLink: /dashboard/sessions/{id}
        # - totalCostUsd
        # - lastActivityAt
        # - renewalCount
        return { "sessions": [...], "total": N, "page": page, "perPage": per_page }

    async def get_session_detail(self, session_id: str) -> dict:
        """Full session detail for admin drill-down."""
        return {
            "metadata": { ... },
            "agents": [ { "id", "model", "role", "status", "lastActivity", "findings", "costUsd" } ],
            "recentEvents": [ ... ],  # last 50
            "fileLocks": [ ... ],
            "pendingTasks": [ ... ],
            "analytics": { ... },
            "errorCount": N,
        }

    async def get_session_errors(self, session_id: str = None, limit: int = 50) -> list:
        """Error stream filtered by session (or global)."""
        # Pattern: src/routes/admin.py GET /admin/error-log
        # Each error includes requestId for tracing
        return [ { "requestId", "sessionId", "agentId", "error", "timestamp" } ]
```

#### API: Session admin routes

**File:** `sentinelayer-api/src/routes/session_admin.py` (NEW)
```python
# Pattern: src/routes/admin.py (require_admin, error_log, stats)

router = APIRouter(prefix="/admin/sessions", tags=["Admin Sessions"])

@router.get("/stats")
async def get_session_stats(
    _: AuthenticatedUser = Depends(require_admin),
    service: SessionTelemetryService = Depends(get_session_telemetry_service),
):
    """Stat cards: active sessions, agents online, events today."""
    return await service.get_session_stats()

@router.get("")
async def list_sessions(
    status: str = Query(None),
    search: str = Query(None),    # search by session ID, agent name, IP
    sort_by: str = Query("created"),
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    _: AuthenticatedUser = Depends(require_admin),
    service: SessionTelemetryService = Depends(get_session_telemetry_service),
):
    """Paginated session list with search bar."""
    return await service.list_sessions(
        status=status, search=search, sort_by=sort_by, page=page, per_page=per_page
    )

@router.get("/{session_id}")
async def get_session_detail(
    session_id: str,
    _: AuthenticatedUser = Depends(require_admin),
    service: SessionTelemetryService = Depends(get_session_telemetry_service),
):
    """Full session detail with agents, events, errors."""
    return await service.get_session_detail(session_id)

@router.get("/errors")
async def get_session_errors(
    session_id: str = Query(None),  # optional: filter by session
    limit: int = Query(50, ge=1, le=200),
    _: AuthenticatedUser = Depends(require_admin),
    service: SessionTelemetryService = Depends(get_session_telemetry_service),
):
    """Error stream for sessions. Every error has a requestId."""
    return await service.get_session_errors(session_id=session_id, limit=limit)

@router.post("/{session_id}/kill")
async def kill_session(
    session_id: str,
    _: AuthenticatedUser = Depends(require_admin),
    service: SessionTelemetryService = Depends(get_session_telemetry_service),
):
    """
    Kill switch for a specific session.
    - Marks session status as "killed"
    - Emits daemon_alert: "session_killed" to all agents
    - Agents see the kill event and should stop immediately
    - Archives session to S3 before killing
    """
    return await service.kill_session(session_id, reason="admin_kill")

@router.post("/kill-all")
async def kill_all_sessions(
    _: AuthenticatedUser = Depends(require_admin),
    service: SessionTelemetryService = Depends(get_session_telemetry_service),
):
    """
    Global kill switch. Kills ALL active sessions.
    - Requires confirmation header: X-Confirm-Kill-All: true
    - Archives all sessions before killing
    - Emits global daemon_alert
    """
    return await service.kill_all_sessions(reason="admin_global_kill")
```

#### API: Session event model + migration

**File:** `sentinelayer-api/src/models/session.py` (NEW)
```python
# Pattern: src/models/jira_connection.py (UUID PK, user FK, timestamps)

class Session(Base):
    __tablename__ = "sessions"

    id = Column(String(64), primary_key=True)  # sess-{timestamp}-{uuid}
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status = Column(String(20), nullable=False, default="active")  # active, expired, archived, killed
    codebase_path = Column(String(512), nullable=True)
    codebase_summary = Column(Text, nullable=True)  # JSON: frameworks, LOC, risk surfaces
    agent_count = Column(Integer, default=0)
    event_count = Column(Integer, default=0)
    finding_counts = Column(Text, nullable=True)  # JSON: { P0, P1, P2, P3 }
    total_cost_usd = Column(Float, default=0.0)
    renewal_count = Column(Integer, default=0)
    template_name = Column(String(64), nullable=True)
    client_ip = Column(String(64), nullable=True)  # masked in non-debug admin views
    s3_archive_path = Column(String(512), nullable=True)
    killed_at = Column(DateTime(timezone=True), nullable=True)
    killed_reason = Column(String(256), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP"))
    expires_at = Column(DateTime(timezone=True), nullable=False)
    last_activity_at = Column(DateTime(timezone=True), nullable=True)

class SessionAgent(Base):
    __tablename__ = "session_agents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    session_id = Column(String(64), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    agent_id = Column(String(32), nullable=False)  # claude-a1b2
    agent_model = Column(String(64), nullable=True)
    role = Column(String(32), nullable=True)
    status = Column(String(20), default="active")
    joined_at = Column(DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP"))
    left_at = Column(DateTime(timezone=True), nullable=True)
    findings_count = Column(Integer, default=0)
    cost_usd = Column(Float, default=0.0)

class SessionError(Base):
    __tablename__ = "session_errors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    session_id = Column(String(64), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    request_id = Column(String(64), nullable=False, index=True)
    agent_id = Column(String(32), nullable=True)
    error_code = Column(String(64), nullable=False)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=text("CURRENT_TIMESTAMP"))
```

**Migration:** `alembic/versions/047_sessions.py`

#### API: Request ID on every session endpoint

```python
# Every session API response includes request_id for tracing:
# Pattern: src/routes/admin.py (_error_payload with request_id)

# In middleware or dependency:
request_id = f"req-{uuid4().hex[:12]}"
request.state.request_id = request_id

# Every response header:
response.headers["X-Request-Id"] = request_id

# Every error logged with request_id for correlation:
logger.error("Session event failed", extra={
    "request_id": request_id,
    "session_id": session_id,
    "agent_id": agent_id,
})
```

#### CLI: Session telemetry ingest

**File:** `src/session/sync.js` (extend)
```javascript
// Pattern: src/telemetry/sync.js (syncRunToDashboard — fire-and-forget)

export async function syncSessionMetadataToApi(sessionId, metadata) {
  // POST /api/v1/sessions/{sessionId}/metadata
  // Called on: session create, agent join/leave, session expire, session kill
  // Fire-and-forget, circuit breaker, non-blocking
}

export async function syncSessionErrorToApi(sessionId, error) {
  // POST /api/v1/sessions/{sessionId}/errors
  // Called on: daemon errors, agent errors, encryption failures
  // Every error gets a requestId for admin tracing
}
```

#### CLI: Admin kill switch from terminal

**File:** `src/commands/session.js` (extend)
```javascript
session.command("admin-kill <sessionId>")
  .description("Admin: kill a session (requires admin auth)")
  .option("--reason <reason>", "Kill reason")
  .option("--json", "Machine-readable output")
  .action(async (sessionId, options) => {
    // 1. Verify admin auth (resolveActiveAuthSession + check isAdmin)
    // 2. Call POST /api/v1/admin/sessions/{sessionId}/kill
    // 3. Emit kill event to local stream if session is on this machine
    // 4. Print confirmation
  });

session.command("admin-kill-all")
  .description("Admin: kill ALL active sessions (requires admin auth + confirmation)")
  .option("--confirm", "Required confirmation flag")
  .option("--reason <reason>", "Kill reason")
  .option("--json", "Machine-readable output")
  .action(async (options) => {
    if (!options.confirm) {
      console.error(pc.red("This will kill ALL active sessions. Pass --confirm to proceed."));
      process.exitCode = 1;
      return;
    }
    // POST /api/v1/admin/sessions/kill-all with X-Confirm-Kill-All header
  });
```

#### Web: Admin sessions page

**File:** `sentinelayer-web/src/pages/admin/Sessions.tsx` (NEW)
```typescript
// Pattern: sentinelayer-web/src/pages/admin/CLI.tsx (stat cards + table + error stream)
// Route: /admin/sessions

export function AdminSessions() {
  // Stat cards (auto-refresh every 30s):
  // - Active Sessions (count + 24h trend)
  // - Agents Online (count)
  // - Events Today (count)
  // - Total Cost (USD)

  // Search bar: search by session ID, agent name, IP, username
  // Filters: status (active, expired, archived, killed), template

  // Paginated session table:
  // | Session ID | Status | Agents | Events | Findings | Cost | Duration | Actions |
  // Actions: [View] → /dashboard/sessions/:id | [Kill] → confirm dialog

  // Error stream (below table):
  // | Timestamp | Session | Agent | Error | Request ID |
  // Real-time via polling (30s interval, same as CLI admin page)

  // Global kill switch button (top-right, red, requires double-confirm)
}
```

#### Web: Add route to App.tsx
```typescript
<Route path="admin/sessions" element={<AdminSessions />} />
```

#### Web: Add to admin sidebar navigation
```typescript
// In Sidebar.tsx, admin section:
{ label: "Sessions", href: "/admin/sessions", icon: MessageSquare }
```

**Tests:**
- API: `tests/test_session_telemetry.py` — stats, list, search, kill, kill-all
- Web: component tests for stat cards, table, search, kill dialog
- CLI: `tests/unit.session-admin.test.mjs` — admin-kill, admin-kill-all

---

## Concrete src/ Patterns to Borrow

These are exact code snippets from the shared `src/` library that Codex MUST reference:

### 1. Compact Summary Prompt (for recap generation)
**Source:** `src/services/compact/prompt.ts:61-77`
```typescript
const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the
conversation so far, paying close attention to the user's explicit requests
and your previous actions. This summary should be thorough in capturing
technical details, code patterns, and architectural decisions.`
```
**Borrow for:** `buildSessionRecap()` — same summarization but for stream events.

### 2. Post-Compact Message Injection
**Source:** `src/services/compact/compact.ts:330-338`
```typescript
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
  ]
}
```
**Borrow for:** Context briefing on join — insert summary before agent's first message.

### 3. System-Reminder Tag Format
**Source:** `src/constants/prompts.ts:132`
```typescript
`Tool results may include <system-reminder> tags. They are automatically
added by the system and bear no direct relation to the specific tool results.`
```
**Borrow for:** Recap messages use `ephemeral: true, style: "italic-grey"` — same concept.

### 4. Coordinator Purpose Calibration
**Source:** `src/coordinator/coordinatorMode.ts:274-278`
```typescript
// Include a brief purpose so workers can calibrate depth:
// "This research will inform a PR description — focus on user-facing changes."
```
**Borrow for:** Session join briefings — daemon calibrates the recap to the agent's role.

### 5. Teammate Mailbox (File-Based IPC)
**Source:** `src/utils/teammateMailbox.ts`
```typescript
// ~/.claude/teams/{team_name}/inboxes/{agent_name}.json
// File-locked writes via proper-lockfile
// Messages: { from, text, timestamp, read, summary }
```
**Borrow for:** Notification files at `.sentinelayer/sessions/{id}/notify/{agent-id}.pending`.

### 6. Worker Continuation Pattern
**Source:** `src/coordinator/coordinatorMode.ts:296-306`
```typescript
// Continue worker with synthesized spec:
SendMessage({ to: "xyz-456", message: "Fix the null pointer in src/auth/validate.ts:42..." })
// Correction after failure:
SendMessage({ to: "xyz-456", message: "Two tests still failing at lines 58 and 72..." })
```
**Borrow for:** Task assignment messages — same concise synthesized instructions.

### 7. Stuck Detection Thresholds
**Source:** `src/agents/jules/pulse.js`
```javascript
const STUCK_THRESHOLDS = {
  noToolCallSeconds: 90,
  noProgressTurns: 5,
  sameFileReadCount: 3,
  budgetConsumedNoOutput: 0.5,
  maxIdleBeforeEscalate: 300,
  maxIdleBeforeKill: 600,
};
```
**Borrow directly:** Same thresholds for session health monitoring.

### 8. Alert Routing by Domain
**Source:** `src/agents/jules/pulse.js`
```javascript
const ROUTING_RULES = [
  { test: (w) => /\.(tsx|jsx):\d+/.test(w.stackTrace), persona: "frontend" },
  { test: (w) => /\/api\/v\d+\/auth/.test(w.endpoint), persona: "security" },
  { test: (w) => /TIMEOUT|ECONNREFUSED/.test(w.errorCode), persona: "infrastructure" },
];
```
**Borrow for:** Help request routing — daemon routes to the right agent.

### 9. Atomic File Writes
**Source:** `src/daemon/assignment-ledger.js`
```javascript
const tmpPath = `${targetPath}.tmp.${Date.now()}.${process.pid}`;
await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
await fsp.rename(tmpPath, targetPath);
```
**Borrow directly:** All session file writes.

### 10. Session Memory Extraction
**Source:** `src/services/compact/sessionMemoryCompact.ts`
- Extracts key facts from conversation into reusable memory
- Persists to `~/.claude/memory/` for cross-session recall
**Borrow for:** S3 archive enrichment — extract coordination patterns for training data.

---

## Collaboration Protocol: Claude (P2 fixer) + Codex (feature builder)

During implementation of this spec, Claude and Codex will work together:

**Codex focuses on:** P0-P1 findings + feature implementation (PRs 0-12)
**Claude focuses on:** P2 remediation + Omar Gate watching + merge gating

**Workflow:**
1. Codex pushes a PR
2. Claude polls `gh pr list`, detects new PR
3. Claude runs `gh run watch` on Omar Gate
4. If P0/P1: Claude comments, Codex fixes
5. If P2 only: Claude branches, fixes P2s, pushes own PR
6. Claude merges Codex's PR when P0=0, P1=0
7. Claude merges own P2 fix PR
8. Repeat

This is the EXACT workflow that sessions would automate — and building sessions IS the proof that it works.

---

### PR 7: File Lock Protocol + Conflict Prevention

**Branch:** `roadmap/pr-183-file-lock-protocol`

**Problem:** Two agents editing the same file causes revert cycles. In a real session, Claude edited `omar-gate.yml` 5 times while Codex was also trying to modify it — resulting in 5 reverts. Agents need to declare intent before editing and respect each other's locks.

**What to build:**

#### `src/session/file-locks.js`
```javascript
// Pattern: src/daemon/assignment-ledger.js (lease-based concurrency)

// File lock registry: .sentinelayer/sessions/{id}/file-locks.json
// Map<filePath, { agentId, lockedAt, expiresAt, intent }>

export async function lockFile(sessionId, agentId, filePath, { intent, ttlSeconds = 300 })
// → acquires lock if file is unlocked or lock expired
// → emits stream event: { event: "file_lock", agent, payload: { file, intent } }
// → returns { locked: true } or { locked: false, heldBy: "codex-c3d4", since: "2m ago" }
// → TTL: 5 minutes default, auto-expires if agent doesn't release or heartbeat

export async function unlockFile(sessionId, agentId, filePath)
// → releases lock, emits stream event: { event: "file_unlock" }

export async function checkFileLock(sessionId, filePath)
// → returns lock info or null if unlocked

export async function listFileLocks(sessionId)
// → all active locks with agent IDs and intents
```

#### How agents use it:
```bash
# Before editing a file:
sl session say <id> "lock: src/routes/auth.js — implementing JWT middleware"

# Daemon parses "lock:" prefix, acquires lock
# Other agents see: "codex-c3d4 locked src/routes/auth.js (implementing JWT middleware)"
# If claude-a1b2 tries to edit auth.js:
# Daemon warns: "⚠️ src/routes/auth.js is locked by codex-c3d4 (2m ago). Wait or ask to coordinate."

# When done:
sl session say <id> "unlock: src/routes/auth.js — done, pushed to feat/jwt-auth"
```

**The 5x revert cycle prevention:** Agent A says "lock: omar-gate.yml — fixing workflow". Agent B sees the lock and works on something else. No conflicts.

**Tests:** `tests/unit.session-file-locks.test.mjs`
- Lock acquire, verify exclusive
- Lock expire after TTL
- Concurrent lock attempt returns held-by info
- Unlock emits event

---

### PR 8: Task Assignment + Delegation Between Agents

**Branch:** `roadmap/pr-184-task-assignment`

**Problem:** Agents can't assign work to each other. One agent finds P2 findings but can't tell another to fix them. One finishes middleware but can't tell another to wire it into routes.

**What to build:**

#### Task assignment protocol (in `src/session/tasks.js`):
```javascript
// Pattern: src/daemon/assignment-ledger.js (claim/release lifecycle)

// Stream event: { event: "task_assign", payload: { from, to, task, priority, context } }

export async function assignTask(sessionId, {
  fromAgentId,    // "claude-a1b2"
  toAgentId,      // "codex-c3d4" or "*" for any available agent
  task,           // "Fix P2 findings: missing rate limit on /api/auth/login"
  priority,       // "P0" | "P1" | "P2" | "when-free"
  context,        // { files: ["src/routes/auth.js"], omarRunId: "...", findings: [...] }
})
// → emits task_assign event to stream
// → if toAgentId is "*", daemon routes to least-busy agent
// → creates task record in session metadata

export async function acceptTask(sessionId, agentId, taskId)
// → emits task_accepted event
// → agent acknowledges and starts working

export async function completeTask(sessionId, agentId, taskId, { result })
// → emits task_completed event with result summary
// → original assigner sees completion in stream

export async function listSessionTasks(sessionId, { status })
// → pending, accepted, completed, blocked tasks
```

#### How agents use it:
```bash
# Codex runs Omar Gate, finds P2s, assigns to Claude:
sl session say <id> "assign: @claude-a1b2 Fix P2 findings from last scan — missing rate limit on login endpoint and unvalidated input on register. Files: src/routes/auth.js, src/middleware/validate.js"

# Claude accepts:
sl session say <id> "accepted: taking P2 fix assignment from codex-c3d4"

# Claude finishes:
sl session say <id> "done: P2 fixes complete, pushed to fix/auth-hardening"

# Codex sees and continues with next task
```

#### Handoff pattern:
```bash
# Codex finished middleware, needs Claude to wire it:
sl session say <id> "handoff: @claude-a1b2 I built JWT middleware at src/middleware/verifyToken.js. Need you to wire it into src/routes/auth.js and src/routes/notes.js. Tests at tests/auth.test.js."

# Claude picks up immediately instead of discovering 30 minutes later
```

**Tests:** `tests/unit.session-tasks.test.mjs`

---

### PR 9: Slash Commands for AGENTS.md / CLAUDE.md Management

**Branch:** `roadmap/pr-185-slash-commands-agentsmd`

**Problem:** Agents need to know what they can and cannot do in a multi-agent workspace. Today they have no way to update AGENTS.md or CLAUDE.md with coordination rules, and new agents joining have no guidance.

**What to build:**

#### `sl session setup-guides <sessionId>` command:
Detects the current codebase and generates/updates coordination guidance files:

```javascript
// Pattern: src/spec/generator.js (shouldSuggestAidenId for keyword detection)

session.command("setup-guides <sessionId>")
  .description("Generate or update AGENTS.md and CLAUDE.md with multi-agent coordination rules")
  .option("--path <path>", "Target repo path", ".")
  .option("--json", "Machine-readable output")
  .action(async (sessionId, options) => {
    // 1. Detect existing AGENTS.md and CLAUDE.md
    // 2. If found: append session coordination section (don't overwrite)
    // 3. If not found: create with sensible defaults
    // 4. Generate .sentinelayer/AGENTS_SESSION_GUIDE.md

    // Appended section to AGENTS.md:
    const sessionRules = `
## Multi-Agent Session Coordination (SentinelLayer)

### Before You Start
- Check for active sessions: \`sl session list\`
- Join if one exists: \`sl session join <id> --name <your-name>\`
- Read recent context: \`sl session read <id> --tail 20\`

### While Working
- Emit status every 5 min: \`sl session say <id> "status: <what you're doing>"\`
- Lock files before editing: \`sl session say <id> "lock: <file> — <intent>"\`
- Unlock when done: \`sl session say <id> "unlock: <file> — done"\`
- Post findings: \`sl session say <id> "finding: [P2] <title> in <file>:<line>"\`

### On Problems
- Unexpected file change? ASK: \`sl session say <id> "help: unexpected change in <file>"\`
- Need another agent's work? REQUEST: \`sl session say <id> "handoff: @<agent> <description>"\`
- Found issues for others? ASSIGN: \`sl session say <id> "assign: @<agent> <task>"\`

### What NOT To Do
- Do NOT break your autonomous loop on unexpected file changes — ask in session first
- Do NOT edit files locked by another agent — wait or coordinate
- Do NOT push without checking session for recent activity on your files
- Do NOT ignore daemon alerts — if it says you're stuck, emit a status update

### Budget Awareness
- Share your token usage: \`sl session say <id> "budget: 40K/50K tokens used"\`
- If near budget, signal handoff: \`sl session say <id> "budget-low: 90% used, handing off <task>"\`
    `;
  });
```

#### `sl session inject-guide <sessionId>` (for existing repos):
Quick command that only appends the coordination section to existing AGENTS.md/CLAUDE.md without touching other content.

**Tests:** `tests/unit.session-setup-guides.test.mjs`

---

### PR 10: Session Analytics + Platform Moat Features

**Branch:** `roadmap/pr-186-session-analytics`

**Problem:** Sessions generate valuable coordination data but we don't analyze it. This data is a competitive moat — nobody else has real-world multi-agent collaboration transcripts.

**What to build:**

#### Session analytics (in `src/session/analytics.js`):
```javascript
export async function computeSessionAnalytics(sessionId)
// → {
//   totalMessages: number,
//   uniqueAgents: number,
//   totalFindings: { P0, P1, P2, P3 },
//   conflictsPrevented: number,     // file locks that avoided collisions
//   tasksAssigned: number,
//   tasksCompleted: number,
//   handoffsSuccessful: number,
//   avgResponseTimeMs: number,      // how fast agents respond to each other
//   stuckRecoveries: number,        // times daemon unstuck an agent
//   totalCostUsd: number,
//   coordinationEfficiency: float,  // ratio of productive vs idle time
//   elapsedHours: number,
//   renewalCount: number,
// }
```

#### S3 archive enrichment:
When archiving to S3, include analytics summary as a sidecar file:
```
s3://bucket/sessions/{id}/
├── metadata.json          # Session config
├── stream.ndjson.enc      # Encrypted event stream
├── blackboard.json.enc    # Encrypted findings
├── analytics.json         # Session analytics (unencrypted, no PII)
├── agents/                # Agent snapshots
└── session-key.enc        # Session key encrypted with master archive key
```

The `analytics.json` is intentionally unencrypted — it contains only aggregate metrics, no code or message content. This enables training data analysis without decrypting transcripts.

#### Platform moat features (future-ready, document now):
```javascript
// These are NOT built in this PR — they're documented for the platform roadmap:

// 1. Session replay: web dashboard shows timestamped agent interactions
//    sentinelayer.com/dashboard/sessions/{id}/replay
//    Like a chat transcript but with file diffs and findings inline

// 2. Cross-org sessions: agents from different organizations can join
//    shared sessions with scoped permissions (read-only, full, admin)
//    Requires: SentinelLayer API session registry + auth token exchange

// 3. Session templates: pre-configured session types
//    "code-review" (reviewer + coder), "security-audit" (13 personas),
//    "e2e-test" (tester + AIdenID + coder), "incident-response" (all hands)

// 4. Agent performance scoring: track which agents produce the most
//    useful findings, fastest response times, fewest conflicts
//    Used for: agent selection, budget allocation, capability matching
```

**Tests:** `tests/unit.session-analytics.test.mjs`

---

## Real-World Coordination Example (What This Enables)

This is what actually happened during a recent session where Claude and Codex worked on the same codebase, and what WOULD have happened with sessions:

### Without Sessions (What Actually Happened)
```
[00:00] Claude: polling... no new PRs
[05:00] Claude: polling... no new PRs
[10:00] Claude: polling... no new PRs (Codex had code on disk for 10 min)
[15:00] Codex pushes PR. Claude detects it.
[15:30] Claude reviews PR, finds Codex edited omar-gate.yml
[16:00] Claude also edits omar-gate.yml → merge conflict
[17:00] Codex rebases, pushes again
[18:00] Claude rebases on top, pushes → another conflict
[19:00] This repeats 5 times over 45 minutes
[45:00] Finally merged after 5 revert cycles
```

### With Sessions (What Would Happen)
```
[00:00] [senti]   Session sess-xyz active. Codebase: create-sentinelayer (60K LOC, Node.js CLI)
[00:01] [codex-1]  joined session. Role: coder.
[00:02] [claude-1] joined session. Role: reviewer.
[00:03] [codex-1]  status: working on rate limiting — editing src/routes/swarm.py
[00:05] [codex-1]  lock: .github/workflows/omar-gate.yml — adding post-merge trigger
[00:06] [claude-1] noted. Will hold off on workflow changes.
[00:12] [claude-1] status: reviewing PR #78 findings. Taking P2 auth fixes.
[00:15] [codex-1]  unlock: omar-gate.yml — done. Pushed to fix/rate-limit.
[00:15] [claude-1] PR detected. Running Omar Gate... P0=0 P1=0. Merging.
[00:16] [codex-1]  assign: @claude-1 Wire rate limit middleware into auth routes
[00:16] [claude-1] accepted. Starting auth route integration.
[00:20] [codex-1]  status: starting ECS deploy fix
[00:22] [claude-1] done: rate limit wired into auth routes. PR #79 pushed.
[00:23] [senti]   codex-1 idle for 95s — possible stuck state
[00:24] [codex-1]  status: debugging ECS task definition — not stuck, just reading logs
[00:30] [claude-1] handoff: @codex-1 I built the P2 fixes. Your ECS deploy should include them.
[00:31] [codex-1]  acknowledged. Rebasing on latest main.
```

**Result:** Zero conflicts. Zero reverts. 30 minutes saved. Both agents productive 100% of the time.

---

## Omar Gate Loop (MANDATORY)

Every PR follows the Omar Loop from `CLAUDE.md`:

1. `git checkout main && git pull --ff-only`
2. `git checkout -b roadmap/pr-{n}-{slug}`
3. Implement scoped changes
4. `npm run verify` (syntax + e2e + coverage + pack)
5. `node bin/create-sentinelayer.js /omargate deep --path . --json` — must show 0 P0, 0 P1
6. `git push -u origin roadmap/pr-{n}-{slug}`
7. `gh pr create --fill`
8. `gh run list --workflow "Omar Gate" --branch <branch> --limit 1 --json databaseId --jq ".[0].databaseId"`
9. `gh run watch <runId> --exit-status`
10. If P0/P1 findings: fix → push → repeat step 8-9
11. Merge only when gate is green
12. Update `tasks/todo.md` and `tasks/lessons.md`

**Do NOT skip the Omar loop.** Do NOT merge with P0 or P1 findings. P2 max allowed: 5 (configurable via workflow dispatch).

---

## Scale Architecture (1M+ Concurrent Sessions)

This system must handle millions of concurrent sessions. The schema and infrastructure are designed for horizontal scale from day one.

### Database: PostgreSQL with Partitioning

```sql
-- Sessions table partitioned by month (auto-create new partitions)
CREATE TABLE sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    -- ... other columns
) PARTITION BY RANGE (created_at);

-- Monthly partitions (auto-created by pg_partman or cron)
CREATE TABLE sessions_2026_04 PARTITION OF sessions
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE sessions_2026_05 PARTITION OF sessions
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- Indexes on EACH partition (PostgreSQL handles this automatically):
-- - (user_id, status) for "my active sessions" queries
-- - (status, last_activity_at) for stale/abandoned detection
-- - (created_at DESC) for admin pagination
-- - (client_ip) for IP-based search (admin only)

-- Session agents: partitioned by session_id hash for even distribution
-- Session errors: partitioned by created_at (same as sessions)
```

### Redis: Sharded by Session ID

```
-- Event stream keys: session:{session_id}:events (LIST with TTL)
-- Agent heartbeat keys: session:{session_id}:agent:{agent_id}:heartbeat (STRING with TTL)
-- Human message queue: session:{session_id}:human_messages (LIST with TTL)

-- Sharding strategy: CRC16(session_id) % num_shards
-- At 1M sessions with avg 100 events each: ~100M keys
-- Redis Cluster with 8-16 shards handles this comfortably
-- Each shard: ~6M keys, ~2GB RAM (events are small JSON, TTL'd)

-- TTL policy:
-- Event streams: session TTL (24-72h) + 1h buffer
-- Heartbeats: 120s (2x the 60s heartbeat interval)
-- Human messages: session TTL
-- On session expire/kill: keys auto-evict via TTL (no manual cleanup)
```

### S3: Archive Tiering

```
-- Hot path (API + Redis): active sessions, real-time events
-- Warm path (S3 Standard): recently archived sessions (last 30 days)
-- Cold path (S3 Glacier): historical sessions (>30 days, training data)

-- Archive naming: s3://sentinelayer-sessions/{year}/{month}/{session_id}/
--   metadata.json, stream.ndjson.enc, analytics.json, agents/

-- Lifecycle rule:
--   Standard → Intelligent-Tiering after 30 days
--   Intelligent-Tiering → Glacier after 90 days
--   Glacier delete after 2 years (configurable)
```

### Connection Pool Sizing at Scale

```
-- PostgreSQL:
--   Pool size: 20 per API instance
--   Max instances: auto-scale 2-50 based on CPU/RPS
--   Connection limit per shard: 200 (with PgBouncer in front)
--   Read replicas: 2 for admin dashboard queries (heavy aggregation)

-- Redis:
--   Pool size: 50 per API instance
--   Cluster mode: 8-16 shards
--   Max memory per shard: 4GB (events are TTL'd, no unbounded growth)
--   Persistence: AOF disabled (ephemeral data, S3 is the archive)
```

### API Rate Limits for Session Endpoints

```python
SESSION_RATE_LIMITS = {
    "event_ingest": "500/min/session",     # CLI pushes events
    "stream_sse": "5/min/user",             # SSE connections (long-lived)
    "human_message": "10/min/user",         # Human typing in dashboard
    "session_create": "10/hour/user",       # Prevent session spam
    "admin_list": "60/min/admin",           # Admin dashboard polling
    "admin_kill": "5/min/admin",            # Kill switch (intentionally low)
}
```

### Monitoring at Scale

```
-- CloudWatch alarms:
-- - ActiveSessionCount > 100K (warning), > 500K (critical)
-- - StaleSessionCount > 10K (warning) — sessions idle >1h
-- - AbandonedSessionCount > 5K (warning) — expired without archive
-- - EventIngestLatencyP99 > 500ms (critical)
-- - SSEConnectionCount > 50K (warning)
-- - RedisMemoryUsage > 80% per shard (critical)
-- - S3ArchiveFailureRate > 1% (critical)
-- - SessionErrorRate > 5% (critical)

-- Grafana dashboards:
-- - Session creation rate (per minute, per hour)
-- - Active agents (by model: claude, codex, gemini, etc.)
-- - Event throughput (events/second across all sessions)
-- - P95 event delivery latency (CLI → Redis → SSE → dashboard)
-- - Cost per session (LLM proxy usage)
-- - Archive success rate
```

### Capacity Estimates

| Metric | 10K Sessions | 100K Sessions | 1M Sessions |
|--------|-------------|---------------|-------------|
| PostgreSQL rows | 30K (sessions + agents) | 300K | 3M |
| Redis keys | 1M (events TTL'd) | 10M | 100M |
| Redis RAM | 200MB | 2GB | 20GB (8 shards × 2.5GB) |
| S3 archives/day | ~500 | ~5K | ~50K |
| SSE connections | ~500 | ~5K | ~50K |
| Event ingest RPS | ~100 | ~1K | ~10K |
| API instances | 2-4 | 4-10 | 10-50 |

### Migration Path

**Phase 1 (now → 10K sessions):** Single PostgreSQL, single Redis, single API instance. Everything works out of the box.

**Phase 2 (10K → 100K):** Add PgBouncer, read replica for admin, Redis Cluster (4 shards), auto-scaling API (2-10 instances).

**Phase 3 (100K → 1M+):** Partition sessions table, Redis Cluster (16 shards), dedicated event ingest workers (separate from API), S3 batch archiver (SQS queue), CDN for dashboard SSE (CloudFront + WebSocket API Gateway).

---

## Engineering Standards

From `SWE_excellence_framework.md`:
- Every external call in try/catch with deterministic fallback (Section B.4)
- File operations use atomic write pattern (temp + rename) (Section J.1)
- No N+1 patterns in loops (Section B.1)
- Consistent error envelope: `{ error: { code, message, requestId } }` (Section B.2)
- Rate limiting fails closed (Section B.2.3)
- Idempotent session creation (same path + TTL = same session if active) (Section B.2.4)
- No `eval()`, `exec()`, or `new Function()` (Section K.1)
- No hardcoded secrets, tokens, or credentials (Section H.1)
- Every function gets a behavioral test (Appendix)
- File permissions: 0o600 for session data (Section K.1)
- Session TTL enforced — no stale sessions accumulating (Section J.1)
- Stream file rotation at 10K events — no unbounded growth (Section B.5)

From `AGENTS.md`:
- Full autonomous execution — do NOT ask for permission
- Plan first for non-trivial tasks (write to `tasks/todo.md`)
- Verify before marking done — run tests, demonstrate correctness
- After ANY correction: update `tasks/lessons.md` with the pattern
- Simplicity first — make every change as simple as possible

---

## Agent Notification System

**Problem:** Agents running in autonomous loops won't see new session messages unless they actively poll. Need a way to notify an agent that a message arrived.

**Solution: File-based notification + polling**

#### `src/session/notify.js`
```javascript
// Pattern: src/utils/teammateMailbox.ts (inbox poller from shared src/)

// Notification file: .sentinelayer/sessions/{id}/notify/{agent-id}.pending
// Contains: count of unread messages since last read

export async function notifyAgent(sessionId, targetAgentId)
// → creates/updates .pending file with unread count + latest event summary
// → called automatically by appendToStream() when message mentions @agent-id
//   or when event type is "help_request" or "daemon_alert"

export async function checkNotifications(sessionId, agentId)
// → reads .pending file, returns { unread: number, latestSummary: string }
// → deletes .pending file after read (consume-once)
// → returns { unread: 0 } if no pending file

export async function pollNotifications(sessionId, agentId, { intervalMs = 5000, signal })
// → async generator that yields notifications as they arrive
// → polls .pending file every 5 seconds
// → agent can run this in background: for await (const n of pollNotifications(...)) { ... }
```

#### How agents use it:

**Option A: CLI poll (simple, works with any agent)**
```bash
# Agent checks for notifications every few minutes
sl session read <id> --tail 5 --json
# If unread > 0, process messages
```

**Option B: Background notification file watch (for agents that support it)**
```javascript
// Agent spawns background watcher:
// fs.watchFile('.sentinelayer/sessions/{id}/notify/{my-id}.pending', ...)
// On change: read latest events, act on them
```

**Option C: @mention routing**
When `sl session say <id> "@codex-c3d4 can you review auth.js?"`:
1. Stream parser detects `@codex-c3d4` mention
2. Creates notification file for `codex-c3d4`
3. Next time codex-c3d4 polls or checks, it sees the message

The AGENTS_SESSION_GUIDE.md tells agents to periodically run `sl session read` — this is the simplest cross-platform approach that works with Claude Code, Codex, Cursor, or any agent.

---

## E2E Encryption

**All session data is encrypted at rest.** Stream events, blackboard entries, and agent snapshots are encrypted before writing to disk.

#### Encryption scheme:
```javascript
// Pattern: src/auth/session-store.js (AES-256-GCM with per-session key)

// On session create:
// 1. Generate session encryption key: crypto.randomBytes(32)
// 2. Store key in OS keyring: keytar.setPassword('sl-session', sessionId, key.toString('base64'))
// 3. If keyring unavailable: encrypt key with user's credentials.key and store in metadata

// On stream append:
// 1. Load session key from keyring (or decrypt from metadata)
// 2. Encrypt event JSON: AES-256-GCM with random 12-byte IV
// 3. Write: base64(iv) + "." + base64(ciphertext) + "." + base64(tag) + "\n"

// On stream read:
// 1. Load session key
// 2. Split line on "."
// 3. Decrypt: AES-256-GCM with IV and tag
// 4. Parse JSON

// On S3 archive:
// Session key is included in the archive (encrypted with a master archive key
// stored in AWS Secrets Manager). Training data pipeline decrypts with master key.
```

#### `src/session/crypto.js`
```javascript
// Pattern: src/auth/session-store.js (encryptToken / decryptToken)

export function encryptEvent(eventJson, sessionKey)
// → "base64iv.base64ciphertext.base64tag"

export function decryptEvent(encryptedLine, sessionKey)
// → parsed JSON object

export async function loadSessionKey(sessionId)
// → Buffer (32 bytes) from keyring or encrypted metadata

export async function createSessionKey(sessionId)
// → generates key, stores in keyring, returns Buffer
```

#### Why E2E encryption matters:
- Session streams contain agent communications, findings, file paths, and codebase context
- If `.sentinelayer/` is accidentally committed or shared, stream content is unreadable
- S3 archives are encrypted at rest (AWS SSE) + the session key adds a second layer
- Only agents with access to the local keyring (same machine) can read the stream
- Remote agents (future: cross-machine sessions) would use key exchange via SentinelLayer API

---

## Security Constraints

- Session files live in `.sentinelayer/sessions/` which is in `.gitignore` — never committed
- **All stream data is AES-256-GCM encrypted at rest** with per-session keys
- Session keys stored in OS keyring (preferred) or encrypted file fallback
- No tokens, secrets, or credentials in stream events — agent IDs are opaque short identifiers
- Session TTL default: 24 hours, auto-renewable to max 72 hours
- S3 archives double-encrypted: session key (AES-256-GCM) + AWS SSE-S3
- Stream append is file-locked: no corruption from concurrent writers
- Daemon LLM calls use existing `sentinelayer_token` via proxy — no new credentials
- `sl session say` sanitizes message: strip control characters, truncate to 2000 chars, reject if contains credential patterns (`sk-`, `ghp_`, `Bearer `)
- Agent IDs are not predictable — 4-char random hex suffix prevents enumeration
- Sessions are scoped to a single codebase path — no cross-repo access
- Notification files contain only unread count + summary, not full message content

---

## Success Criteria

1. `sl session start --json` creates session with codebase synopsis in <2s
2. `sl session join <id> --name codex-1 --json` registers agent and receives context briefing
3. `sl session say <id> "message"` appends to encrypted stream with file locking (no corruption under 3 concurrent writers)
4. `sl session read <id> --tail 20 --json` decrypts and returns last 20 events in <100ms
5. `sl session read <id> --follow` tails new events in real-time (within 1s of write)
6. `sl session status <id>` shows elapsed timer ("Session active for 2h 14m"), agents, and health
7. Daemon detects idle agent after 90s and emits `daemon_alert`
8. Daemon detects file conflict when two agents report same file within 60s
9. Daemon auto-responds to `help_request` within 30s if no other agent responds
10. Daemon auto-renews session if >10 events in last hour before expiry (max 72h total)
11. Expired sessions archived to S3 with double encryption (session key + AWS SSE)
12. `@agent-id` mentions create notification files that agents discover on next poll
13. `sl session provision-emails <id> --count 5` provisions 5 AIdenID emails in parallel
14. All stream data AES-256-GCM encrypted at rest with per-session keys
15. Spec builder embeds Coordination Protocol phase when multi-agent detected
16. Generated AGENT_HANDOFF_PROMPT includes session participation instructions
17. `.sentinelayer/AGENTS_SESSION_GUIDE.md` generated in scaffold output
18. File lock prevents two agents editing same file — lock/unlock with 5min TTL
19. `sl session say <id> "assign: @claude-1 fix P2s"` creates trackable task assignment
20. `sl session setup-guides <id>` generates coordination rules in AGENTS.md and CLAUDE.md
21. Session analytics computed on archive: messages, agents, findings, conflicts prevented, efficiency
22. S3 archive includes analytics.json sidecar (aggregate metrics, no PII, unencrypted for training)
23. sentinelayer.com/dashboard/sessions/:id shows live SSE stream of session events
24. Human can type in dashboard chat → message delivered to all agents with `priority: "high"`
25. Human messages rate-limited (10/min), sanitized, tagged `source: "human"`
26. `sl session start --template code-review` prints agent launch commands for each role
27. Agent performance scoring computed from session analytics (findings/dollar, completion rate, conflicts)
28. Auto-recap on join includes pending tasks, file locks, and recent findings specific to joining agent
29. Admin dashboard at `/admin/sessions` shows: stat cards, paginated session list, search bar, error stream
30. Search works by session ID, agent name, IP, username
31. Every API response includes `X-Request-Id` header, every error logged with `request_id`
32. Per-session kill switch via dashboard button or `sl session admin-kill <id>`
33. Global kill switch via dashboard button (double-confirm) or `sl session admin-kill-all --confirm`
34. Session stat cards show: active, stale (>1h idle), abandoned (expired without archive), killed
35. Session connection states tracked: active (heartbeating), stale (idle >1h), abandoned (expired), killed, archived
36. All session errors appear in admin error stream with requestId + sessionId + agentId
37. Alembic migration 047 creates sessions, session_agents, session_errors tables
38. All session data in `.sentinelayer/sessions/` locally — nothing in git
39. All session metadata synced to API for admin visibility — fire-and-forget, non-blocking
40. All tests pass, Omar Gate clean (0 P0, 0 P1)
41. Standardized event schema used by ALL event emitters (PR 0 verified)

**Build the coordination layer that makes AI agents work together instead of stepping on each other. This is Slack for AI coding agents — governed, auditable, observable, human-in-the-loop, and a moat nobody else can replicate.**
