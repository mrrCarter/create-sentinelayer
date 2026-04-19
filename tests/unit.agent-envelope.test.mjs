// Tests for src/agents/envelope/* (#A8 agent envelope foundation).

import test from "node:test";
import assert from "node:assert/strict";

import { runEnvelopeLoop, DEFAULT_MAX_TURNS, DEFAULT_STUCK_THRESHOLD } from "../src/agents/envelope/loop.js";
import { detectStuck } from "../src/agents/envelope/pulse.js";
import { runFixCycle } from "../src/agents/envelope/fix-cycle.js";
import { createEventStream } from "../src/agents/envelope/stream.js";

// ───────────────────────── pulse.detectStuck ─────────────────────────

test("detectStuck: empty history is not stuck", () => {
  assert.equal(detectStuck([], 2), false);
});

test("detectStuck: history shorter than threshold is not stuck", () => {
  assert.equal(detectStuck([{ turn: 1, hadToolCalls: false }], 2), false);
});

test("detectStuck: consecutive no-tool turns reaching threshold → stuck", () => {
  assert.equal(
    detectStuck([
      { turn: 1, hadToolCalls: false },
      { turn: 2, hadToolCalls: false },
    ], 2),
    true,
  );
});

test("detectStuck: tool call within threshold window resets", () => {
  assert.equal(
    detectStuck([
      { turn: 1, hadToolCalls: false },
      { turn: 2, hadToolCalls: true },
      { turn: 3, hadToolCalls: false },
    ], 2),
    false,
  );
});

test("detectStuck: trailing window of no-tool turns at threshold 3 → stuck", () => {
  assert.equal(
    detectStuck([
      { turn: 1, hadToolCalls: true },
      { turn: 2, hadToolCalls: false },
      { turn: 3, hadToolCalls: false },
      { turn: 4, hadToolCalls: false },
    ], 3),
    true,
  );
});

// ───────────────────────── runEnvelopeLoop ─────────────────────────

function makeClient(planScript) {
  let idx = 0;
  return {
    generatePlan: async () => {
      const plan = planScript[idx] ?? planScript[planScript.length - 1] ?? null;
      idx += 1;
      return plan;
    },
  };
}

test("runEnvelopeLoop: requires a client with generatePlan()", async () => {
  await assert.rejects(() => runEnvelopeLoop({ client: null }), /generatePlan/);
  await assert.rejects(() => runEnvelopeLoop({ client: {} }), /generatePlan/);
});

test("runEnvelopeLoop: end-turn stopReason exits after first turn", async () => {
  const client = makeClient([{ stopReason: "end-turn", content: "done" }]);
  const result = await runEnvelopeLoop({ client });
  assert.equal(result.turnsUsed, 1);
  assert.equal(result.stuckReason, null);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "assistant");
});

test("runEnvelopeLoop: exits via max-turns when no stop signal", async () => {
  const client = makeClient([{ stopReason: null, content: "…", toolCalls: [{ name: "x", input: {} }] }]);
  const result = await runEnvelopeLoop({
    client,
    tools: [{ name: "x", invoke: async () => ({ ok: true }) }],
    options: { maxTurns: 3 },
  });
  assert.equal(result.turnsUsed, 3);
  assert.equal(result.stuckReason, "max-turns");
});

test("runEnvelopeLoop: stuck detection short-circuits", async () => {
  const client = makeClient([
    { stopReason: null, content: "thinking", toolCalls: [] },
    { stopReason: null, content: "thinking", toolCalls: [] },
  ]);
  const result = await runEnvelopeLoop({
    client,
    options: { maxTurns: 10, stuckThreshold: 2 },
  });
  assert.equal(result.stuckReason, "no-tool-calls");
  assert.ok(result.turnsUsed <= 3);
});

test("runEnvelopeLoop: executes tools and records invocations", async () => {
  const recordedInputs = [];
  const client = makeClient([
    { stopReason: null, toolCalls: [{ name: "echo", input: { msg: "hi" } }], content: "" },
    { stopReason: "end-turn", content: "done" },
  ]);
  const result = await runEnvelopeLoop({
    client,
    tools: [{
      name: "echo",
      invoke: async (input) => {
        recordedInputs.push(input);
        return { replied: input.msg };
      },
    }],
  });
  assert.equal(recordedInputs.length, 1);
  assert.deepEqual(recordedInputs[0], { msg: "hi" });
  assert.equal(result.toolInvocations.length, 1);
  assert.deepEqual(result.toolInvocations[0].output, { replied: "hi" });
});

test("runEnvelopeLoop: unknown tool yields an error-tagged result but continues", async () => {
  const client = makeClient([
    { stopReason: null, toolCalls: [{ name: "nope", input: {} }], content: "" },
    { stopReason: "end-turn", content: "done" },
  ]);
  const result = await runEnvelopeLoop({ client });
  const errorCall = result.toolInvocations.find((t) => t.tool === "nope");
  assert.ok(errorCall);
  assert.equal(errorCall.error, "unknown-tool");
});

test("runEnvelopeLoop: tool throw yields error-tagged result, loop continues", async () => {
  const client = makeClient([
    { stopReason: null, toolCalls: [{ name: "flaky", input: {} }], content: "" },
    { stopReason: "end-turn", content: "done" },
  ]);
  const result = await runEnvelopeLoop({
    client,
    tools: [{ name: "flaky", invoke: async () => { throw new Error("boom"); } }],
  });
  const errorCall = result.toolInvocations.find((t) => t.tool === "flaky");
  assert.ok(errorCall);
  assert.equal(errorCall.error, "boom");
  assert.equal(result.stuckReason, null);
  assert.equal(result.turnsUsed, 2);
});

test("runEnvelopeLoop: shouldAllowCall=false aborts with budget-exceeded", async () => {
  const client = makeClient([{ stopReason: "end-turn", content: "should not run" }]);
  const result = await runEnvelopeLoop({
    client,
    options: {
      shouldAllowCall: () => ({ allow: false, reason: "budget" }),
    },
  });
  assert.equal(result.stuckReason, "budget-exceeded");
  assert.equal(result.turnsUsed, 0);
  assert.equal(result.messages.length, 0);
});

test("runEnvelopeLoop: findings flow from plan into aggregate", async () => {
  const client = makeClient([
    {
      stopReason: "end-turn",
      content: "",
      findings: [{ severity: "P2", title: "x" }, { severity: "P1", title: "y" }],
    },
  ]);
  const result = await runEnvelopeLoop({ client });
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.findings.map((f) => f.severity), ["P2", "P1"]);
});

test("runEnvelopeLoop: onTurn callback fires per turn, non-fatal on throw", async () => {
  const calls = [];
  const client = makeClient([
    { stopReason: null, toolCalls: [{ name: "t", input: {} }], content: "a" },
    { stopReason: "end-turn", content: "b" },
  ]);
  const result = await runEnvelopeLoop({
    client,
    tools: [{ name: "t", invoke: async () => ({}) }],
    options: {
      onTurn: (evt) => {
        calls.push(evt.turn);
        if (evt.turn === 1) throw new Error("observer broken — should not abort loop");
      },
    },
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.stuckReason, null);
});

test("runEnvelopeLoop: client.generatePlan throw → stuckReason=client-error", async () => {
  const client = {
    generatePlan: async () => { throw new Error("provider down"); },
  };
  const result = await runEnvelopeLoop({ client });
  assert.equal(result.stuckReason, "client-error");
  assert.equal(result.turnsUsed, 1);
});

// ───────────────────────── runFixCycle ─────────────────────────

test("runFixCycle: resolves on first cycle when isResolved=true", async () => {
  let cyclesRun = 0;
  const result = await runFixCycle({
    runCycle: async () => {
      cyclesRun += 1;
      return { findings: [], stuckReason: null };
    },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.cyclesUsed, 1);
  assert.equal(cyclesRun, 1);
});

test("runFixCycle: exhausts cycles when never resolved", async () => {
  const result = await runFixCycle({
    runCycle: async () => ({ findings: [{ s: "p1" }], stuckReason: "max-turns" }),
    maxCycles: 3,
  });
  assert.equal(result.resolved, false);
  assert.equal(result.cyclesUsed, 3);
  assert.equal(result.history.length, 3);
});

test("runFixCycle: requires runCycle function", async () => {
  await assert.rejects(() => runFixCycle({}), /runCycle/);
});

test("runFixCycle: custom isResolved override", async () => {
  let n = 0;
  const result = await runFixCycle({
    runCycle: async () => { n += 1; return { counter: n }; },
    isResolved: (r) => r.counter === 2,
    maxCycles: 5,
  });
  assert.equal(result.resolved, true);
  assert.equal(result.cyclesUsed, 2);
});

// ───────────────────────── createEventStream ─────────────────────────

test("createEventStream: onTurn pushes turn events into history", () => {
  const stream = createEventStream();
  stream.onTurn({ turn: 1, plan: { stopReason: null, toolCalls: [{}, {}], findings: [] } });
  stream.onTurn({ turn: 2, plan: { stopReason: "end-turn", toolCalls: [], findings: [{}] } });
  const history = stream.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].planSummary.toolCallCount, 2);
  assert.equal(history[1].planSummary.findingCount, 1);
  assert.equal(history[1].planSummary.stopReason, "end-turn");
});

test("createEventStream: sink receives events", () => {
  const received = [];
  const stream = createEventStream({ sink: (evt) => received.push(evt) });
  stream.onTurn({ turn: 1, plan: { stopReason: null, toolCalls: [], findings: [] } });
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "turn");
});

test("createEventStream: sink throw does not crash the stream", () => {
  const stream = createEventStream({
    sink: () => { throw new Error("sink down"); },
  });
  assert.doesNotThrow(() => {
    stream.onTurn({ turn: 1, plan: { stopReason: null, toolCalls: [], findings: [] } });
  });
  assert.equal(stream.history().length, 1);
});

// ───────────────────────── constants ─────────────────────────

test("Envelope defaults are exposed", () => {
  assert.equal(DEFAULT_MAX_TURNS, 10);
  assert.equal(DEFAULT_STUCK_THRESHOLD, 2);
});
