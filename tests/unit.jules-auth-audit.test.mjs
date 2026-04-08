import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authAudit, AuthAuditError } from "../src/agents/jules/tools/auth-audit.js";

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
