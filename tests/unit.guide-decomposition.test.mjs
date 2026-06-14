import test from "node:test";
import assert from "node:assert/strict";

import { generateBuildGuide, renderGuideExport } from "../src/guide/generator.js";

// A spec in the exact bulleted format the API builder emits today.
const BUILDER_SPEC = `# SPEC - Acme Realtime Dashboard

## Goal
Ship a realtime ops dashboard.

## Phase Plan
### Phase 0 (P0) — Repo Bootstrap & CI
- Objective: Establish deterministic scaffold, CI, and command lock.
- Dependencies: none
- Files: apps/web, .github/workflows
- Tests: smoke + lint.
- Evidence: CI green screenshot.

### Phase 1 (P1) — Domain Model & Persistence
- Objective: Define schema, migrations, persistence abstraction.
- Dependencies: P0
- Files: apps/api
- Tests: migration + repo tests.

### Phase 2 (P2) — Realtime Ingestion
- Objective: Stream ingestion + backpressure.
- Dependencies: P0-P1
- Files: workers
- Tests: load + integration.
`;

test("Unit decomposition: captures the builder's bulleted phase body (objective/files/tests)", () => {
  const guide = generateBuildGuide({ specMarkdown: BUILDER_SPEC, generatedAt: "2026-06-14T00:00:00Z" });
  assert.equal(guide.tickets.length, 3);
  const p2 = guide.tickets[2];
  // The structured fields land in the ticket body instead of being dropped.
  assert.match(p2.description, /Objective: Stream ingestion \+ backpressure\./);
  assert.match(p2.description, /Files: workers/);
  assert.match(p2.description, /Tests: load \+ integration\./);
});

test("Unit decomposition: derives real acceptance criteria from tests/evidence/objective", () => {
  const guide = generateBuildGuide({ specMarkdown: BUILDER_SPEC, generatedAt: "2026-06-14T00:00:00Z" });
  const p0 = guide.phases[0];
  assert.deepEqual(p0.acceptanceCriteria, [
    "Tests pass: smoke + lint.",
    "Evidence captured: CI green screenshot.",
    "Objective met: Establish deterministic scaffold, CI, and command lock.",
  ]);
  // No empty/placeholder criteria.
  assert.ok(!p0.acceptanceCriteria.includes("Phase outcomes are verified by deterministic checks."));
});

test("Unit decomposition: honors the declared dependency graph, not naive sequencing", () => {
  const guide = generateBuildGuide({ specMarkdown: BUILDER_SPEC, generatedAt: "2026-06-14T00:00:00Z" });
  // P0 declares "none" -> entry phase.
  assert.deepEqual(guide.tickets[0].dependencies, []);
  assert.deepEqual(guide.tickets[0].dependency_ids, []);
  // P2 declares "P0-P1" -> depends on BOTH (range expanded), not just the previous phase.
  assert.deepEqual(guide.tickets[2].dependency_ids, ["P0", "P1"]);
  assert.deepEqual(guide.tickets[2].dependencies, [
    "Phase 0 (P0) — Repo Bootstrap & CI",
    "Phase 1 (P1) — Domain Model & Persistence",
  ]);
});

test("Unit decomposition: captures the phase id and labels the ticket with it", () => {
  const guide = generateBuildGuide({ specMarkdown: BUILDER_SPEC, generatedAt: "2026-06-14T00:00:00Z" });
  assert.equal(guide.tickets[1].phase_id, "P1");
  assert.ok(guide.tickets[1].labels.includes("p1"));
});

test("Unit decomposition: a global Acceptance Criteria section still wins", () => {
  const spec = `# SPEC - With Global AC

## Goal
Do the thing.

## Acceptance Criteria
1. The system is observable.
2. The system is secure.

## Phase Plan
### Phase 0 (P0) — Bootstrap
- Objective: Scaffold.
- Dependencies: none
- Tests: smoke.
`;
  const guide = generateBuildGuide({ specMarkdown: spec, generatedAt: "2026-06-14T00:00:00Z" });
  assert.deepEqual(guide.phases[0].acceptanceCriteria, [
    "The system is observable.",
    "The system is secure.",
  ]);
});

test("Unit decomposition: no declared deps falls back to the previous phase", () => {
  const spec = `# SPEC - Legacy Numbered

## Goal
Legacy.

## Phase Plan
### Phase 1 - Foundation
1. Build the base.

### Phase 2 - Features
1. Build features.
`;
  const guide = generateBuildGuide({ specMarkdown: spec, generatedAt: "2026-06-14T00:00:00Z" });
  // Legacy numbered tasks are still captured.
  assert.deepEqual(guide.phases[0].tasks, ["Build the base."]);
  // With no declared deps, phase 2 falls back to depending on phase 1.
  assert.deepEqual(guide.tickets[1].dependencies, ["Phase 1 - Foundation"]);
  assert.deepEqual(guide.tickets[1].dependency_ids, []);
});

test("Unit decomposition: jira export carries the enriched description + dependencies", () => {
  const guide = generateBuildGuide({ specMarkdown: BUILDER_SPEC, generatedAt: "2026-06-14T00:00:00Z" });
  const jira = JSON.parse(renderGuideExport({ format: "jira", guide }));
  const issue = jira.issues[2];
  assert.match(issue.description, /Objective: Stream ingestion/);
  assert.deepEqual(issue.dependencies, [
    "Phase 0 (P0) — Repo Bootstrap & CI",
    "Phase 1 (P1) — Domain Model & Persistence",
  ]);
});
