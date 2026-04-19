// Unit tests for per-persona CLI filtering (PR #A-CLI-1 library layer).
// CLI-flag wiring in src/commands/omargate.js + buildLegacyArgs lands in a
// follow-up PR; this PR only exposes the library capability + wires the
// orchestrator function signature to accept the new options.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parsePersonaCsv,
  resolveFilteredPersonas,
  resolveScanMode,
  AVAILABLE_SCAN_MODES,
} from "../src/review/scan-modes.js";

test("parsePersonaCsv: null / undefined / empty returns []", () => {
  assert.deepEqual(parsePersonaCsv(null), []);
  assert.deepEqual(parsePersonaCsv(undefined), []);
  assert.deepEqual(parsePersonaCsv(""), []);
  assert.deepEqual(parsePersonaCsv("   "), []);
});

test("parsePersonaCsv: trims, lowercases, drops empty", () => {
  assert.deepEqual(
    parsePersonaCsv(" Security , BACKEND,  data-layer , "),
    ["security", "backend", "data-layer"],
  );
});

test("parsePersonaCsv: deduplicates", () => {
  assert.deepEqual(
    parsePersonaCsv("security,backend,security,SECURITY"),
    ["security", "backend"],
  );
});

test("parsePersonaCsv: accepts array input", () => {
  assert.deepEqual(
    parsePersonaCsv(["Security", "Backend"]),
    ["security", "backend"],
  );
});

test("resolveFilteredPersonas: no options returns base scan-mode roster", () => {
  const { personas: base } = resolveScanMode("full-depth");
  const { personas, dropped, unknown } = resolveFilteredPersonas("full-depth");
  assert.deepEqual(personas, base);
  assert.deepEqual(dropped, []);
  assert.deepEqual(unknown, []);
});

test("resolveFilteredPersonas: includeOnly narrows to subset (preserving base order)", () => {
  const { personas } = resolveFilteredPersonas("full-depth", {
    includeOnly: ["security", "backend", "data-layer"],
  });
  assert.deepEqual(personas, ["security", "backend", "data-layer"]);
});

test("resolveFilteredPersonas: includeOnly with unknown IDs tracks them in `unknown`", () => {
  const { personas, unknown } = resolveFilteredPersonas("full-depth", {
    includeOnly: ["security", "architecture", "typo-persona"],
  });
  // "architecture" and "typo-persona" aren't in the canon — silently dropped
  // but surfaced so callers can warn.
  assert.deepEqual(personas, ["security"]);
  assert.deepEqual(unknown.sort(), ["architecture", "typo-persona"]);
});

test("resolveFilteredPersonas: skipPersonas excludes specified", () => {
  const { personas, dropped } = resolveFilteredPersonas("full-depth", {
    skipPersonas: ["documentation", "ai-governance"],
  });
  assert.ok(!personas.includes("documentation"));
  assert.ok(!personas.includes("ai-governance"));
  assert.equal(personas.length, 11);
  assert.deepEqual(dropped.sort(), ["ai-governance", "documentation"]);
});

test("resolveFilteredPersonas: includeOnly + skipPersonas compose (include then skip)", () => {
  const { personas, dropped } = resolveFilteredPersonas("full-depth", {
    includeOnly: ["security", "backend", "data-layer"],
    skipPersonas: ["backend"],
  });
  assert.deepEqual(personas, ["security", "data-layer"]);
  assert.deepEqual(dropped, ["backend"]);
});

test("resolveFilteredPersonas: baseline mode only has security; filtering is inert", () => {
  const { personas, dropped, unknown } = resolveFilteredPersonas("baseline", {
    includeOnly: ["security", "backend"],
  });
  assert.deepEqual(personas, ["security"]);
  assert.deepEqual(dropped, []);
  assert.ok(unknown.includes("backend"));
});

test("resolveFilteredPersonas: unknown mode throws (delegates to resolveScanMode)", () => {
  assert.throws(() => resolveFilteredPersonas("nonexistent"), /Unknown scan mode/);
});

test("resolveFilteredPersonas: string inputs are normalized case-insensitively", () => {
  const { personas } = resolveFilteredPersonas("full-depth", {
    includeOnly: ["SECURITY", "  Backend  "],
  });
  assert.deepEqual(personas, ["security", "backend"]);
});

test("resolveFilteredPersonas: empty include / empty skip are no-ops", () => {
  const base = resolveScanMode("full-depth").personas;
  const r1 = resolveFilteredPersonas("full-depth", { includeOnly: [] });
  assert.deepEqual(r1.personas, base);
  const r2 = resolveFilteredPersonas("full-depth", { skipPersonas: [] });
  assert.deepEqual(r2.personas, base);
});

test("AVAILABLE_SCAN_MODES includes all four modes", () => {
  assert.ok(AVAILABLE_SCAN_MODES.includes("baseline"));
  assert.ok(AVAILABLE_SCAN_MODES.includes("deep"));
  assert.ok(AVAILABLE_SCAN_MODES.includes("full-depth"));
  assert.ok(AVAILABLE_SCAN_MODES.includes("audit"));
});
