// Unit tests for live LLM-interaction usage emission + aggregation.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";
import { aggregateSessionUsage, emitLLMInteraction } from "../src/session/usage.js";
import { buildTranscriptMarkdown } from "../src/session/transcript.js";

async function makeRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "session-usage-"));
}

test("emitLLMInteraction writes a session_usage event with mirrored payload.usage", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    const result = await emitLLMInteraction(created.sessionId, {
      agentId: "claude-1",
      agentModel: "claude-opus-4-7",
      role: "coder",
      inputTokens: 1200,
      outputTokens: 800,
      costUsd: 0.0156,
      durationMs: 4321,
      prompt: "review this file",
      response: "Looks good. Two suggestions.",
      targetPath: root,
    });
    assert.equal(result.totalTokens, 2000);
    assert.equal(result.event, "session_usage");

    const events = await readStream(created.sessionId, { targetPath: root, tail: 0 });
    const usage = events.find((e) => e.event === "session_usage");
    assert.ok(usage, "session_usage event must be appended");
    assert.equal(usage.payload.totalTokens, 2000);
    assert.equal(usage.payload.usage.totalTokens, 2000);
    assert.equal(usage.payload.usage.costUsd, 0.0156);
    assert.equal(usage.payload.response.text, "Looks good. Two suggestions.");
    assert.equal(usage.payload.durationMs, 4321);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("emitLLMInteraction clips very long prompts/responses but preserves token counts", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    const longText = "x".repeat(10_000);
    const result = await emitLLMInteraction(created.sessionId, {
      agentId: "codex-1",
      agentModel: "gpt-5.3-codex",
      inputTokens: 5000,
      outputTokens: 5000,
      costUsd: 0.04,
      prompt: longText,
      response: longText,
      targetPath: root,
    });
    assert.equal(result.totalTokens, 10_000);
    const events = await readStream(created.sessionId, { targetPath: root, tail: 0 });
    const usage = events.find((e) => e.event === "session_usage");
    // Token counts unchanged; response/prompt text clipped to ~4000 chars.
    assert.equal(usage.payload.totalTokens, 10_000);
    assert.ok(usage.payload.response.text.length <= 4001);
    assert.ok(usage.payload.response.text.endsWith("…"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("aggregateSessionUsage rolls up per-agent + global totals", () => {
  const events = [
    { event: "session_message", agent: { id: "carter" }, payload: { message: "go" } },
    {
      event: "session_usage",
      agent: { id: "claude-1" },
      payload: {
        agentId: "claude-1",
        model: "claude-opus-4-7",
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.012,
      },
    },
    {
      event: "session_usage",
      agent: { id: "claude-1" },
      payload: {
        agentId: "claude-1",
        model: "claude-opus-4-7",
        totalTokens: 800,
        inputTokens: 500,
        outputTokens: 300,
        costUsd: 0.006,
      },
    },
    {
      event: "session_usage",
      agent: { id: "codex-2" },
      payload: {
        agentId: "codex-2",
        model: "gpt-5.3-codex",
        totalTokens: 2200,
        inputTokens: 1500,
        outputTokens: 700,
        costUsd: 0.022,
      },
    },
  ];
  const agg = aggregateSessionUsage(events);
  assert.equal(agg.totals.totalTokens, 4500);
  assert.equal(agg.totals.interactions, 3);
  assert.equal(agg.totals.costUsd, 0.04);
  const claude = agg.perAgent.get("claude-1");
  assert.equal(claude.totalTokens, 2300);
  assert.equal(claude.interactions, 2);
  const codex = agg.perAgent.get("codex-2");
  assert.equal(codex.totalTokens, 2200);
  assert.equal(codex.interactions, 1);
});

test("transcript renders session_usage as agent response + rolls up tokens", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    await emitLLMInteraction(created.sessionId, {
      agentId: "claude-1",
      agentModel: "claude-opus-4-7",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      prompt: "test",
      response: "Here is the answer.",
      targetPath: root,
    });
    const events = await readStream(created.sessionId, { targetPath: root, tail: 0 });
    const { markdown, stats } = buildTranscriptMarkdown({
      sessionMeta: { sessionId: created.sessionId, createdAt: new Date().toISOString() },
      events,
    });
    assert.equal(stats.totals.tokenTotal, 1500);
    assert.match(markdown, /Here is the answer\./);
    // Tokens line in header
    assert.match(markdown, /Tokens: 1,500/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
