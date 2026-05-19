# Architect Checkpoint Spec

Date: 2026-05-19
Owner: Codex
Status: draft for Claude/Omar review

## Problem

The dashboard can render checkpoint cards, but the product contract has to be stronger than "a card exists." A checkpoint must be a durable, auditable anchor in a long Senti session: what happened, which event range it covers, which agent created it, what token range it spans, and how a human or joining agent jumps back to the exact context.

## Current State

- API has `GET/POST /api/v1/sessions/{id}/checkpoints` and `POST /checkpoints/generate`.
- API markdown export renders checkpoint summaries with event anchor links.
- Web renders a checkpoint rail and asks `SessionStreamVirtualized` to load the event window ending at the checkpoint sequence.
- CLI context briefings and recaps exist, but no first-class CLI checkpoint command is guaranteed in the agent workflow.

## Contract

Checkpoint payloads are append-only session events with this minimum shape:

```json
{
  "event": "session_checkpoint",
  "agent": { "id": "senti", "model": "gpt-5.4-mini" },
  "payload": {
    "checkpointId": "cp_<stable-id>",
    "kind": "summary|handoff|milestone|billing",
    "title": "short label",
    "summary": "bounded markdown summary",
    "startSequence": 100,
    "endSequence": 180,
    "createdByAgentId": "codex",
    "tokenRange": { "start": 12000, "end": 18500 },
    "pricing": { "ledgerEntryId": "optional" }
  }
}
```

Rules:

- `checkpointId` is idempotent for the same session, creator, range, and body.
- `startSequence` and `endSequence` must refer to durable canonical sequence ids, not timestamp cursors.
- `summary` must not include raw secret-looking substrings; use the same redaction posture as export summaries.
- A generated checkpoint that cannot prove its source range must return a non-created result, not a vague success.
- Web selection must never trigger older-page pagination by accident; it loads a bounded anchor window and highlights the range.

## Restore Semantics

"Restore" means context restore, not database rollback.

1. Load checkpoint metadata.
2. Load a bounded transcript window around `startSequence..endSequence`.
3. Render checkpoint summary, source range, creator, token range, and adjacent transcript.
4. Let agents use the checkpoint as a context handoff in `context_briefing`.

No checkpoint may mutate or delete existing session events.

## Threat Model

- Forged checkpoint creator: API validates user/session access and grant identity where agent identity is claimed.
- XSS/markdown injection: web renders bounded markdown through the existing safe renderer path; do not add raw HTML.
- Secret leakage: generator redacts secret patterns before LLM calls or summaries.
- Replay/double-bill: generated checkpoint writes use idempotency keys and a stable checkpoint id.
- Large-session DOS: generation reads a bounded candidate window and times out cleanly.

## PR Batches

1. `CPK-1` Contract tests: API checkpoint idempotency, invalid ranges, markdown anchors, web anchor load.
2. `CPK-2` CLI surface: `sl session checkpoint create|generate|list` with JSON output and remote sync.
3. `CPK-3` Web polish: active range highlight, copy checkpoint link, empty/error copy for unavailable anchor windows.
4. `CPK-4` Billing tie-in: checkpoint ledger entry id and token range included in exports.

## Acceptance

- A 600+ event session can open a checkpoint and jump to the source range without loading every older page.
- Markdown export includes checkpoint summaries and working event anchors.
- A repeated generate request does not create duplicate checkpoints or duplicate billing entries.
- A joining agent can see the latest checkpoint context without rereading the whole transcript.
