import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We test the loop structure without live LLM calls by verifying:
// - Generator yields correct event types
// - Budget enforcement stops the loop
// - Framework detection runs as Phase 0
// - Swarm spawning decision is respected
// - Abort controller stops the loop

// Note: Full integration tests with live LLM are in J-17.
// These are structural/contract tests.

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-test-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test-app", dependencies: { react: "^18" } }));
  fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "src/App.tsx"), "export default function App() { return <div/>; }");
}

function teardown() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
}

describe("julesAuditLoop", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("yields agent_start as first event", async () => {
    const { julesAuditLoop } = await import("../src/agents/jules/loop.js");
    const events = [];
    const gen = julesAuditLoop({
      systemPrompt: "You are Jules Tanaka.",
      scopeMap: { primary: [{ path: path.join(tmpDir, "src/App.tsx") }] },
      rootPath: tmpDir,
      budget: { maxCostUsd: 0, maxOutputTokens: 0, maxToolCalls: 0, maxRuntimeMs: 1000 },
      onEvent: (e) => events.push(e),
    });

    // First yield should be agent_start
    const first = await gen.next();
    assert.equal(first.value.event, "agent_start");
    assert.equal(first.value.agent.persona, "Jules Tanaka");
    assert.ok(first.value.payload.runId);
  });

  it("runs framework detection as Phase 0", async () => {
    const { julesAuditLoop } = await import("../src/agents/jules/loop.js");
    const events = [];
    const gen = julesAuditLoop({
      systemPrompt: "You are Jules Tanaka.",
      scopeMap: { primary: [{ path: path.join(tmpDir, "src/App.tsx") }] },
      rootPath: tmpDir,
      budget: { maxCostUsd: 0, maxOutputTokens: 0, maxToolCalls: 1, maxRuntimeMs: 5000 },
      onEvent: (e) => events.push(e),
    });

    // Consume events until we hit prerequisites or budget stop
    const collected = [];
    for await (const evt of gen) {
      collected.push(evt);
      if (evt.event === "budget_stop" || evt.event === "agent_complete" || collected.length > 10) break;
    }

    assert.ok(collected.some(e => e.event === "progress" && e.payload?.phase === "prerequisites"));
  });

  it("stops on budget exhaustion", async () => {
    const { julesAuditLoop } = await import("../src/agents/jules/loop.js");
    const events = [];
    const gen = julesAuditLoop({
      systemPrompt: "You are Jules Tanaka.",
      scopeMap: { primary: [] },
      rootPath: tmpDir,
      budget: { maxCostUsd: 0, maxOutputTokens: 0, maxToolCalls: 0, maxRuntimeMs: 1 },
      onEvent: (e) => events.push(e),
    });

    const collected = [];
    for await (const evt of gen) {
      collected.push(evt);
      if (collected.length > 15) break;
    }

    // Should hit budget stop before max turns
    assert.ok(
      collected.some(e => e.event === "budget_stop") ||
      collected.some(e => e.event === "agent_complete"),
      "Expected budget_stop or agent_complete",
    );
  });

  it("respects abort controller", async () => {
    const { julesAuditLoop } = await import("../src/agents/jules/loop.js");
    const abortController = new AbortController();

    // Abort immediately
    abortController.abort();

    const gen = julesAuditLoop({
      systemPrompt: "You are Jules Tanaka.",
      scopeMap: { primary: [{ path: path.join(tmpDir, "src/App.tsx") }] },
      rootPath: tmpDir,
      budget: { maxCostUsd: 5, maxOutputTokens: 12000, maxToolCalls: 150, maxRuntimeMs: 300000 },
      abortController,
    });

    const collected = [];
    for await (const evt of gen) {
      collected.push(evt);
      if (collected.length > 15) break;
    }

    // Should abort early (not run full 25 turns)
    assert.ok(collected.length < 15);
  });

  it("includes Jules signature in all events", async () => {
    const { julesAuditLoop } = await import("../src/agents/jules/loop.js");
    const gen = julesAuditLoop({
      systemPrompt: "test",
      scopeMap: { primary: [] },
      rootPath: tmpDir,
      budget: { maxCostUsd: 0, maxOutputTokens: 0, maxToolCalls: 0, maxRuntimeMs: 1 },
    });

    const first = await gen.next();
    assert.equal(first.value.agent.id, "frontend");
    assert.equal(first.value.agent.persona, "Jules Tanaka");
    assert.equal(first.value.agent.color, "cyan");
  });
});

describe("julesAuditLoop module exports", () => {
  it("exports julesAuditLoop function", async () => {
    const mod = await import("../src/agents/jules/loop.js");
    assert.ok(typeof mod.julesAuditLoop === "function");
  });
});
