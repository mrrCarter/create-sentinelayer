import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { shouldSpawnSubAgents, runJulesSwarm } from "../src/agents/jules/swarm/orchestrator.js";

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
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

// ── shouldSpawnSubAgents ─────────────────────────────────────────────

describe("shouldSpawnSubAgents", () => {
  it("returns false for small codebase", () => {
    const result = shouldSpawnSubAgents({
      primary: [
        { path: "src/App.tsx", loc: 50 },
        { path: "src/Header.tsx", loc: 30 },
      ],
    });
    assert.equal(result.spawn, false);
  });

  it("returns true when file count exceeds threshold", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({ path: `src/Component${i}.tsx`, loc: 80 }));
    const result = shouldSpawnSubAgents({ primary: files });
    assert.equal(result.spawn, true);
    assert.ok(result.reason.includes("frontend files"));
  });

  it("returns true when route groups exceed threshold", () => {
    const files = [
      { path: "app/dashboard/page.tsx", loc: 100 },
      { path: "app/settings/page.tsx", loc: 100 },
      { path: "app/auth/page.tsx", loc: 100 },
    ];
    const result = shouldSpawnSubAgents({ primary: files });
    assert.equal(result.spawn, true);
    assert.ok(result.reason.includes("route groups"));
  });

  it("returns true when LOC exceeds threshold", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `src/Big${i}.tsx`, loc: 600 }));
    const result = shouldSpawnSubAgents({ primary: files });
    assert.equal(result.spawn, true);
    assert.ok(result.reason.includes("LOC"));
  });

  it("ignores non-frontend files", () => {
    const files = Array.from({ length: 20 }, (_, i) => ({ path: `src/service${i}.py`, loc: 200 }));
    const result = shouldSpawnSubAgents({ primary: files });
    assert.equal(result.spawn, false);
    assert.equal(result.fileCount, 0);
  });

  it("handles empty scope gracefully", () => {
    const result = shouldSpawnSubAgents({ primary: [] });
    assert.equal(result.spawn, false);
    assert.equal(result.fileCount, 0);
  });

  it("handles missing primary gracefully", () => {
    const result = shouldSpawnSubAgents({});
    assert.equal(result.spawn, false);
  });
});

// ── runJulesSwarm structure ──────────────────────────────────────────

describe("runJulesSwarm", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("emits swarm lifecycle events", async () => {
    writeFile("package.json", JSON.stringify({ name: "test" }));
    writeFile("src/App.tsx", "export default function App() { return <div/>; }");

    const events = [];
    const result = await runJulesSwarm({
      scopeMap: { primary: [{ path: path.join(tmpDir, "src/App.tsx") }] },
      rootPath: tmpDir,
      blackboard: { appendEntry: async () => {}, query: () => [] },
      budget: { maxCostUsd: 0.01, maxOutputTokens: 100, maxToolCalls: 5, maxRuntimeMs: 10000 },
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.status, "completed");
    assert.ok(result.runId.startsWith("swarm-jules-"));
    assert.ok(events.some(e => e.event === "swarm_start"));
    assert.ok(events.some(e => e.event === "phase_start" && e.payload.phase === "file_scan"));
    assert.ok(events.some(e => e.event === "phase_start" && e.payload.phase === "pattern_hunt"));
    assert.ok(events.some(e => e.event === "phase_start" && e.payload.phase === "convergence"));
    assert.ok(events.some(e => e.event === "phase_start" && e.payload.phase === "coverage_verify"));
    assert.ok(events.some(e => e.event === "swarm_complete"));
    assert.ok(result.usage.totalDurationMs >= 0);
  });

  it("tracks findings and cost across agents", async () => {
    writeFile("package.json", JSON.stringify({ name: "test" }));
    const files = Array.from({ length: 3 }, (_, i) => {
      writeFile(`src/C${i}.tsx`, `export function C${i}() { return <div/>; }`);
      return { path: path.join(tmpDir, `src/C${i}.tsx`) };
    });

    const result = await runJulesSwarm({
      scopeMap: { primary: files },
      rootPath: tmpDir,
      blackboard: { appendEntry: async () => {}, query: () => [] },
      budget: { maxCostUsd: 0.01, maxOutputTokens: 100, maxToolCalls: 5, maxRuntimeMs: 10000 },
    });

    assert.equal(result.status, "completed");
    assert.ok(result.phases.fileScanning.agents >= 1);
    assert.ok(result.phases.patternHunting.agents === 6);
    assert.ok(typeof result.usage.totalCostUsd === "number");
    assert.ok(typeof result.coverage.coverageRatio === "string");
  });

  it("includes coverage ledger in result", async () => {
    writeFile("package.json", JSON.stringify({ name: "test" }));
    writeFile("src/A.tsx", "export function A() {}");

    const result = await runJulesSwarm({
      scopeMap: { primary: [{ path: path.join(tmpDir, "src/A.tsx") }] },
      rootPath: tmpDir,
      blackboard: { appendEntry: async () => {}, query: () => [] },
      budget: { maxCostUsd: 0.01, maxOutputTokens: 100, maxToolCalls: 5, maxRuntimeMs: 10000 },
    });

    assert.ok(result.coverage);
    assert.equal(result.coverage.seedFilesReviewed, 1);
    assert.ok(typeof result.coverage.totalFilesReviewed === "number");
  });
});

// ── Orchestrator exports ─────────────────────────────────────────────

describe("orchestrator exports", () => {
  it("exports expected functions", async () => {
    const mod = await import("../src/agents/jules/swarm/orchestrator.js");
    assert.ok(typeof mod.shouldSpawnSubAgents === "function");
    assert.ok(typeof mod.runJulesSwarm === "function");
  });
});
