import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  JULES_DEFINITION,
  PERSONA_VISUALS,
  resolvePersonaVisual,
  listPersonaIds,
  listPersonaNames,
} from "../src/agents/jules/config/definition.js";

describe("JULES_DEFINITION", () => {
  it("has required identity fields", () => {
    assert.equal(JULES_DEFINITION.id, "frontend");
    assert.equal(JULES_DEFINITION.persona, "Jules Tanaka");
    assert.equal(JULES_DEFINITION.domain, "frontend_runtime");
    assert.ok(JULES_DEFINITION.signature.includes("Jules Tanaka"));
  });

  it("has visual identity", () => {
    assert.equal(JULES_DEFINITION.color, "cyan");
    assert.ok(JULES_DEFINITION.avatar);
    assert.equal(JULES_DEFINITION.shortName, "Jules");
  });

  it("has budget with all 5 dimensions", () => {
    const b = JULES_DEFINITION.budget;
    assert.ok(b.maxCostUsd > 0);
    assert.ok(b.maxOutputTokens > 0);
    assert.ok(b.maxRuntimeMs > 0);
    assert.ok(b.maxToolCalls > 0);
    assert.ok(b.warningThresholdPercent > 0);
  });

  it("audit tools are read-only", () => {
    const tools = JULES_DEFINITION.auditTools;
    assert.ok(tools.includes("FileRead"));
    assert.ok(tools.includes("Grep"));
    assert.ok(tools.includes("Glob"));
    assert.ok(tools.includes("FrontendAnalyze"));
    assert.ok(!tools.includes("FileEdit"));
    assert.ok(!tools.includes("Shell"));
  });

  it("fix tools include write capabilities", () => {
    const tools = JULES_DEFINITION.fixTools;
    assert.ok(tools.includes("FileEdit"));
    assert.ok(tools.includes("Shell"));
  });

  it("has all three agent modes", () => {
    assert.ok(JULES_DEFINITION.modes.primary);
    assert.ok(JULES_DEFINITION.modes.secondary);
    assert.ok(JULES_DEFINITION.modes.tertiary);
  });

  it("has SWE framework thresholds", () => {
    const t = JULES_DEFINITION.thresholds;
    assert.equal(t.LCP_good_ms, 2500);
    assert.equal(t.useState_god, 16);
    assert.equal(t.component_loc_god, 700);
  });

  it("has severity examples for P0-P2", () => {
    assert.ok(JULES_DEFINITION.severityExamples.P0.length >= 3);
    assert.ok(JULES_DEFINITION.severityExamples.P1.length >= 3);
    assert.ok(JULES_DEFINITION.severityExamples.P2.length >= 3);
  });

  it("has automation safety with always-yellow-or-red list", () => {
    const safety = JULES_DEFINITION.automationSafety;
    assert.ok(safety.alwaysYellowOrRed.includes("auth flow"));
    assert.ok(safety.alwaysYellowOrRed.includes("payment UI"));
  });

  it("has swarm config with hunter types", () => {
    assert.ok(JULES_DEFINITION.swarm.hunterTypes.includes("xss"));
    assert.ok(JULES_DEFINITION.swarm.hunterTypes.includes("a11y"));
    assert.equal(JULES_DEFINITION.swarm.hunterTypes.length, 6);
  });
});

describe("PERSONA_VISUALS", () => {
  it("has all 13 personas", () => {
    assert.equal(Object.keys(PERSONA_VISUALS).length, 13);
  });

  it("each persona has color, avatar, shortName, fullName", () => {
    for (const [id, visual] of Object.entries(PERSONA_VISUALS)) {
      assert.ok(visual.color, `${id} missing color`);
      assert.ok(visual.avatar, `${id} missing avatar`);
      assert.ok(visual.shortName, `${id} missing shortName`);
      assert.ok(visual.fullName, `${id} missing fullName`);
    }
  });

  it("includes Jules with cyan color", () => {
    assert.equal(PERSONA_VISUALS.frontend.color, "cyan");
    assert.equal(PERSONA_VISUALS.frontend.shortName, "Jules");
  });

  it("includes Nina with red color", () => {
    assert.equal(PERSONA_VISUALS.security.color, "red");
    assert.equal(PERSONA_VISUALS.security.shortName, "Nina");
  });
});

describe("resolvePersonaVisual", () => {
  it("resolves by agent ID", () => {
    const result = resolvePersonaVisual("frontend");
    assert.equal(result.shortName, "Jules");
    assert.equal(result.id, "frontend");
  });

  it("resolves by first name (case insensitive)", () => {
    const result = resolvePersonaVisual("jules");
    assert.equal(result.id, "frontend");

    const result2 = resolvePersonaVisual("Nina");
    assert.equal(result2.id, "security");
  });

  it("resolves by full name", () => {
    const result = resolvePersonaVisual("Jules Tanaka");
    assert.equal(result.id, "frontend");
  });

  it("returns null for unknown", () => {
    assert.equal(resolvePersonaVisual("unknown"), null);
    assert.equal(resolvePersonaVisual(null), null);
    assert.equal(resolvePersonaVisual(""), null);
  });
});

describe("listPersonaIds", () => {
  it("returns all 13 persona IDs", () => {
    const ids = listPersonaIds();
    assert.equal(ids.length, 13);
    assert.ok(ids.includes("frontend"));
    assert.ok(ids.includes("security"));
    assert.ok(ids.includes("backend"));
  });
});

describe("listPersonaNames", () => {
  it("returns IDs + short names + full names", () => {
    const names = listPersonaNames();
    assert.ok(names.includes("frontend"));
    assert.ok(names.includes("jules"));
    assert.ok(names.includes("jules tanaka"));
    assert.ok(names.length >= 39); // 13 IDs + 13 short + 13 full
  });
});
