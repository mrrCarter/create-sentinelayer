import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("fix-cycle module", () => {
  it("exports runFixCycle", async () => {
    const mod = await import("../src/agents/jules/fix-cycle.js");
    assert.ok(typeof mod.runFixCycle === "function");
  });

  it("runFixCycle emits fix_claim and fix_error on missing work item", async () => {
    const { runFixCycle } = await import("../src/agents/jules/fix-cycle.js");
    const events = [];
    const result = await runFixCycle({
      workItemId: "test-nonexistent-" + Date.now(),
      workItem: { severity: "P2", errorCode: "TEST", endpoint: "/test" },
      rootPath: process.cwd(),
      scopeMap: { primary: [] },
      findings: [],
      onEvent: (e) => events.push(e),
    });
    // Should fail (work item doesn't exist in queue) and emit fix_claim + fix_error
    assert.equal(result.status, "failed");
    assert.ok(result.error);
    assert.ok(result.signature.includes("Jules Tanaka"));
    assert.ok(events.some(e => e.event === "fix_claim"));
    assert.ok(events.some(e => e.event === "fix_error"));
    // Should NOT have jiraKey (never got past claim)
    assert.equal(result.jiraIssueKey, null);
  });

  it("fix-cycle result always includes Jules signature", async () => {
    const { runFixCycle } = await import("../src/agents/jules/fix-cycle.js");
    const result = await runFixCycle({
      workItemId: "sig-test-" + Date.now(),
      workItem: {},
      rootPath: process.cwd(),
      scopeMap: { primary: [] },
      findings: [],
    });
    assert.ok(result.signature.includes("Jules Tanaka"));
    assert.ok(result.signature.includes("SentinelLayer"));
  });
});

describe("error-intake scopeFromError", () => {
  it("extracts files from stack trace", async () => {
    const { scopeFromError } = await import("../src/agents/jules/error-intake.js");
    const scope = scopeFromError({ stackTrace: "Error\n    at App (src/app/page.tsx:42)\n    at Layout (src/app/layout.tsx:15)" });
    assert.ok(scope.primary.length >= 2);
    assert.ok(scope.primary.some(f => f.path.includes("page.tsx")));
    assert.ok(scope.primary.some(f => f.line === 42));
  });

  it("falls back to defaults without stack trace", async () => {
    const { scopeFromError } = await import("../src/agents/jules/error-intake.js");
    const scope = scopeFromError({ errorCode: "RENDER_ERROR" });
    assert.ok(scope.primary.length > 0);
    assert.ok(scope.primary.some(f => f.reason === "default_scope"));
  });

  it("includes secondary and tertiary scope always", async () => {
    const { scopeFromError } = await import("../src/agents/jules/error-intake.js");
    const scope = scopeFromError({});
    assert.ok(scope.secondary.length > 0);
    assert.ok(scope.tertiary.length > 0);
  });
});

describe("error-intake summarizeError", () => {
  it("builds readable summary with all fields", async () => {
    const { summarizeError } = await import("../src/agents/jules/error-intake.js");
    const s = summarizeError({
      errorCode: "HYDRATION", endpoint: "/dash", severity: "P1",
      service: "web", message: "Hydration mismatch", occurrenceCount: 5,
      stackTrace: "Error at page.tsx:42\n  at Layout\n  at Root",
    });
    assert.ok(s.includes("HYDRATION"));
    assert.ok(s.includes("/dash"));
    assert.ok(s.includes("P1"));
    assert.ok(s.includes("Occurrences: 5"));
    assert.ok(s.includes("page.tsx"));
  });

  it("handles minimal work item", async () => {
    const { summarizeError } = await import("../src/agents/jules/error-intake.js");
    const s = summarizeError({});
    assert.ok(s.includes("UNKNOWN"));
    assert.ok(s.includes("unknown"));
  });
});

describe("definition contract for fix cycle", () => {
  it("has fix tools including Shell and FileEdit", async () => {
    const { JULES_DEFINITION } = await import("../src/agents/jules/config/definition.js");
    assert.ok(JULES_DEFINITION.fixTools.includes("Shell"));
    assert.ok(JULES_DEFINITION.fixTools.includes("FileEdit"));
    assert.ok(JULES_DEFINITION.fixTools.includes("FileRead"));
  });

  it("has worktree permission mode for fixes", async () => {
    const { JULES_DEFINITION } = await import("../src/agents/jules/config/definition.js");
    assert.equal(JULES_DEFINITION.fixPermissionMode, "worktree");
  });

  it("signature includes persona and org", async () => {
    const { JULES_DEFINITION } = await import("../src/agents/jules/config/definition.js");
    assert.ok(JULES_DEFINITION.signature.includes("Jules Tanaka"));
    assert.ok(JULES_DEFINITION.signature.includes("SentinelLayer"));
    assert.ok(JULES_DEFINITION.signature.includes("Frontend"));
  });
});
