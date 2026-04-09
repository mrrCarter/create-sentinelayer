import fs from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authAudit, AuthAuditError, runPlaywrightAuditScriptWithRetry } from "../src/agents/jules/tools/auth-audit.js";

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
  const LIVE_AUTH_APPROVAL = {
    allowProvisioning: true,
    approvedTargetId: "sl-approved-example",
    approvedHosts: ["example.com"],
  };

  it("rejects unknown operation with structured envelope", async () => {
    const result = await authAudit({ operation: "nonexistent" });
    assert.equal(result.available, false);
    assert.equal(result.ok, false);
    assert.equal(result.operation, "nonexistent");
    assert.equal(result.envelope, "v2");
    assert.equal(result.error.code, "AUTH_AUDIT_UNKNOWN_OPERATION");
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

  it("provision_test_identity unavailable responses include structured error metadata", async () => {
    const result = await authAudit({ operation: "provision_test_identity", execute: true });
    assert.equal(result.available, false);
    assert.equal(result.ok, false);
    assert.equal(result.envelope, "v2");
    assert.equal(typeof result.requestId, "string");
    assert.ok(result.error && typeof result.error === "object");
    assert.equal(result.error.requestId, result.requestId);
    assert.equal(typeof result.error.code, "string");
    assert.equal(typeof result.error.message, "string");
    assert.equal(typeof result.error.retryable, "boolean");
    assert.equal(result.data, null);
  });

  it("authenticated_page_check requires url", async () => {
    const result = await authAudit({ operation: "authenticated_page_check" });
    assert.equal(result.available, false);
    assert.equal(result.error.code, "AUTH_AUDIT_VALIDATION_FAILED");
    assert.match(result.reason, /requires url/);
  });

  it("authenticated_page_check rejects invalid url", async () => {
    const result = await authAudit({ operation: "authenticated_page_check", url: "not-a-url" });
    assert.equal(result.available, false);
    assert.equal(result.error.code, "AUTH_AUDIT_VALIDATION_FAILED");
    assert.match(result.reason, /Invalid URL|must be a valid URL/i);
  });

  it("authenticated_page_check blocks private localhost targets by default", async () => {
    const result = await authAudit({ operation: "authenticated_page_check", url: "http://localhost:3000/app" });
    assert.equal(result.available, false);
    assert.equal(result.error.code, "AUTH_AUDIT_VALIDATION_FAILED");
    assert.match(result.reason, /private|localhost/i);
  });

  it("check_auth_flow_security works for reachable url", async () => {
    const result = await authAudit({
      operation: "check_auth_flow_security",
      url: "https://example.com",
      ...LIVE_AUTH_APPROVAL,
    });
    assert.ok(typeof result.available === "boolean");
    assert.equal(typeof result.requestId, "string");
    if (result.available) {
      assert.ok(Array.isArray(result.findings));
      assert.equal(result.ok, true);
      assert.equal(result.envelope, "v2");
      assert.ok(result.data && typeof result.data === "object");
    } else {
      assert.ok(result.error && typeof result.error === "object");
      assert.equal(result.error.requestId, result.requestId);
    }
  });

  it("authAudit success envelope includes stable metadata fields", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => createResponse(200, {
      "strict-transport-security": "max-age=31536000",
      "content-security-policy": "default-src 'self'",
    });
    try {
      const result = await authAudit({
        operation: "check_auth_flow_security",
        url: "https://example.com/login",
        ...LIVE_AUTH_APPROVAL,
      });
      assert.equal(result.available, true);
      assert.equal(result.ok, true);
      assert.equal(result.envelope, "v2");
      assert.equal(result.operation, "check_auth_flow_security");
      assert.ok(result.data && typeof result.data === "object");
      assert.equal(result.data.requestId, result.requestId);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security requires approved target context for live mode", async () => {
    const result = await authAudit({
      operation: "check_auth_flow_security",
      url: "https://example.com/login",
    });
    assert.equal(result.available, false);
    assert.equal(result.error.code, "AUTH_AUDIT_VALIDATION_FAILED");
    assert.match(result.reason, /allowProvisioning=true and approvedTargetId/);
  });

  it("check_auth_flow_security blocks unapproved hosts even with approval id", async () => {
    const result = await authAudit({
      operation: "check_auth_flow_security",
      url: "https://api.unknown-host.example/login",
      allowProvisioning: true,
      approvedTargetId: "sl-approved-example",
      approvedHosts: ["example.com"],
    });
    assert.equal(result.available, false);
    assert.equal(result.error.code, "AUTH_AUDIT_VALIDATION_FAILED");
    assert.match(result.reason, /Blocked unapproved auth audit host/);
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
      const result = await authAudit({
        operation: "check_auth_flow_security",
        url: "https://example.com/login",
        ...LIVE_AUTH_APPROVAL,
      });
      assert.equal(result.available, true);
      assert.equal(callCount, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security retries transient TypeError transport failures and succeeds", async () => {
    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      return createResponse(200, {
        "strict-transport-security": "max-age=31536000",
        "content-security-policy": "default-src 'self'",
      });
    };
    try {
      const result = await authAudit({
        operation: "check_auth_flow_security",
        url: "https://example.com/login",
        ...LIVE_AUTH_APPROVAL,
      });
      assert.equal(result.available, true);
      assert.equal(callCount, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security fails fast on non-retryable TypeError", async () => {
    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      throw new TypeError("Failed to parse URL from config");
    };
    try {
      const result = await authAudit({
        operation: "check_auth_flow_security",
        url: "https://example.com/login",
        ...LIVE_AUTH_APPROVAL,
      });
      assert.equal(result.available, false);
      assert.match(result.reason, /failed after 1 attempt\(s\)/);
      assert.equal(callCount, 1);
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
      const result = await authAudit({
        operation: "check_auth_flow_security",
        url: "https://example.com/login",
        ...LIVE_AUTH_APPROVAL,
      });
      assert.equal(result.available, false);
      assert.match(result.reason, /failed after 3 attempt\(s\)/);
      assert.equal(callCount, 3);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security fails closed on HTTPS downgrade redirects", async () => {
    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return createResponse(302, {
        location: "http://example.com/login",
      });
    };
    try {
      const result = await authAudit({
        operation: "check_auth_flow_security",
        url: "https://example.com/login",
        ...LIVE_AUTH_APPROVAL,
      });
      assert.equal(result.available, false);
      assert.match(result.reason, /HTTPS downgrade detected/);
      assert.ok(Array.isArray(result.findings));
      assert.ok(result.findings.some((finding) => finding.severity === "P1"));
      assert.equal(callCount, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security fails closed when redirect hop budget is exceeded", async () => {
    const previousFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return createResponse(302, {
        location: `/hop-${callCount}`,
      });
    };
    try {
      const result = await authAudit({
        operation: "check_auth_flow_security",
        url: "https://example.com/login",
        ...LIVE_AUTH_APPROVAL,
      });
      assert.equal(result.available, false);
      assert.match(result.reason, /Exceeded 5 redirects/);
      assert.ok(callCount >= 6);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security allows localhost HTTP targets in test mode only", async () => {
    const previousFetch = globalThis.fetch;
    const previousNodeEnv = process.env.NODE_ENV;
    globalThis.fetch = async () => createResponse(200, {
      "strict-transport-security": "max-age=31536000",
      "content-security-policy": "default-src 'self'",
    });
    process.env.NODE_ENV = "test";
    try {
      const result = await authAudit({ operation: "check_auth_flow_security", url: "http://localhost:3000/login" });
      assert.equal(result.available, true);
      assert.equal(result.findings.length, 0);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      globalThis.fetch = previousFetch;
    }
  });

  it("check_auth_flow_security blocks private localhost targets outside trusted contexts", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = await authAudit({ operation: "check_auth_flow_security", url: "http://localhost:3000/login" });
      assert.equal(result.available, false);
      assert.equal(result.error.code, "AUTH_AUDIT_VALIDATION_FAILED");
      assert.match(result.reason, /private|localhost/i);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("runPlaywrightAuditScriptWithRetry retries transient execution failures and succeeds", async () => {
    let attemptCount = 0;
    const stubExec = () => {
      attemptCount += 1;
      if (attemptCount < 3) {
        const error = new Error("timed out waiting for playwright");
        error.code = "ETIMEDOUT";
        error.signal = "SIGTERM";
        error.killed = true;
        throw error;
      }
      return "{\"authenticated\":true}";
    };

    const output = await runPlaywrightAuditScriptWithRetry("fake-script.cjs", {}, {
      exec: stubExec,
      maxRetries: 2,
      baseBackoffMs: 1,
      timeoutMs: 1000,
    });

    assert.equal(output, "{\"authenticated\":true}");
    assert.equal(attemptCount, 3);
  });

  it("runPlaywrightAuditScriptWithRetry forwards context via stdin payload", async () => {
    let receivedInput = null;
    let receivedArgs = null;
    const stubExec = (_bin, args, options) => {
      receivedArgs = args;
      receivedInput = options.input;
      return "{\"authenticated\":false}";
    };

    const payload = JSON.stringify({ email: "demo@example.com", password: "redacted" });
    await runPlaywrightAuditScriptWithRetry(null, {}, {
      exec: stubExec,
      scriptSource: "console.log('{}')",
      stdinPayload: payload,
      timeoutMs: 1000,
    });

    assert.deepEqual(receivedArgs, ["-e", "console.log('{}')"]);
    assert.equal(receivedInput, payload);
  });

  it("runPlaywrightAuditScriptWithRetry fails after retry budget exhaustion", async () => {
    let attemptCount = 0;
    const stubExec = () => {
      attemptCount += 1;
      const error = new Error("timed out waiting for playwright");
      error.code = "ETIMEDOUT";
      throw error;
    };

    await assert.rejects(
      () => runPlaywrightAuditScriptWithRetry("fake-script.cjs", {}, {
        exec: stubExec,
        maxRetries: 2,
        baseBackoffMs: 1,
        timeoutMs: 1000,
      }),
      (error) => {
        assert.ok(error instanceof AuthAuditError);
        assert.match(error.message, /failed after 3 attempt\(s\)/);
        return true;
      },
    );
    assert.equal(attemptCount, 3);
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

  it("sanitizes secret-like patterns in Playwright error capture", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("function sanitizeErrorText(value)"));
    assert.ok(source.includes("Bearer [REDACTED]"));
    assert.ok(source.includes("[REDACTED_JWT]"));
    assert.ok(source.includes("[REDACTED_TOKEN]"));
    assert.ok(source.includes("type: 'console'"));
    assert.ok(source.includes("type: 'pageerror'"));
    assert.ok(source.includes("type: 'playwright'"));
  });

  it("auth success heuristic requires stronger post-login signals", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("authSignals"));
    assert.ok(source.includes("didLeaveLoginSurface"));
    assert.ok(source.includes("loginFormVisible"));
    assert.ok(source.includes("authCookiePresent"));
    assert.ok(source.includes("authVerificationMaxAttempts"));
    assert.ok(source.includes("authVerificationAttemptsUsed"));
    assert.ok(source.includes("authVerificationRetried"));
    assert.ok(source.includes("results.authenticated = navigationSucceeded && !loginFormVisible && urlChanged && authCookiePresent;"));
    assert.ok(source.includes("targetLoginFormVisible"));
    assert.ok(source.includes("targetStatusOk"));
    assert.ok(source.includes("results.authenticated = !targetLoginFormVisible && targetStatusOk;"));
  });

  it("authenticated header policy is enforced as deterministic findings", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("evaluateAuthenticatedHeaderFindings"));
    assert.ok(source.includes("Authenticated page missing Content-Security-Policy header"));
    assert.ok(source.includes("Authenticated page missing Strict-Transport-Security header"));
    assert.ok(source.includes("Authenticated page missing X-Frame-Options header"));
    assert.ok(source.includes("headerPolicyBreaches"));
    assert.ok(source.includes("headerPolicyPassed"));
    assert.ok(source.includes("headerPolicyFailed"));
  });

  it("auth mutation is gated by explicit allowAuthMutation policy", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("SL_AUDIT_ALLOW_AUTH_MUTATION"));
    assert.ok(source.includes("mutationAllowed"));
    assert.ok(source.includes("mutationPerformed"));
    assert.ok(source.includes("if (allowAuthMutation)"));
  });

  it("requestId fallback uses cryptographic randomness", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("randomBytes(16).toString(\"hex\")"));
    assert.equal(source.includes("Math.random().toString(36)"), false);
  });

  it("playwright navigation and runtime failures are captured with explicit signals", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("navigationTimeout"));
    assert.ok(source.includes("type: 'navigation'"));
    assert.ok(source.includes("results.executionFailed = true"));
    assert.ok(source.includes("process.exitCode = 1"));
  });

  it("playwright retry backoff jitter is deterministic", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("deterministicJitter"));
    assert.ok(source.includes("1103515245"));
    assert.ok(source.includes("12345"));
  });

  it("playwright context is sourced from stdin instead of temporary credential files", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("fs.readFileSync(0, 'utf-8')"));
    assert.equal(source.includes("SL_AUDIT_CONTEXT_FILE"), false);
  });

  it("auth flow header fetch uses explicit timeout wrapper", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("async function fetchWithTimeout(url, options, timeoutMs)"));
    assert.ok(source.includes("fetchWithTimeout(currentUrl, {"));
    assert.ok(source.includes("AUTH_FLOW_FETCH_TIMEOUT_MS"));
  });

  it("AIdenID provisioning path includes bounded retry and timeout controls", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("AUTH_AIDENID_PROVISION_TIMEOUT_MS"));
    assert.ok(source.includes("AUTH_AIDENID_PROVISION_TOTAL_BUDGET_MS"));
    assert.ok(source.includes("AUTH_AIDENID_PROVISION_MAX_RETRIES"));
    assert.ok(source.includes("provisionEmailIdentityWithRetry"));
    assert.ok(source.includes("new AbortController()"));
    assert.ok(source.includes("Promise.race(["));
    assert.ok(source.includes("AIDENID_ATTEMPT_TIMEOUT"));
    assert.ok(source.includes("remainingBudgetMs"));
    assert.ok(source.includes("AIdenID provisioning failed after"));
  });

  it("AIdenID provisioning retry preserves caller abort semantics and disposes transient bodies", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("composeAbortSignals(callerSignal, controller.signal)"));
    assert.ok(source.includes("AIDENID_ABORTED_BY_CALLER"));
    assert.ok(source.includes("response.body && typeof response.body.cancel === \"function\""));
    assert.ok(source.includes("await response.body.cancel()"));
  });

  it("fetch timeout wrapper composes caller signal with timeout signal", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("const callerSignal = isAbortSignalLike(options?.signal) ? options.signal : undefined;"));
    assert.ok(source.includes("composeAbortSignals(callerSignal, controller.signal)"));
  });

  it("provider circuit-breaker state is enforced for repeated auth provider degradation", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("AUTH_AUDIT_PROVIDER_BREAKER_FAILURE_THRESHOLD"));
    assert.ok(source.includes("AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT"));
    assert.ok(source.includes("AUTH_AUDIT_PROVIDER_BREAKERS"));
    assert.ok(source.includes("deriveProviderBreakerScope"));
    assert.ok(source.includes("enforceProviderBreaker(providerKey, providerScope, requestId)"));
    assert.ok(source.includes("recordProviderBreakerFailure(providerKey, providerScope"));
    assert.ok(source.includes("providerBreaker"));
    assert.ok(source.includes("AUTH_AUDIT_PROVIDER_CIRCUIT_OPEN"));
  });

  it("audit error messages are sanitized before envelope emission", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/tools/auth-audit.js", import.meta.url), "utf-8");
    assert.ok(source.includes("sanitizeAuditErrorMessage"));
    assert.ok(source.includes("replace(/\\bbearer\\s+[a-z0-9._~+/=-]+\\b/gi, \"bearer [REDACTED]\")"));
    assert.ok(source.includes("replace(/\\bhttps?:\\/\\/[^\\s\"'`]+/gi, \"<redacted-url>\")"));
    assert.ok(source.includes("const safeMessage = sanitizeAuditErrorMessage(message"));
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
