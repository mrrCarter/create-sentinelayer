import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { countPricedUsageEvents } from "../src/billing/ledger-entry.js";
import {
  INVESTOR_DD_USAGE_ACTIONS,
  InvestorDdUsageLedgerError,
  recordInvestorDdLlmUsage,
} from "../src/review/investor-dd-usage.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function makeRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "investor-dd-usage-"));
}

test("recordInvestorDdLlmUsage records returned DD planner usage without raw prompt metadata", async () => {
  const calls = [];
  const result = await recordInvestorDdLlmUsage({
    usageContext: {
      sessionId: "sess-dd",
      targetPath: "C:/repo",
      model: "gpt-5.3-codex",
      provider: "sentinelayer",
      syncRemote: false,
      recorder: async (payload) => {
        calls.push(payload);
        return {
          ok: true,
          ledgerEntry: { ledgerEntryId: "bill_test" },
        };
      },
    },
    action: INVESTOR_DD_USAGE_ACTIONS.devTestBotPlanner,
    agentId: "investor-dd-devtestbot-planner",
    phase: "devtestbot_planner",
    prompt: "Plan browser runtime evidence for auth flows",
    response: {
      text: '{"swarmCount":1,"identityCount":1,"scope":"auth"}',
      usage: {
        inputTokens: 42,
        outputTokens: 9,
        model: "gpt-5.3-codex",
        provider: "sentinelayer",
      },
    },
    metadata: {
      prompt: "must not be stored",
      safe: "kept",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "sess-dd");
  assert.equal(calls[0].agentId, "investor-dd-devtestbot-planner");
  assert.equal(calls[0].action, "investor_dd_devtestbot_planner");
  assert.equal(calls[0].inputTokens, 42);
  assert.equal(calls[0].outputTokens, 9);
  assert.equal(calls[0].metadata.phase, "devtestbot_planner");
  assert.equal(calls[0].metadata.safe, "kept");
  assert.equal(calls[0].metadata.prompt, undefined);
});

test("recordInvestorDdLlmUsage is optional when no session usage context is supplied", async () => {
  const result = await recordInvestorDdLlmUsage({
    usageContext: null,
    action: INVESTOR_DD_USAGE_ACTIONS.filePlanner,
    agentId: "investor-dd-security",
    prompt: "review",
    response: "done",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_session_usage_context");
});

test("recordInvestorDdLlmUsage writes DD planner events into the default priced rollup", async () => {
  const root = await makeRoot();
  try {
    await createSession({
      targetPath: root,
      sessionId: "sess-dd-priced",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const result = await recordInvestorDdLlmUsage({
      usageContext: {
        sessionId: "sess-dd-priced",
        targetPath: root,
        model: "gpt-5.3-codex",
        provider: "sentinelayer",
        syncRemote: false,
      },
      action: INVESTOR_DD_USAGE_ACTIONS.filePlanner,
      agentId: "investor-dd-security",
      phase: "persona_file_loop",
      response: {
        text: "done",
        usage: {
          inputTokens: 25,
          outputTokens: 7,
          model: "gpt-5.3-codex",
          provider: "sentinelayer",
        },
      },
      metadata: {
        prompt: "raw prompt must not persist",
        response: "raw response must not persist",
        personaId: "security",
      },
    });

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.action, "investor_dd_file_planner");

    const events = await readStream("sess-dd-priced", { targetPath: root, tail: 0 });
    const usageEvents = events.filter((event) => event.event === "session_usage");
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].payload.schema, "billing/v1");
    assert.equal(usageEvents[0].payload.action, "investor_dd_file_planner");
    assert.equal(usageEvents[0].payload.agentId, "investor-dd-security");
    assert.equal(usageEvents[0].payload.usage.totalTokens, 32);
    assert.equal(usageEvents[0].payload.prompt, undefined);
    assert.equal(usageEvents[0].payload.response, undefined);
    assert.equal(usageEvents[0].payload.metadata.prompt, undefined);
    assert.equal(usageEvents[0].payload.metadata.response, undefined);
    assert.equal(countPricedUsageEvents(events), 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("recordInvestorDdLlmUsage does not estimate missing provider usage", async () => {
  const calls = [];
  const result = await recordInvestorDdLlmUsage({
    usageContext: {
      sessionId: "sess-dd",
      model: "gpt-5.3-codex",
      syncRemote: false,
      recorder: async (payload) => {
        calls.push(payload);
        return { ok: true };
      },
    },
    action: INVESTOR_DD_USAGE_ACTIONS.filePlanner,
    agentId: "investor-dd-security",
    response: { text: "done" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_provider_usage");
  assert.equal(calls.length, 0);
});

test("recordInvestorDdLlmUsage fails closed when required provider usage is missing", async () => {
  await assert.rejects(
    () => recordInvestorDdLlmUsage({
      usageContext: {
        sessionId: "sess-dd",
        required: true,
        model: "gpt-5.3-codex",
        syncRemote: false,
        recorder: async () => ({ ok: true }),
      },
      action: INVESTOR_DD_USAGE_ACTIONS.filePlanner,
      agentId: "investor-dd-security",
      response: { text: "done" },
    }),
    (error) => {
      assert.equal(error instanceof InvestorDdUsageLedgerError, true);
      assert.equal(error.result?.reason, "missing_provider_usage");
      return true;
    },
  );
});

test("recordInvestorDdLlmUsage throws when required ledger recording fails", async () => {
  await assert.rejects(
    () => recordInvestorDdLlmUsage({
      usageContext: {
        sessionId: "sess-dd",
        required: true,
        recorder: async () => ({ ok: false, reason: "api_503" }),
      },
      action: INVESTOR_DD_USAGE_ACTIONS.filePlanner,
      agentId: "investor-dd-security",
      model: "gpt-5.3-codex",
      prompt: "review",
      response: {
        text: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          model: "gpt-5.3-codex",
        },
      },
    }),
    (error) => {
      assert.equal(error instanceof InvestorDdUsageLedgerError, true);
      assert.equal(error.code, "INVESTOR_DD_USAGE_LEDGER_FAILED");
      assert.match(error.message, /api_503/);
      return true;
    },
  );
});
