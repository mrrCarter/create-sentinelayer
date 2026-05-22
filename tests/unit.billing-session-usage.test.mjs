import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeProviderCost } from "../src/billing/price-book.js";
import {
  buildBillingRunId,
  buildCallIdempotencyKey,
  buildLedgerEntry,
  countPricedUsageEvents,
} from "../src/billing/ledger-entry.js";
import { recordCliLlmSessionUsage } from "../src/billing/llm-session-usage.js";
import { recordSessionUsage } from "../src/billing/session-usage.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function makeRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "billing-session-usage-"));
}

test("Unit billing price book: computes known, unknown, and zero-token costs", () => {
  const codex = computeProviderCost({
    model: "gpt-5.3-codex",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  assert.equal(codex.providerCostUsd, 15.75);
  assert.equal(codex.unpriced, false);

  const zero = computeProviderCost({
    model: "gpt-4.1-mini",
    inputTokens: 0,
    outputTokens: 0,
  });
  assert.equal(zero.providerCostUsd, 0);
  assert.equal(zero.unpriced, false);

  const unknown = computeProviderCost({
    model: "unknown-model",
    inputTokens: 100,
    outputTokens: 50,
  });
  assert.equal(unknown.providerCostUsd, null);
  assert.equal(unknown.unpriced, true);
});

test("Unit billing ledger: deterministic ids and metadata sanitization", () => {
  const createdAt = "2026-05-19T12:00:00.000Z";
  const runId = buildBillingRunId({
    sessionId: "sess-billing",
    invocationTimestamp: createdAt,
    configHash: "cfg-hash",
  });
  const idempotencyKey = buildCallIdempotencyKey({ runId, callIndex: 0 });
  const secretLike = ["sk", "x".repeat(24)].join("-");
  const first = buildLedgerEntry({
    sessionId: "sess-billing",
    agentId: "audit-orchestrator",
    action: "audit_run",
    model: "gpt-5.3-codex",
    inputTokens: 1000,
    outputTokens: 2000,
    idempotencyKey,
    createdAt,
    metadata: {
      sourceCommand: "review",
      prompt: "raw prompt must not persist",
      response: "raw response must not persist",
      text: "raw text must not persist",
      nested: { apiKey: secretLike },
    },
  });
  const second = buildLedgerEntry({
    sessionId: "sess-billing",
    agentId: "audit-orchestrator",
    action: "audit_run",
    model: "gpt-5.3-codex",
    inputTokens: 1000,
    outputTokens: 2000,
    idempotencyKey,
    createdAt,
    metadata: {
      sourceCommand: "review",
      prompt: "raw prompt must not persist",
      response: "raw response must not persist",
      text: "raw text must not persist",
      nested: { apiKey: secretLike },
    },
  });

  assert.deepEqual(first, second);
  assert.match(first.ledgerEntryId, /^bill_[a-f0-9]{16}$/);
  assert.equal(first.metadata.sourceCommand, "review");
  assert.equal("prompt" in first.metadata, false);
  assert.equal("response" in first.metadata, false);
  assert.equal("text" in first.metadata, false);
  assert.equal(first.metadata.nested.apiKey, "[REDACTED]");

  const third = buildLedgerEntry({
    sessionId: "sess-billing",
    agentId: "audit-orchestrator",
    action: "audit_run",
    model: "gpt-5.3-codex",
    idempotencyKey: `${idempotencyKey}:retry2`,
    createdAt,
  });
  assert.notEqual(first.ledgerEntryId, third.ledgerEntryId);
});

test("Unit billing session usage: persists billing/v1 events without raw prompt text", async () => {
  const root = await makeRoot();
  try {
    const createdAt = new Date().toISOString();
    const created = await createSession({
      targetPath: root,
      sessionId: "sess-billing",
      createdAt,
    });
    const first = await recordSessionUsage(
      created.sessionId,
      {
        agentId: "audit-orchestrator",
        action: "audit_run",
        model: "gpt-5.3-codex",
        inputTokens: 1000,
        outputTokens: 2000,
        idempotencyKey: "audit-run-0",
        createdAt,
        metadata: {
          prompt: "do not store",
          response: "do not store",
          sourceCommand: "review",
        },
      },
      { targetPath: root, syncRemote: false },
    );
    const second = await recordSessionUsage(
      created.sessionId,
      {
        agentId: "audit-orchestrator",
        action: "audit_run",
        model: "gpt-5.3-codex",
        inputTokens: 1000,
        outputTokens: 2000,
        idempotencyKey: "audit-run-0",
        createdAt,
        metadata: {
          prompt: "do not store",
          response: "do not store",
          sourceCommand: "review",
        },
      },
      { targetPath: root, syncRemote: false },
    );

    assert.deepEqual(first.ledgerEntry, second.ledgerEntry);
    const events = await readStream(created.sessionId, { targetPath: root, tail: 0 });
    const usageEvents = events.filter((event) => event.event === "session_usage");
    assert.equal(usageEvents.length, 2);
    assert.equal(usageEvents[0].payload.schema, "billing/v1");
    assert.equal(usageEvents[0].payload.usage.totalTokens, 3000);
    assert.equal(usageEvents[0].payload.prompt, undefined);
    assert.equal(usageEvents[0].payload.response, undefined);
    assert.equal(usageEvents[0].payload.metadata.prompt, undefined);
    assert.equal(countPricedUsageEvents(events), 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit billing session usage: CLI LLM helper emits priced command actions", async () => {
  const root = await makeRoot();
  try {
    const createdAt = "2026-05-22T08:00:00.000Z";
    await createSession({
      targetPath: root,
      sessionId: "sess-cli-llm",
      createdAt,
    });

    const result = await recordCliLlmSessionUsage({
      sessionId: "sess-cli-llm",
      agentId: "chat-cli",
      action: "chat_ask",
      model: "gpt-5.3-codex",
      inputTokens: 500,
      outputTokens: 120,
      startedAtIso: createdAt,
      targetPath: root,
      sourceCommand: "chat ask",
      provider: "openai",
      metadata: {
        prompt: "raw prompt must not persist",
        response: "raw response must not persist",
        safe: "keep",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ledgerEntry.action, "chat_ask");
    assert.equal(result.ledgerEntry.agentId, "chat-cli");
    assert.equal(result.ledgerEntry.metadata.safe, "keep");
    assert.equal(result.ledgerEntry.metadata.prompt, undefined);
    assert.equal(result.ledgerEntry.metadata.response, undefined);

    const events = await readStream("sess-cli-llm", { targetPath: root, tail: 0 });
    const usageEvents = events.filter((event) => event.event === "session_usage");
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].payload.action, "chat_ask");
    assert.equal(usageEvents[0].payload.usage.totalTokens, 620);
    assert.equal(countPricedUsageEvents(events), 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
