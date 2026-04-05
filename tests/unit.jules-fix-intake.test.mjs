import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("fix-cycle module", () => {
  it("exports runFixCycle", async () => {
    const mod = await import("../src/agents/jules/fix-cycle.js");
    assert.ok(typeof mod.runFixCycle === "function");
  });
});

describe("error-intake scopeFromError", () => {
  it("extracts files from stack trace", async () => {
    const { scopeFromError } = await import("../src/agents/jules/error-intake.js");
    const scope = scopeFromError({ stackTrace: "Error\n    at App (src/app/page.tsx:42)\n    at Layout (src/app/layout.tsx:15)" });
    assert.ok(scope.primary.length >= 2);
    assert.ok(scope.primary.some(f => f.path.includes("page.tsx")));
  });

  it("falls back to defaults without stack trace", async () => {
    const { scopeFromError } = await import("../src/agents/jules/error-intake.js");
    const scope = scopeFromError({ errorCode: "RENDER_ERROR" });
    assert.ok(scope.primary.length > 0);
    assert.ok(scope.primary.some(f => f.reason === "default_scope"));
  });
});

describe("error-intake summarizeError", () => {
  it("builds readable summary", async () => {
    const { summarizeError } = await import("../src/agents/jules/error-intake.js");
    const s = summarizeError({ errorCode: "HYDRATION", endpoint: "/dash", severity: "P1", occurrenceCount: 5 });
    assert.ok(s.includes("HYDRATION"));
    assert.ok(s.includes("Occurrences: 5"));
  });
});

describe("definition contract", () => {
  it("has fix tools and signature", async () => {
    const { JULES_DEFINITION } = await import("../src/agents/jules/config/definition.js");
    assert.ok(JULES_DEFINITION.fixTools.includes("Shell"));
    assert.equal(JULES_DEFINITION.fixPermissionMode, "worktree");
    assert.ok(JULES_DEFINITION.signature.includes("Jules Tanaka"));
  });
});
