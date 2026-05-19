# Architect Recap Spec

Date: 2026-05-19
Owner: Codex
Status: draft for Claude/Omar review

## Problem

Polling agents and humans lose the thread in long Senti sessions. A recap must summarize not only recent chat, but also the operating state: active peers, finding counts, locks, assigned work, owner state, and recent task transitions.

## Current State

- CLI emits `context_briefing` on join.
- CLI can emit `session_recap` periodically.
- `session/tasks.js` maintains a local task ledger with `PENDING`, `ACCEPTED`, `COMPLETED`, and `BLOCKED` states.
- This PR upgrades recap payloads to include task ownership summary from the existing task ledger.

## Recap Event Contract

```json
{
  "event": "session_recap",
  "agent": { "id": "senti", "model": "gpt-5.4-mini" },
  "payload": {
    "mode": "periodic",
    "recap": "short human-readable status",
    "ephemeral": true,
    "style": "italic-grey",
    "generatedAt": "2026-05-19T09:00:00.000Z"
  }
}
```

`buildSessionRecap()` returns richer JSON for machines:

```json
{
  "summary": {
    "activeAgents": 2,
    "activeAgentIds": ["codex", "claude-verifier"],
    "totalFindings": { "P0": 0, "P1": 1, "P2": 3, "P3": 0 },
    "activeLocks": 1,
    "pendingTasksForAgent": 1,
    "taskLedger": {
      "total": 4,
      "active": 2,
      "pending": 1,
      "accepted": 1,
      "blocked": 0,
      "completed": 2,
      "owners": [
        { "agentId": "codex", "active": 1, "accepted": 1 },
        { "agentId": "claude-verifier", "active": 1, "pending": 1 }
      ],
      "recent": [
        { "taskId": "task-abc", "status": "ACCEPTED", "priority": "P1", "owner": "codex" }
      ]
    }
  }
}
```

## Cadence

Defaults stay conservative:

- Join briefing: emitted once per agent join.
- Periodic recap: every 5 minutes while the session is active.
- Activity recap: emit when more than 5 relevant events arrived since the agent last read.
- Stop condition: stop periodic recap after 10 minutes of source-event inactivity.
- Listener etiquette: background polling should usually be 60 seconds or slower unless active human traffic is present.

Future API-backed recaps can use a "whichever first" policy: 10 minutes or 25 new durable events.

## Content Rules

- Keep text short enough to scan in chat.
- Include task owners and active task counts when a ledger exists.
- Exclude Senti recap/context events from the activity window to avoid recap loops.
- Never include raw prompt dumps, secret-looking substrings, or full files.
- Summaries are advisory; durable transcript events remain source of truth.

## PR Batches

1. `REC-1` CLI task-ledger recap summary. This is the current PR.
2. `REC-2` CLI command surface: `sl session recap now --json` for deterministic manual checks.
3. `REC-3` Web checkpoint/recap rail: filter recaps, jump to source event, and show compact recap cards.
4. `REC-4` API-backed recap projection: durable summary rows and rate-limited generation endpoint.
5. `REC-5` Evaluation: long-session fixtures proving no repeated stale recap loops.

## Acceptance

- A joining agent can identify current owners and pending work without reading hundreds of messages.
- A human can see whether agents are idle, blocked, or actively assigned.
- Recap generation is idempotent enough for polling loops and does not spam the session.
- Recap text and JSON stay useful even when the task ledger is missing.
