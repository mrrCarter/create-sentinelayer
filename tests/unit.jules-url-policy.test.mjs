import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertPermittedAuditTarget } from "../src/agents/jules/tools/url-policy.js";

describe("jules url policy", () => {
  it("allows public https targets", () => {
    const parsed = assertPermittedAuditTarget("https://example.com", { operation: "unit-test" });
    assert.equal(parsed.hostname, "example.com");
  });

  it("blocks private localhost target by default", () => {
    assert.throws(
      () => assertPermittedAuditTarget("http://localhost:3000", { operation: "unit-test" }),
      /Blocked private audit target/,
    );
  });

  it("blocks cloud metadata ip target by default", () => {
    assert.throws(
      () => assertPermittedAuditTarget("http://169.254.169.254/latest/meta-data", { operation: "unit-test" }),
      /Blocked private audit target/,
    );
  });

  it("allows private target with explicit flag", () => {
    const parsed = assertPermittedAuditTarget("http://localhost:3000", {
      operation: "unit-test",
      allowPrivateTargets: true,
    });
    assert.equal(parsed.hostname, "localhost");
  });
});
