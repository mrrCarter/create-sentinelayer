// Unit tests for coord/priority.js (#A9 priority ladder).

import test from "node:test";
import assert from "node:assert/strict";

import {
  PERSONA_PRIORITY,
  lowestPriorityAgent,
  outranks,
  priorityIndex,
} from "../src/coord/priority.js";

test("PERSONA_PRIORITY is frozen and contains the 13 canon slots", () => {
  assert.ok(Object.isFrozen(PERSONA_PRIORITY));
  assert.equal(PERSONA_PRIORITY.length, 13);
  assert.equal(PERSONA_PRIORITY[0], "architect");
  assert.equal(PERSONA_PRIORITY[PERSONA_PRIORITY.length - 1], "docs");
});

test("priorityIndex: known agents map to their slot", () => {
  assert.equal(priorityIndex("architect"), 0);
  assert.equal(priorityIndex("auth"), 2);
  assert.equal(priorityIndex("docs"), 12);
});

test("priorityIndex: unknown / empty agents sort below every known persona", () => {
  assert.equal(priorityIndex("unknown"), PERSONA_PRIORITY.length);
  assert.equal(priorityIndex(""), PERSONA_PRIORITY.length);
  assert.equal(priorityIndex(null), PERSONA_PRIORITY.length);
  assert.equal(priorityIndex(undefined), PERSONA_PRIORITY.length);
});

test("priorityIndex: normalizes case + whitespace", () => {
  assert.equal(priorityIndex(" Architect "), 0);
  assert.equal(priorityIndex("BACKEND"), priorityIndex("backend"));
});

test("outranks: higher ranked preempts lower", () => {
  assert.equal(outranks("architect", "docs"), true);
  assert.equal(outranks("database", "ui"), true);
  assert.equal(outranks("docs", "architect"), false);
});

test("outranks: equal priorities never preempt (ties lose)", () => {
  assert.equal(outranks("backend", "backend"), false);
  assert.equal(outranks("UNKNOWN", "other-unknown"), false);
});

test("lowestPriorityAgent: picks the tail-most persona", () => {
  assert.equal(
    lowestPriorityAgent(["architect", "auth", "docs", "backend"]),
    "docs"
  );
});

test("lowestPriorityAgent: deterministic on ties (unknown agents tied at bottom)", () => {
  // Two unknowns both sort at priorityIndex=length; alphabetical secondary
  // sort picks the lexicographically-first id so deadlock breaking is
  // stable across hosts.
  assert.equal(lowestPriorityAgent(["zulu", "alpha"]), "alpha");
});

test("lowestPriorityAgent: returns null for empty input", () => {
  assert.equal(lowestPriorityAgent([]), null);
  assert.equal(lowestPriorityAgent(null), null);
});

test("lowestPriorityAgent: ignores empty / whitespace entries", () => {
  assert.equal(
    lowestPriorityAgent(["architect", "", "   ", "backend"]),
    "backend"
  );
});
