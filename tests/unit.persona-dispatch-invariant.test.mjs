// Invariant: the authoritative FULL_DEPTH_PERSONAS list in scan-modes.js
// must match exactly the keys in PERSONA_PROMPTS and SWE_FRAMEWORK_CHECKLIST
// in persona-prompts.js. Any drift means a persona either:
//   (a) dispatches without a prompt → crashes at runtime
//   (b) dispatches without a checklist → loses coverage-proof guarantee
//   (c) has a prompt/checklist but never runs → dead code + misleading UX

import test from "node:test";
import assert from "node:assert/strict";

import { resolveScanMode } from "../src/review/scan-modes.js";
import { PERSONA_PROMPTS, SWE_FRAMEWORK_CHECKLIST, PERSONA_IDS } from "../src/review/persona-prompts.js";

function sortedKeys(obj) {
  return Object.keys(obj).slice().sort();
}

test("persona dispatch invariant: FULL_DEPTH personas exactly equal PERSONA_PROMPTS keys", () => {
  const fullDepth = resolveScanMode("full-depth").personas.slice().sort();
  const promptKeys = sortedKeys(PERSONA_PROMPTS);
  assert.deepEqual(fullDepth, promptKeys);
});

test("persona dispatch invariant: FULL_DEPTH personas exactly equal SWE_FRAMEWORK_CHECKLIST keys", () => {
  const fullDepth = resolveScanMode("full-depth").personas.slice().sort();
  const checklistKeys = sortedKeys(SWE_FRAMEWORK_CHECKLIST);
  assert.deepEqual(fullDepth, checklistKeys);
});

test("persona dispatch invariant: PERSONA_IDS export matches PERSONA_PROMPTS keys", () => {
  const ids = PERSONA_IDS.slice().sort();
  const keys = sortedKeys(PERSONA_PROMPTS);
  assert.deepEqual(ids, keys);
});

test("persona dispatch invariant: deep alias has the same roster as full-depth", () => {
  const deep = resolveScanMode("deep").personas.slice().sort();
  const fullDepth = resolveScanMode("full-depth").personas.slice().sort();
  assert.deepEqual(deep, fullDepth);
});

test("persona dispatch invariant: baseline is security-only", () => {
  const baseline = resolveScanMode("baseline").personas;
  assert.deepEqual(baseline, ["security"]);
});
