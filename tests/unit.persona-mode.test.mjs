// Unit tests for src/agents/mode.js (#A27 audit|codegen invariance).
//
// The goal: show that every persona's surface is identical between modes
// EXCEPT the two well-defined deltas (allowed-tools + prompt-suffix).
// Anything else diverging means a regression.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEGEN_EXTRA_TOOLS,
  MODE_PROMPT_SUFFIXES,
  PERSONA_MODES,
  READONLY_BASELINE,
  buildPersonaConfigForMode,
  listKnownPersonaIds,
  modeAllowsWrites,
  normalizePersonaMode,
} from "../src/agents/mode.js";

test("PERSONA_MODES is exactly audit + codegen", () => {
  assert.deepEqual([...PERSONA_MODES].sort(), ["audit", "codegen"]);
});

test("normalizePersonaMode: recognizes both modes, defaults to audit", () => {
  assert.equal(normalizePersonaMode("audit"), "audit");
  assert.equal(normalizePersonaMode("codegen"), "codegen");
  assert.equal(normalizePersonaMode("AUDIT"), "audit");
  assert.equal(normalizePersonaMode("  codegen  "), "codegen");
  assert.equal(normalizePersonaMode(""), "audit");
  assert.equal(normalizePersonaMode("something-else"), "audit");
});

test("listKnownPersonaIds: surfaces the 12 non-frontend personas", () => {
  const ids = listKnownPersonaIds();
  assert.equal(ids.length, 12);
  for (const expected of [
    "security",
    "backend",
    "testing",
    "code-quality",
    "data-layer",
    "documentation",
    "reliability",
    "release",
    "observability",
    "infrastructure",
    "supply-chain",
    "ai-governance",
  ]) {
    assert.ok(ids.includes(expected), `expected persona id ${expected}`);
  }
});

test("buildPersonaConfigForMode: audit excludes write tools", () => {
  const cfg = buildPersonaConfigForMode("security", "audit");
  for (const writeTool of CODEGEN_EXTRA_TOOLS) {
    assert.ok(!cfg.allowedTools.includes(writeTool), `${writeTool} must not be in audit mode`);
  }
});

test("buildPersonaConfigForMode: codegen includes write tools on top of audit", () => {
  const audit = buildPersonaConfigForMode("security", "audit");
  const codegen = buildPersonaConfigForMode("security", "codegen");
  for (const tool of audit.allowedTools) {
    assert.ok(codegen.allowedTools.includes(tool), `codegen should retain ${tool}`);
  }
  for (const writeTool of CODEGEN_EXTRA_TOOLS) {
    assert.ok(codegen.allowedTools.includes(writeTool), `codegen must include ${writeTool}`);
  }
});

test("buildPersonaConfigForMode: read-only baseline always present in both modes", () => {
  for (const mode of PERSONA_MODES) {
    const cfg = buildPersonaConfigForMode("testing", mode);
    for (const tool of READONLY_BASELINE) {
      assert.ok(cfg.allowedTools.includes(tool), `${tool} missing in ${mode}`);
    }
  }
});

test("buildPersonaConfigForMode: all 12 personas exposed in both modes", () => {
  for (const personaId of listKnownPersonaIds()) {
    for (const mode of PERSONA_MODES) {
      const cfg = buildPersonaConfigForMode(personaId, mode);
      assert.equal(cfg.personaId, personaId);
      assert.equal(cfg.mode, mode);
      // The domain tool subset should be the same across modes for a given
      // persona.
      assert.ok(cfg.allowedTools.length > READONLY_BASELINE.length);
    }
  }
});

test("buildPersonaConfigForMode: prompt suffix differs by mode, same for same mode", () => {
  const a = buildPersonaConfigForMode("security", "audit");
  const b = buildPersonaConfigForMode("backend", "audit");
  const c = buildPersonaConfigForMode("security", "codegen");
  assert.equal(a.promptSuffix, b.promptSuffix); // same suffix across personas in same mode
  assert.notEqual(a.promptSuffix, c.promptSuffix); // differs by mode
  assert.ok(a.promptSuffix.includes("AUDIT"));
  assert.ok(c.promptSuffix.includes("CODE-GEN"));
});

test("buildPersonaConfigForMode: unknown persona still returns a valid config", () => {
  const cfg = buildPersonaConfigForMode("definitely-unknown", "audit");
  assert.equal(cfg.personaId, "definitely-unknown");
  // Still has the read-only baseline even though no domain tools exist.
  assert.deepEqual(cfg.allowedTools.sort(), [...READONLY_BASELINE].sort());
});

test("INVARIANT: audit ⊆ codegen for every persona", () => {
  // Formalizes spec §A27: code-gen mode is a strict superset of audit —
  // never removes tools, only adds.
  for (const personaId of listKnownPersonaIds()) {
    const audit = new Set(buildPersonaConfigForMode(personaId, "audit").allowedTools);
    const codegen = new Set(buildPersonaConfigForMode(personaId, "codegen").allowedTools);
    for (const tool of audit) {
      assert.ok(
        codegen.has(tool),
        `Invariant broken: ${personaId} audit mode includes ${tool} but codegen does not`
      );
    }
  }
});

test("INVARIANT: only the two deltas differ across modes", () => {
  // For every persona, everything-except-the-documented-deltas should match.
  for (const personaId of listKnownPersonaIds()) {
    const audit = buildPersonaConfigForMode(personaId, "audit");
    const codegen = buildPersonaConfigForMode(personaId, "codegen");
    assert.equal(audit.personaId, codegen.personaId);
    // allowedTools should differ ONLY by the codegen-extra-tools set.
    const auditSet = new Set(audit.allowedTools);
    const codegenSet = new Set(codegen.allowedTools);
    const extras = [...codegenSet].filter((t) => !auditSet.has(t));
    assert.deepEqual(extras.sort(), [...CODEGEN_EXTRA_TOOLS].sort());
    // promptSuffix differs by design.
    assert.notEqual(audit.promptSuffix, codegen.promptSuffix);
  }
});

test("modeAllowsWrites: audit=false, codegen=true", () => {
  assert.equal(modeAllowsWrites("audit"), false);
  assert.equal(modeAllowsWrites("codegen"), true);
  assert.equal(modeAllowsWrites("unknown"), false);
});

test("MODE_PROMPT_SUFFIXES: each entry is a non-empty string", () => {
  for (const mode of PERSONA_MODES) {
    const suffix = MODE_PROMPT_SUFFIXES[mode];
    assert.equal(typeof suffix, "string");
    assert.ok(suffix.length > 40);
  }
});
