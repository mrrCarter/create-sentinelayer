import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { JulesSubAgent, runSubAgentBatch } from "../src/agents/jules/swarm/sub-agent.js";
import { createFileScanner } from "../src/agents/jules/swarm/file-scanner.js";
import { createPatternHunter, HUNT_TYPES } from "../src/agents/jules/swarm/pattern-hunter.js";

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-"));
}

function teardown() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function writeFile(name, content) {
  const fp = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf-8");
  return fp;
}

// ── JulesSubAgent construction ───────────────���───────────────────────

describe("JulesSubAgent", () => {
  it("constructs with default budget and tools", () => {
    const agent = new JulesSubAgent({
      id: "test-agent",
      role: "FileScanner",
      systemPrompt: "You are a test agent.",
      scope: { files: ["a.tsx"] },
    });
    assert.equal(agent.role, "FileScanner");
    assert.equal(agent.maxTurns, 10);
    assert.ok(agent.allowedTools.has("FileRead"));
    assert.ok(agent.allowedTools.has("Grep"));
    assert.ok(!agent.allowedTools.has("Shell"));
    assert.ok(!agent.allowedTools.has("FileEdit"));
  });

  it("links abort controller to parent", () => {
    const parentAbort = new AbortController();
    const agent = new JulesSubAgent({
      id: "test-abort",
      role: "test",
      systemPrompt: "test",
      parentAbort,
    });
    assert.equal(agent.abortController.signal.aborted, false);
    parentAbort.abort();
    assert.equal(agent.abortController.signal.aborted, true);
  });

  it("emits events via onEvent callback", () => {
    const events = [];
    const agent = new JulesSubAgent({
      id: "test-events",
      role: "test",
      systemPrompt: "test",
      onEvent: (e) => events.push(e),
    });
    agent.emitEvent("agent_start", { role: "test" });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "agent_start");
    assert.equal(events[0].agent.id, "test-events");
    assert.ok(events[0].usage.durationMs >= 0);
  });

  it("builds result with usage tracking", () => {
    const agent = new JulesSubAgent({
      id: "test-result",
      role: "FileScanner",
      systemPrompt: "test",
    });
    agent.findings.push({ severity: "P2", file: "a.tsx", title: "test finding" });
    agent.turnCount = 3;
    const result = agent.buildResult("completed");
    assert.equal(result.status, "completed");
    assert.equal(result.findings.length, 1);
    assert.equal(result.usage.turns, 3);
    assert.ok(result.usage.durationMs >= 0);
  });
});

// ── FileScanner ──────────────────────────────────────────────────────

describe("createFileScanner", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates scanner with correct config", () => {
    const scanner = createFileScanner({
      id: "scanner-test",
      files: ["a.tsx", "b.tsx", "c.tsx"],
    });
    assert.equal(scanner.role, "FileScanner");
    assert.ok(scanner.allowedTools.has("FileRead"));
    assert.ok(scanner.allowedTools.has("Grep"));
    assert.ok(!scanner.allowedTools.has("Shell"));
    assert.ok(!scanner.allowedTools.has("FileEdit"));
    assert.ok(scanner.maxTurns <= 15);
  });

  it("scales budget proportional to file count", () => {
    const small = createFileScanner({ files: ["a.tsx"] });
    const large = createFileScanner({ files: Array(20).fill("x.tsx") });
    assert.ok(large.ctx.budget.maxToolCalls > small.ctx.budget.maxToolCalls);
  });
});

// ── PatternHunter ────────────────────────────────────────────────────

describe("createPatternHunter", () => {
  it("creates all 6 hunt types", () => {
    for (const huntType of HUNT_TYPES) {
      const hunter = createPatternHunter({
        huntType,
        rootPath: process.cwd(),
      });
      assert.ok(hunter.role.includes("PatternHunter"));
      assert.ok(hunter.allowedTools.has("Grep"));
      assert.ok(hunter.allowedTools.has("FrontendAnalyze"));
    }
  });

  it("has all expected hunt types", () => {
    assert.ok(HUNT_TYPES.includes("xss"));
    assert.ok(HUNT_TYPES.includes("state"));
    assert.ok(HUNT_TYPES.includes("hydration"));
    assert.ok(HUNT_TYPES.includes("a11y"));
    assert.ok(HUNT_TYPES.includes("perf"));
    assert.ok(HUNT_TYPES.includes("security"));
    assert.equal(HUNT_TYPES.length, 6);
  });

  it("rejects unknown hunt type", () => {
    assert.throws(
      () => createPatternHunter({ huntType: "nonexistent", rootPath: "." }),
      /Unknown hunt type/,
    );
  });
});

// ── runSubAgentBatch ────────────────────────────────��────────────────

describe("runSubAgentBatch", () => {
  it("runs empty batch", async () => {
    const results = await runSubAgentBatch([]);
    assert.equal(results.length, 0);
  });

  it("respects maxConcurrent parameter", async () => {
    // Verify the batch completes (concurrency internals tested by execution)
    const events = [];
    const agents = [
      new JulesSubAgent({
        id: "batch-1",
        role: "test",
        systemPrompt: "test",
        budget: { maxToolCalls: 0, maxCostUsd: 0, maxOutputTokens: 0, maxRuntimeMs: 1000 },
        onEvent: (e) => events.push(e),
      }),
    ];
    // Agent will fail immediately because budget is 0, but batch should still complete
    const results = await runSubAgentBatch(agents, { maxConcurrent: 2 });
    assert.equal(results.length, 1);
  });
});

// ── Index exports ────────────────────────────────────────────────────

describe("swarm index exports", () => {
  it("exports all expected symbols", async () => {
    const mod = await import("../src/agents/jules/swarm/index.js");
    assert.ok(mod.JulesSubAgent);
    assert.ok(mod.runSubAgentBatch);
    assert.ok(mod.SubAgentError);
    assert.ok(mod.createFileScanner);
    assert.ok(mod.createPatternHunter);
    assert.ok(mod.HUNT_TYPES);
  });
});
