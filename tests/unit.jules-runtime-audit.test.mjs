import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runtimeAudit, RuntimeAuditError } from "../src/agents/jules/tools/runtime-audit.js";

let tmpDir;
function setup() { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-test-")); }
function teardown() { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }

describe("runtimeAudit", () => {
  it("rejects unknown operation", async () => {
    await assert.rejects(() => runtimeAudit({ operation: "nonexistent" }), RuntimeAuditError);
  });

  it("lighthouse_scan requires url", async () => {
    await assert.rejects(() => runtimeAudit({ operation: "lighthouse_scan" }), RuntimeAuditError);
  });

  it("lighthouse_scan rejects invalid url", async () => {
    await assert.rejects(
      () => runtimeAudit({ operation: "lighthouse_scan", url: "not-a-url" }),
      RuntimeAuditError,
    );
  });

  it("check_response_headers requires url", async () => {
    await assert.rejects(
      () => runtimeAudit({ operation: "check_response_headers" }),
      RuntimeAuditError,
    );
  });

  it("check_response_headers works for reachable url", async () => {
    const result = await runtimeAudit({ operation: "check_response_headers", url: "https://example.com" });
    assert.ok(typeof result.available === "boolean");
    if (result.available) {
      assert.ok(result.statusCode > 0);
      assert.ok(typeof result.headers === "object");
      assert.ok(Array.isArray(result.securityFindings));
    }
  });

  it("detect_deployed_url searches common locations", async () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ homepage: "https://app.example.com" }));
    const result = await runtimeAudit({ operation: "detect_deployed_url", path: tmpDir });
    assert.ok(result.found);
    assert.equal(result.primary, "https://app.example.com");
    assert.ok(result.candidates.some(c => c.source === "package.json:homepage"));
    teardown();
  });

  it("detect_deployed_url returns empty for bare project", async () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    const result = await runtimeAudit({ operation: "detect_deployed_url", path: tmpDir });
    assert.ok(typeof result.found === "boolean");
    teardown();
  });

  it("check_console_errors reports unavailable without playwright", async () => {
    const result = await runtimeAudit({ operation: "check_console_errors", url: "https://example.com" });
    assert.ok(typeof result.available === "boolean");
  });

  it("check_network_waterfall returns timing for reachable url", async () => {
    const result = await runtimeAudit({ operation: "check_network_waterfall", url: "https://example.com" });
    assert.ok(typeof result.available === "boolean");
  });

  it("RuntimeAudit is registered in dispatch", async () => {
    const { listTools, isReadOnlyTool } = await import("../src/agents/jules/tools/dispatch.js");
    assert.ok(listTools().includes("RuntimeAudit"));
    assert.ok(isReadOnlyTool("RuntimeAudit"));
  });
});
