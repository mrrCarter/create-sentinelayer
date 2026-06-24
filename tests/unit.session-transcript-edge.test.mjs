import test from "node:test";
import assert from "node:assert/strict";

import { buildTranscriptMarkdown } from "../src/session/transcript.js";

function markdownSection(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `${heading} section must exist`);
  const next = markdown.indexOf("\n## ", start + 1);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

test("buildTranscriptMarkdown: ignores malformed transcript records without dropping valid usage ledger rows", () => {
  const { markdown, stats } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "edge-session" },
    events: [
      null,
      {},
      {
        event: "session_usage",
        agent: { id: "agent|pipe`tick", model: "gpt-5.3-codex" },
        ts: "2026-04-25T10:00:40.000Z",
        payload: {
          schema: "billing/v1",
          idempotencyKey: "edge-ledger-key-with-pipe|and`tick",
          agentId: "agent|pipe`tick",
          action: "download|ledger`edge",
          model: "gpt-5.3-codex",
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
            cost_usd: 0.000321,
          },
        },
      },
    ],
  });

  assert.equal(stats.totals.usageEntries, 1);
  assert.equal(stats.totals.tokenTotal, 20);
  const ledger = markdownSection(markdown, "Usage Ledger");
  assert.match(ledger, /^Accepted entries: 1$/m);
  assert.ok(ledger.includes("`agent\\|pipe'tick`"));
  assert.ok(ledger.includes("`download\\|ledger'edge`"));
  assert.ok(ledger.includes("edge-ledger-key-with-pipe"));
  assert.ok(ledger.includes("and'tick"));
});

test("buildTranscriptMarkdown: keeps zero-telemetry output stable for null-only event arrays", () => {
  const { markdown, stats } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "null-only" },
    events: [null, undefined, { payload: { message: "missing type" } }],
  });

  assert.equal(stats.totals.usageEntries, 0);
  assert.equal(stats.totals.tokenTotal, 0);
  assert.match(markdownSection(markdown, "Usage Ledger"), /^_No usage telemetry recorded\._$/m);
  assert.match(markdown, /^## Conversation$/m);
});

test("buildTranscriptMarkdown: bounds hostile usage ledger fields and ignores invalid nested payload shapes", () => {
  const hugeAgent = `agent-${"a".repeat(260)}`;
  const hugeAction = `download-${"b".repeat(260)}`;
  const hugeKey = `idem-${"c".repeat(260)}-tail`;
  const { markdown, stats } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "hostile-payloads" },
    events: [
      {
        event: "session_usage",
        agent: ["not", "an", "object"],
        payload: ["not", "an", "object"],
        ts: "2026-04-25T10:00:00.000Z",
      },
      {
        event: "session_usage",
        agent: { id: hugeAgent, model: "gpt-5.3-codex" },
        ts: "2026-04-25T10:00:01.000Z",
        sequenceId: 9,
        payload: {
          schema: "billing/v1",
          agentId: hugeAgent,
          action: hugeAction,
          model: "gpt-5.3-codex",
          idempotencyKey: hugeKey,
          prompt: "not an object",
          response: ["not", "an", "object"],
          usage: {
            input_tokens: "1",
            output_tokens: "2",
            total_tokens: "3",
            cost_usd: "0.000123",
          },
        },
      },
    ],
  });

  assert.equal(stats.totals.usageEntries, 1);
  assert.equal(stats.totals.tokenTotal, 3);
  const ledger = markdownSection(markdown, "Usage Ledger");
  assert.match(ledger, /^Accepted entries: 1$/m);
  assert.ok(!ledger.includes(hugeAgent));
  assert.ok(!ledger.includes(hugeAction));
  assert.ok(!ledger.includes(hugeKey));
  assert.match(ledger, /agent-a{20,}\.\.\.a{12,}/);
  assert.match(ledger, /download-b{20,}\.\.\.b{12,}/);
  assert.match(ledger, /idem-c{8,}\.\.\.c{4,}-tail/);
});

test("buildTranscriptMarkdown: bounds hostile session observation fields and tolerates malformed payloads", () => {
  const hugeSummary = `observation-${"s".repeat(4_500)}-tail`;
  const hugeProposal = `proposal-${"p".repeat(2_500)}-tail`;
  const hugeOwner = `owner-${"o".repeat(260)}-tail`;
  const hugeBatch = `batch-${"b".repeat(260)}-tail`;
  const hugeCursor = `cursor-${"c".repeat(260)}-tail`;

  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "observation-edge" },
    events: [
      {
        event: "session_observation",
        agent: { id: "codex", model: "gpt-5-codex" },
        ts: "2026-04-25T10:00:00.000Z",
        payload: ["not", "an", "object"],
      },
      {
        event: "session_observation",
        agent: { id: "codex", model: "gpt-5-codex" },
        ts: "2026-04-25T10:00:01.000Z",
        payload: {
          summary: hugeSummary,
          proposal: hugeProposal,
          severity: "p2|pipe`tick",
          kind: "ux|pipe`tick",
          owner: hugeOwner,
          proposedBatch: hugeBatch,
          targetCursor: hugeCursor,
        },
      },
    ],
  });

  const conversation = markdownSection(markdown, "Conversation");
  assert.match(conversation, /\*\*Observation:\*\* `info` · `process`/);
  assert.match(conversation, /\*\*Observation:\*\* `p2\\\|pipe'tick` · `ux\\\|pipe'tick`/);
  assert.ok(!conversation.includes(hugeSummary));
  assert.ok(!conversation.includes(hugeProposal));
  assert.ok(!conversation.includes(hugeOwner));
  assert.ok(!conversation.includes(hugeBatch));
  assert.ok(!conversation.includes(hugeCursor));
  assert.match(conversation, /observation-s{20,}\.\.\.s{20,}-tail/);
  assert.match(conversation, /proposal-p{20,}\.\.\.p{20,}-tail/);
  assert.match(conversation, /Owner: `owner-o{20,}\.\.\.o{12,}-tail`/);
  assert.match(conversation, /Batch: `batch-b{20,}\.\.\.b{12,}-tail`/);
  assert.match(conversation, /Target: `cursor cursor-c{20,}\.\.\.c{12,}-tail`/);
});
