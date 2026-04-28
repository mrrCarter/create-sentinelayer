import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPersonaReviewPrompt,
  ELEVEN_LENS_EVIDENCE_APPENDIX,
  PERSONA_IDS,
} from "../src/review/persona-prompts.js";

test("Unit persona prompts: every OmarGate persona receives the 11-lens evidence contract", () => {
  assert.ok(PERSONA_IDS.length >= 13);
  assert.match(ELEVEN_LENS_EVIDENCE_APPENDIX, /A\. Route\/runtime boundary integrity/);
  assert.match(ELEVEN_LENS_EVIDENCE_APPENDIX, /K\. AI governance, provenance, HITL/);

  for (const personaId of PERSONA_IDS) {
    const prompt = buildPersonaReviewPrompt({
      personaId,
      targetPath: "/repo",
      deterministicSummary: { P0: 0, P1: 1, P2: 2, P3: 3 },
    });

    assert.match(prompt, /11-lens evidence contract/, personaId);
    assert.match(prompt, /lensEvidence/, personaId);
    assert.match(prompt, /reproduction/, personaId);
    assert.match(prompt, /user_impact/, personaId);
    assert.match(prompt, /trafficLight/, personaId);
    assert.match(prompt, /A\. Route\/runtime boundary integrity/, personaId);
    assert.match(prompt, /K\. AI governance, provenance, HITL/, personaId);
  }
});

test("Unit persona prompts: unknown personas also get the generic 11-lens contract", () => {
  const prompt = buildPersonaReviewPrompt({
    personaId: "unknown-persona",
    targetPath: "/repo",
    deterministicSummary: { P0: 0, P1: 0, P2: 0 },
  });

  assert.match(prompt, /11-lens evidence contract/);
  assert.match(prompt, /lensEvidence/);
  assert.match(prompt, /trafficLight/);
});
