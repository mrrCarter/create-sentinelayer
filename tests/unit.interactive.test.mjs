import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { detectRepos } from "../src/interactive/workspace.js";
import { checkIngestFreshness } from "../src/interactive/auto-ingest.js";
import {
  startSession, recordLlmUsage, recordToolCall, recordFindings, getSessionSummary, endSession,
} from "../src/telemetry/session-tracker.js";

let tmpDir;
function setup() { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "interactive-test-")); }
function teardown() { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }

describe("detectRepos", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("detects git repo in current directory", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const result = detectRepos(tmpDir);
    assert.ok(result.repos.length >= 1);
    assert.ok(result.repos.some(r => r.isCurrentDir));
  });

  it("returns empty for non-git directory", () => {
    const result = detectRepos(tmpDir);
    assert.equal(result.repos.filter(r => r.isCurrentDir).length, 0);
  });

  it("detects sibling repos in parent", () => {
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });
    const result = detectRepos(repoA);
    assert.ok(result.repos.length >= 2);
  });
});

describe("checkIngestFreshness", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("reports missing when no ingest file", () => {
    const result = checkIngestFreshness(tmpDir);
    assert.equal(result.exists, false);
    assert.equal(result.stale, true);
  });

  it("reports fresh when ingest file is recent", () => {
    const dir = path.join(tmpDir, ".sentinelayer");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CODEBASE_INGEST.json"), "{}", "utf-8");
    const result = checkIngestFreshness(tmpDir);
    assert.equal(result.exists, true);
    assert.equal(result.stale, false);
  });
});

describe("session-tracker", () => {
  afterEach(() => {
    endSession();
  });

  it("tracks tokens, tools, cost, and findings", () => {
    startSession("test-command");
    recordLlmUsage({ inputTokens: 1000, outputTokens: 500, costUsd: 0.02 });
    recordLlmUsage({ inputTokens: 800, outputTokens: 300, costUsd: 0.01 });
    recordToolCall();
    recordToolCall();
    recordToolCall();
    recordFindings({ P0: 0, P1: 1, P2: 3 });

    const summary = getSessionSummary();
    assert.equal(summary.command, "test-command");
    assert.equal(summary.inputTokens, 1800);
    assert.equal(summary.outputTokens, 800);
    assert.equal(summary.totalTokens, 2600);
    assert.ok(Math.abs(summary.costUsd - 0.03) < 0.001);
    assert.equal(summary.toolCalls, 3);
    assert.equal(summary.llmCalls, 2);
    assert.equal(summary.findings.P1, 1);
    assert.equal(summary.findings.P2, 3);
    assert.ok(summary.durationMs >= 0);
  });

  it("returns null when no session started", () => {
    const summary = getSessionSummary();
    assert.equal(summary, null);
  });
});

describe("action-menu exports", () => {
  it("exports showActionMenu", async () => {
    const mod = await import("../src/interactive/action-menu.js");
    assert.ok(typeof mod.showActionMenu === "function");
  });
});

describe("interactive index exports", () => {
  it("exports runInteractiveMode", async () => {
    const mod = await import("../src/interactive/index.js");
    assert.ok(typeof mod.runInteractiveMode === "function");
  });
});
