// Unit tests for the per-file review loop library (#investor-dd-2).

import test from "node:test";
import assert from "node:assert/strict";

import {
  runPerFileReviewLoop,
  createBudgetState,
  checkBudget,
  INVESTOR_DD_DEFAULT_MAX_TURNS_PER_FILE,
  INVESTOR_DD_DEFAULT_STUCK_THRESHOLD,
} from "../src/review/investor-dd-file-loop.js";

/**
 * Stub LLM client that returns a scripted plan per invocation. Supports
 * tool-call turns followed by an end-turn.
 */
function scriptedClient(scripts) {
  const perFileCounters = new Map();
  return {
    generatePlan: async (messages) => {
      const lastUser = messages.find((m) => m.role === "user");
      const fileHint =
        lastUser && typeof lastUser.content === "string"
          ? lastUser.content.match(/FILE:(\S+)/)?.[1] || "unknown"
          : "unknown";
      const nextTurn = (perFileCounters.get(fileHint) ?? 0) + 1;
      perFileCounters.set(fileHint, nextTurn);
      const fileScript = scripts[fileHint] || scripts["*"] || [];
      const plan = fileScript[nextTurn - 1] || { stopReason: "end-turn" };
      return plan;
    },
  };
}

test("createBudgetState seeds counters", () => {
  const b = createBudgetState({ maxUsd: 10, maxRuntimeMs: 60_000 });
  assert.equal(b.spentUsd, 0);
  assert.equal(b.toolCalls, 0);
  assert.equal(b.llmCalls, 0);
  assert.equal(b.maxUsd, 10);
  assert.equal(b.maxRuntimeMs, 60_000);
  assert.ok(Number.isFinite(b.startedAtMs));
});

test("checkBudget trips on cost exhaustion", () => {
  const b = createBudgetState({ maxUsd: 1 });
  b.spentUsd = 1.5;
  const check = checkBudget(b);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "budget-cost-exhausted");
});

test("checkBudget trips on runtime exhaustion", () => {
  const b = createBudgetState({ maxRuntimeMs: 10 });
  b.startedAtMs = Date.now() - 100;
  const check = checkBudget(b);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "budget-runtime-exhausted");
});

test("checkBudget ok when no caps", () => {
  const b = createBudgetState();
  assert.deepEqual(checkBudget(b), { ok: true });
});

test("checkBudget tolerates null", () => {
  assert.deepEqual(checkBudget(null), { ok: true });
});

test("runPerFileReviewLoop visits every file and accumulates findings", async () => {
  const client = scriptedClient({
    "a.js": [
      {
        stopReason: "tool-use",
        content: "reading",
        toolCalls: [{ name: "read-file", input: { path: "a.js" } }],
        findings: [],
      },
      {
        stopReason: "end-turn",
        content: "found one",
        toolCalls: [],
        findings: [{ id: "A1", severity: "P1", kind: "test" }],
      },
    ],
    "b.js": [
      {
        stopReason: "end-turn",
        content: "clean",
        toolCalls: [],
        findings: [{ id: "B1", severity: "P2", kind: "test" }],
      },
    ],
  });

  const events = [];
  const result = await runPerFileReviewLoop({
    personaId: "nina",
    files: ["a.js", "b.js"],
    client,
    buildTools: () => [{ name: "read-file", invoke: async () => "contents" }],
    buildInitialMessages: (file) => [{ role: "user", content: `FILE:${file}` }],
    budget: createBudgetState(),
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.personaId, "nina");
  assert.equal(result.visited.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.findings.length, 2);
  assert.equal(result.terminationReason, "ok");
  assert.ok(result.findings.every((f) => f.personaId === "nina"));
  assert.ok(result.findings.some((f) => f.file === "a.js" && f.id === "A1"));
  assert.ok(result.findings.some((f) => f.file === "b.js" && f.id === "B1"));

  const eventTypes = events.map((e) => e.type);
  assert.ok(eventTypes.includes("persona_file_start"));
  assert.ok(eventTypes.includes("persona_file_complete"));
  assert.ok(eventTypes.includes("persona_finding"));
});

test("runPerFileReviewLoop stops early when cost budget exhausts", async () => {
  const client = scriptedClient({
    "*": [{ stopReason: "end-turn", content: "clean", toolCalls: [], findings: [] }],
  });
  const budget = createBudgetState({ maxUsd: 0.001 });
  // Pre-spend so first file finishes but budget is trip before second.
  budget.spentUsd = 0.002;

  const result = await runPerFileReviewLoop({
    personaId: "ethan",
    files: ["a.js", "b.js", "c.js"],
    client,
    buildTools: () => [],
    buildInitialMessages: () => [{ role: "user", content: "" }],
    budget,
  });

  assert.equal(result.terminationReason, "budget-cost-exhausted");
  assert.equal(result.visited.length, 0);
  assert.equal(result.skipped.length, 3);
});

test("runPerFileReviewLoop meters tool calls against budget", async () => {
  const client = scriptedClient({
    "*": [
      {
        stopReason: "tool-use",
        content: "read",
        toolCalls: [{ name: "read-file", input: { path: "x.js" } }],
        findings: [],
      },
      { stopReason: "end-turn", content: "done", toolCalls: [], findings: [] },
    ],
  });
  const budget = createBudgetState({ maxUsd: 10 });

  await runPerFileReviewLoop({
    personaId: "priya",
    files: ["x.js"],
    client,
    buildTools: () => [
      { name: "read-file", costUsd: 0.25, invoke: async () => "file contents" },
    ],
    buildInitialMessages: () => [{ role: "user", content: "FILE:x.js" }],
    budget,
  });

  assert.equal(budget.toolCalls, 1);
  assert.ok(budget.llmCalls >= 1);
  assert.equal(budget.spentUsd, 0.25);
});

test("runPerFileReviewLoop records client error and continues", async () => {
  let call = 0;
  const client = {
    generatePlan: async () => {
      call += 1;
      if (call === 1) throw new Error("llm-down");
      return { stopReason: "end-turn", content: "ok", toolCalls: [], findings: [] };
    },
  };

  const events = [];
  const result = await runPerFileReviewLoop({
    personaId: "maya",
    files: ["a.js", "b.js"],
    client,
    buildTools: () => [],
    buildInitialMessages: () => [{ role: "user", content: "" }],
    budget: createBudgetState(),
    onEvent: (e) => events.push(e),
  });

  // Envelope catches the LLM error internally and returns stuckReason,
  // so both files "complete" from this loop's perspective, but file 1
  // exposes the client-error via its stopReason.
  assert.equal(result.visited.length, 2);
  assert.equal(result.perFile.length, 2);
  assert.equal(result.perFile[0].stopReason, "client-error");
  assert.equal(result.perFile[1].stopReason, null);
});

test("runPerFileReviewLoop rejects bad inputs", async () => {
  await assert.rejects(
    () => runPerFileReviewLoop({}),
    /personaId/,
  );
  await assert.rejects(
    () =>
      runPerFileReviewLoop({
        personaId: "x",
        files: "not-an-array",
        client: { generatePlan: async () => ({}) },
        buildTools: () => [],
        buildInitialMessages: () => [],
      }),
    /files array/,
  );
  await assert.rejects(
    () =>
      runPerFileReviewLoop({
        personaId: "x",
        files: [],
        client: {},
        buildTools: () => [],
        buildInitialMessages: () => [],
      }),
    /generatePlan/,
  );
});

test("defaults expose bounded turn + stuck thresholds", () => {
  assert.ok(INVESTOR_DD_DEFAULT_MAX_TURNS_PER_FILE >= 3);
  assert.ok(INVESTOR_DD_DEFAULT_MAX_TURNS_PER_FILE <= 20);
  assert.equal(INVESTOR_DD_DEFAULT_STUCK_THRESHOLD, 2);
});
