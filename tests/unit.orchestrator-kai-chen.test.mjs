// Unit tests for the Kai Chen orchestrator definition + prompt builder.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ORCHESTRATOR_DEFINITION,
  buildOrchestratorPrompt,
  KAI_CHEN_OUTPUT_SIGNATURE_VALUE,
} from "../src/orchestrator/kai-chen.js";
import {
  ORCHESTRATOR_VISUALS,
  resolveOrchestratorVisual,
} from "../src/agents/persona-visuals.js";

test("Orchestrator: definition has required fields", () => {
  assert.equal(ORCHESTRATOR_DEFINITION.id, "orchestrator-kai-chen");
  assert.equal(ORCHESTRATOR_DEFINITION.name, "Dr. Kai Chen");
  assert.equal(ORCHESTRATOR_DEFINITION.shortName, "Kai");
  assert.equal(ORCHESTRATOR_DEFINITION.model, "claude-opus-4-6");
  assert.equal(ORCHESTRATOR_DEFINITION.modelProvider, "anthropic");
  assert.ok(Array.isArray(ORCHESTRATOR_DEFINITION.bias));
  assert.ok(ORCHESTRATOR_DEFINITION.bias.length >= 3);
  assert.ok(Array.isArray(ORCHESTRATOR_DEFINITION.toneRules));
  assert.ok(ORCHESTRATOR_DEFINITION.toneRules.length >= 3);
  assert.ok(typeof ORCHESTRATOR_DEFINITION.systemPrompt === "string");
  assert.ok(ORCHESTRATOR_DEFINITION.systemPrompt.length > 100);
});

test("Orchestrator: definition is frozen (immutable)", () => {
  assert.ok(Object.isFrozen(ORCHESTRATOR_DEFINITION));
  assert.ok(Object.isFrozen(ORCHESTRATOR_DEFINITION.bias));
  assert.ok(Object.isFrozen(ORCHESTRATOR_DEFINITION.toneRules));
});

test("Orchestrator: output signature is the Kai phrasing", () => {
  assert.equal(
    KAI_CHEN_OUTPUT_SIGNATURE_VALUE,
    "Here's what breaks, where, why, and what to do next.",
  );
  assert.equal(
    ORCHESTRATOR_DEFINITION.outputSignature,
    KAI_CHEN_OUTPUT_SIGNATURE_VALUE,
  );
});

test("Orchestrator: system prompt excludes code-gen / OpenAI / Gemini model routing", () => {
  // Kai routes only to Anthropic (Opus 4.6). Ensures we never accidentally
  // leak an OpenAI or Gemini model reference in the prompt body.
  const sp = ORCHESTRATOR_DEFINITION.systemPrompt.toLowerCase();
  assert.ok(!sp.includes("gpt-5"));
  assert.ok(!sp.includes("codex"));
  assert.ok(!sp.includes("gemini"));
});

test("buildOrchestratorPrompt: includes run context", () => {
  const prompt = buildOrchestratorPrompt({
    targetPath: "/repos/example",
    mode: "full-depth",
    dispatchedPersonas: ["security", "backend", "data-layer"],
    deterministicSummary: { P0: 0, P1: 2, P2: 5, P3: 10 },
  });
  assert.ok(prompt.includes("Target: /repos/example"));
  assert.ok(prompt.includes("Mode: full-depth"));
  assert.ok(prompt.includes("P0=0 P1=2 P2=5 P3=10"));
  assert.ok(prompt.includes("- security"));
  assert.ok(prompt.includes("- backend"));
  assert.ok(prompt.includes("- data-layer"));
});

test("buildOrchestratorPrompt: handles empty defaults", () => {
  const prompt = buildOrchestratorPrompt();
  assert.ok(prompt.includes("Target: (not provided)"));
  assert.ok(prompt.includes("Mode: deep"));
  assert.ok(prompt.includes("P0=0 P1=0 P2=0 P3=0"));
  assert.ok(prompt.includes("(none specified)"));
});

test("buildOrchestratorPrompt: embeds the full system prompt", () => {
  const prompt = buildOrchestratorPrompt({ targetPath: "/x" });
  assert.ok(prompt.includes("You are Dr. Kai Chen"));
  assert.ok(prompt.includes(KAI_CHEN_OUTPUT_SIGNATURE_VALUE));
});

test("Orchestrator visuals: Kai Chen entry exists", () => {
  assert.ok(ORCHESTRATOR_VISUALS["kai-chen"]);
  const v = ORCHESTRATOR_VISUALS["kai-chen"];
  assert.equal(v.shortName, "Kai");
  assert.equal(v.fullName, "Dr. Kai Chen");
  assert.equal(v.domain, "orchestration");
  assert.ok(v.color);
  assert.ok(v.avatar);
});

test("Orchestrator visuals: resolveOrchestratorVisual by id / shortName / fullName", () => {
  const byId = resolveOrchestratorVisual("kai-chen");
  assert.ok(byId);
  assert.equal(byId.shortName, "Kai");

  const byShort = resolveOrchestratorVisual("Kai");
  assert.ok(byShort);
  assert.equal(byShort.id, "kai-chen");

  const byFull = resolveOrchestratorVisual("Dr. Kai Chen");
  assert.ok(byFull);
  assert.equal(byFull.id, "kai-chen");

  assert.equal(resolveOrchestratorVisual("unknown"), null);
  assert.equal(resolveOrchestratorVisual(""), null);
  assert.equal(resolveOrchestratorVisual(null), null);
});

test("Orchestrator visuals: kept separate from PERSONA_VISUALS (dispatch invariant stays pure)", async () => {
  // kai-chen must NOT accidentally appear in the review-persona dispatch list.
  const { PERSONA_VISUALS } = await import("../src/agents/persona-visuals.js");
  assert.equal(PERSONA_VISUALS["kai-chen"], undefined);
  assert.equal(PERSONA_VISUALS["orchestrator"], undefined);
  assert.equal(PERSONA_VISUALS["orchestrator-kai-chen"], undefined);
});
