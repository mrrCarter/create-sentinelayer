import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLineDiff,
  inferTemplateFromSpec,
  mergeSpecRegeneration,
  parseSpecSections,
  renderLineDiff,
} from "../src/spec/regenerate.js";

test("Unit: inferTemplateFromSpec resolves template id from SPEC preamble", () => {
  const markdown = ["# SPEC - Demo", "Template: api-service", "", "## Goal", "Ship v1"].join("\n");
  assert.equal(inferTemplateFromSpec(markdown), "api-service");
});

test("Unit: parseSpecSections splits preamble and level-2 sections deterministically", () => {
  const markdown = ["# SPEC - Demo", "Template: api-service", "", "## Goal", "Ship", "## Security", "Harden"].join(
    "\n"
  );
  const parsed = parseSpecSections(markdown);
  assert.match(parsed.preamble, /Template: api-service/);
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].headingText, "Goal");
  assert.equal(parsed.sections[1].headingText, "Security");
});

test("Unit: mergeSpecRegeneration preserves manual-edited sections and appends manual-only sections", () => {
  const existing = [
    "# SPEC - Demo",
    "Template: api-service",
    "",
    "## Goal",
    "Manual goal text from operator.",
    "",
    "## Security",
    "Generated security baseline v1.",
    "",
    "## Operator Notes",
    "<!-- sentinelayer:manual -->",
    "Keep this custom checklist.",
  ].join("\n");

  const regenerated = [
    "# SPEC - Demo",
    "Template: api-service",
    "",
    "## Goal",
    "Generated goal text v2.",
    "",
    "## Security",
    "Generated security baseline v2.",
    "",
    "## Phase Plan",
    "1. Foundation",
  ].join("\n");

  const merged = mergeSpecRegeneration({
    existingMarkdown: existing,
    regeneratedMarkdown: regenerated,
    preserveManual: true,
  });

  assert.equal(merged.changed, true);
  assert.match(merged.mergedMarkdown, /Manual goal text from operator\./);
  assert.match(merged.mergedMarkdown, /Generated security baseline v1\./);
  assert.match(merged.mergedMarkdown, /Keep this custom checklist\./);
  assert.match(merged.mergedMarkdown, /## Phase Plan/);
  assert.equal(merged.summary.preservedManualSections.includes("Goal"), true);
  assert.equal(merged.summary.preservedManualSections.includes("Security"), true);
  assert.equal(merged.summary.preservedManualOnlySections.includes("Operator Notes"), true);
});

test("Unit: buildLineDiff and renderLineDiff emit deterministic add/remove previews", () => {
  const before = ["# SPEC", "## Goal", "Ship v1"].join("\n");
  const after = ["# SPEC", "## Goal", "Ship v2", "## Phase Plan", "1. Foundation"].join("\n");
  const diff = buildLineDiff(before, after);
  const rendered = renderLineDiff(diff, { plain: true, maxLines: 20 });

  assert.equal(diff.changed, true);
  assert.equal(diff.added >= 2, true);
  assert.equal(diff.removed >= 1, true);
  assert.match(rendered, /\+ Ship v2/);
  assert.match(rendered, /- Ship v1/);
});
