import test from "node:test";
import assert from "node:assert/strict";

// Read the loop.js source to verify blind-first architecture
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const loopSource = readFileSync(
  join(__dirname, "../src/agents/jules/loop.js"),
  "utf-8",
);

test("Blind-first: initial context does NOT inject omarBaseline findings", () => {
  // The initial context assembly (before the while loop) must not contain
  // Omar baseline finding content. Baseline reconciliation must happen AFTER
  // the independent analysis completes.
  const contextBlock = loopSource.slice(
    loopSource.indexOf("// Build context for LLM"),
    loopSource.indexOf("const messages = ["),
  );

  // Must NOT reference omarBaseline in the initial context
  assert.ok(
    !contextBlock.includes("omarBaseline"),
    "Initial context must not reference omarBaseline — blind-first violation",
  );

  // Must NOT reference baselineFindings in the initial context
  assert.ok(
    !contextBlock.includes("baselineFindings"),
    "Initial context must not reference baselineFindings — blind-first violation",
  );

  // Must NOT inject Omar finding titles/messages into contextParts
  assert.ok(
    !contextBlock.includes("Omar baseline findings"),
    "Initial context must not contain Omar baseline findings header",
  );
});

test("Blind-first: initial context does NOT inject swarm findings", () => {
  const contextBlock = loopSource.slice(
    loopSource.indexOf("// Build context for LLM"),
    loopSource.indexOf("const messages = ["),
  );

  assert.ok(
    !contextBlock.includes("swarmFindings"),
    "Initial context must not reference swarmFindings — blind-first violation",
  );

  assert.ok(
    !contextBlock.includes("Sub-agent findings"),
    "Initial context must not contain sub-agent findings header",
  );
});

test("Blind-first: memory recall IS allowed in initial context", () => {
  const contextBlock = loopSource.slice(
    loopSource.indexOf("// Build context for LLM"),
    loopSource.indexOf("const messages = ["),
  );

  // Memory recall (past run context) is allowed — it's not current-run anchoring
  assert.ok(
    contextBlock.includes("memory"),
    "Memory recall should be present in initial context",
  );
});

test("Blind-first: reconciliation phase exists AFTER analysis loop", () => {
  const reconcileIndex = loopSource.indexOf("Phase 2b: Reconciliation");
  const analysisLoopEnd = loopSource.indexOf("Phase 3: Build final report");

  assert.ok(reconcileIndex > 0, "Reconciliation phase must exist");
  assert.ok(analysisLoopEnd > 0, "Phase 3 must exist");
  assert.ok(
    reconcileIndex < analysisLoopEnd,
    "Reconciliation must come AFTER analysis loop but BEFORE final report",
  );
});

test("Blind-first: reconciliation references both swarm and baseline", () => {
  const reconcileBlock = loopSource.slice(
    loopSource.indexOf("Phase 2b: Reconciliation"),
    loopSource.indexOf("Phase 3: Build final report"),
  );

  assert.ok(
    reconcileBlock.includes("swarmFindings"),
    "Reconciliation must cross-reference swarm findings",
  );

  assert.ok(
    reconcileBlock.includes("baselineFindings") || reconcileBlock.includes("omarBaseline"),
    "Reconciliation must cross-reference Omar baseline",
  );
});

test("Output contract includes reproduction, user_impact, confidence", () => {
  const promptSource = readFileSync(
    join(__dirname, "../src/agents/jules/config/system-prompt.js"),
    "utf-8",
  );

  assert.ok(
    promptSource.includes('"reproduction"'),
    "Output contract must include reproduction field",
  );

  assert.ok(
    promptSource.includes('"user_impact"'),
    "Output contract must include user_impact field",
  );

  assert.ok(
    promptSource.includes('"confidence"'),
    "Output contract must include confidence field",
  );
});

test("Definition evidenceRequirements aligned with output contract", () => {
  const defSource = readFileSync(
    join(__dirname, "../src/agents/jules/config/definition.js"),
    "utf-8",
  );

  // Must include the key contract fields
  assert.ok(defSource.includes("user_impact"), "evidenceRequirements must include user_impact");
  assert.ok(defSource.includes("confidence"), "evidenceRequirements must include confidence");
  assert.ok(defSource.includes("evidence"), "evidenceRequirements must include evidence");
});
