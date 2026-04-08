import fs from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authAudit, AuthAuditError } from "../src/agents/jules/tools/auth-audit.js";

function createResponse(status, headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  return {
    status: Number(status || 0),
    headers: {
      entries() {
        return Object.entries(normalized);
      },
      get(name) {
        return normalized[String(name || "").toLowerCase()] ?? null;
      },
    },
  };
}

describe("authAudit", () => {
  it("rejects unknown operation", () => {
    assert.throws(() => authAudit({ operation: "nonexistent" }), AuthAuditError);
  });

  it("provision_test_identity returns unavailable without API key", async () => {
    const result = await authAudit({ operation: "provision_test_identity" });
    assert.ok(typeof result.available === "boolean");
    if (!result.available) {
      assert.ok(result.reason.includes("AIdenID") || result.reason.includes("API key"));
    }
  });

  it("provision_test_identity blocks live execute without explicit approval flag", async () => {
    const result = await authAudit({ operation: "provision_test_identity", execute: true });
    assert.equal(result.available, false);
    assert.match(result.reason, /allowProvisioning=true|SENTINELAYER_ALLOW_LIVE_IDENTITY_PROVISION/);
  });

  it("authenticated_page_check requires url", async () => {
    await assert.rejects(
      () => authAudit({ operation: "authenticated_page_check" }),
      AuthAuditError,
    );
  });

  it("authenticated_page_check rejects invalid url", async () => {
    await assert.rejects(
      () => authAudit({ operation: "authenticated_page_check", url: "not-a-url" }),
      AuthAuditError,
    );
  });

  it("check_auth_flow_security works for reachable url", async () => {
    const result = await authAudit({ operation: "check_auth_flow_security", url: "https://example.com" });
    assert.ok(typeof result.available === "boolean");
    if (result.available) {
      assert.ok(Array.isArray(result.findings));
    }
  });

  it("check_auth_flow_security retries transient retryable statuses and succeeds", async () => {
    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return createResponse(503);
      }
      return createResponse(200, {
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'",
      });
    };
    try {
      const result = await authAudit({ operation: "check_auth_flow_security", url: "https://example.com/login" });
      assert.equal(result.available, true);
      assert.equal(callCount, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security fails closed after transient retry budget is exhausted", async () => {
    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    };
    try {
      const result = await authAudit({ operation: "check_auth_flow_security", url: "https://example.com/login" });
      assert.equal(result.available, false);
      assert.match(result.reason, /failed after 3 attempt\(s\)/);
      assert.equal(callCount, 3);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("registers console listener before target navigation in Playwright script", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    const listenerIndex = source.indexOf("page.on('console', msg =>");
    const targetNavigationIndex = source.indexOf("const targetResponse = await page.goto(targetUrl");

    assert.ok(listenerIndex !== -1, "expected console listener in Playwright script");
    assert.ok(targetNavigationIndex !== -1, "expected target navigation in Playwright script");
    assert.ok(
      listenerIndex < targetNavigationIndex,
      "console listener must be registered before target navigation to capture early runtime errors",
    );
  });

  it("AuthAudit registered in dispatch as read-only", async () => {
    const { listTools, isReadOnlyTool } = await import("../src/agents/jules/tools/dispatch.js");
    assert.ok(listTools().includes("AuthAudit"));
    assert.ok(isReadOnlyTool("AuthAudit"));
  });

  it("AuthAudit in JULES_DEFINITION auditTools", async () => {
    const { JULES_DEFINITION } = await import("../src/agents/jules/config/definition.js");
    assert.ok(JULES_DEFINITION.auditTools.includes("AuthAudit"));
  });
});
