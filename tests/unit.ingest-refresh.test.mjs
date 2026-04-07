import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { detectIngestDrift, refreshIngestIfNeeded, startPeriodicRefresh } from "../src/daemon/ingest-refresh.js";

let tmpDir;
function setup() { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-test-")); }
function teardown() { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }

describe("detectIngestDrift", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("reports changed when no ingest exists", () => {
    const result = detectIngestDrift(tmpDir);
    assert.equal(result.changed, true);
  });

  it("reports no change when file count matches", () => {
    const dir = path.join(tmpDir, ".sentinelayer");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CODEBASE_INGEST.json"), JSON.stringify({ summary: { filesScanned: 3 } }));
    fs.writeFileSync(path.join(tmpDir, "a.js"), "");
    fs.writeFileSync(path.join(tmpDir, "b.js"), "");
    fs.writeFileSync(path.join(tmpDir, "c.js"), "");
    const result = detectIngestDrift(tmpDir);
    assert.equal(result.changed, false);
  });

  it("reports changed when delta exceeds threshold", () => {
    const dir = path.join(tmpDir, ".sentinelayer");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CODEBASE_INGEST.json"), JSON.stringify({ summary: { filesScanned: 0 } }));
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(tmpDir, "file" + i + ".js"), "");
    const result = detectIngestDrift(tmpDir);
    assert.equal(result.changed, true);
    assert.ok(result.delta >= 5);
  });
});

describe("refreshIngestIfNeeded", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("skips when no drift", async () => {
    const dir = path.join(tmpDir, ".sentinelayer");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CODEBASE_INGEST.json"), JSON.stringify({ summary: { filesScanned: 0 } }));
    const result = await refreshIngestIfNeeded(tmpDir);
    assert.equal(result.refreshed, false);
  });

  it("emits events during refresh", async () => {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(tmpDir, "f" + i + ".js"), "x");
    const events = [];
    await refreshIngestIfNeeded(tmpDir, { onEvent: e => events.push(e) });
    assert.ok(events.some(e => e.event === "ingest_refresh_start"));
    assert.ok(events.some(e => e.event === "ingest_refresh_complete"));
  });
});

describe("startPeriodicRefresh", () => {
  it("returns stoppable watcher", () => {
    const watcher = startPeriodicRefresh(os.tmpdir(), { checkIntervalMs: 100000 });
    assert.ok(typeof watcher.stop === "function");
    watcher.stop();
  });
});
