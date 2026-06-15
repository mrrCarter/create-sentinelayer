import test from "node:test";
import assert from "node:assert/strict";

import { generateBuildGuide } from "../src/guide/generator.js";
import {
  enrichGuideTickets,
  enrichPhase,
  extractJsonArray,
} from "../src/guide/enrich.js";

const SPEC = `# SPEC - Enrich Demo

## Goal
Ship it.

## Phase Plan
### Phase 0 (P0) — Bootstrap
- Objective: Scaffold + CI.
- Dependencies: none
- Tests: smoke.

### Phase 1 (P1) — Persistence
- Objective: Schema + migrations.
- Dependencies: P0
- Tests: migration tests.
`;

function mockClient(responder) {
  return { invoke: async (args) => ({ text: responder(args) }) };
}

const TWO_PR_JSON = JSON.stringify([
  { title: "Add CI workflow", summary: "Wire CI.", acceptance_criteria: ["CI green", "lint passes"] },
  { title: "Add command lock", summary: "Pin commands.", acceptance_criteria: ["lockfile present"] },
]);

test("Unit enrich extractJsonArray: tolerates fences and prose", () => {
  assert.deepEqual(extractJsonArray('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('Sure!\n[{"a":1}]\nHope that helps'), [{ a: 1 }]);
  assert.equal(extractJsonArray("not json"), null);
  assert.equal(extractJsonArray("[broken"), null);
});

test("Unit enrich enrichPhase: returns normalized sub-tickets, caps count", async () => {
  const client = mockClient(() => TWO_PR_JSON);
  const subs = await enrichPhase({
    phase: { title: "Phase 0", fields: { objective: "x" }, tasks: [] },
    client,
    maxTicketsPerPhase: 1,
  });
  assert.equal(subs.length, 1); // capped to 1
  assert.equal(subs[0].title, "Add CI workflow");
  assert.deepEqual(subs[0].acceptanceCriteria, ["CI green", "lint passes"]);
});

test("Unit enrich enrichPhase: bad JSON or no client → null (fallback)", async () => {
  assert.equal(await enrichPhase({ phase: {}, client: mockClient(() => "nonsense") }), null);
  assert.equal(await enrichPhase({ phase: {}, client: null }), null);
  const thrower = { invoke: async () => { throw new Error("boom"); } };
  assert.equal(await enrichPhase({ phase: {}, client: thrower }), null);
});

test("Unit enrich enrichGuideTickets: expands phases into per-PR tickets", async () => {
  const guide = generateBuildGuide({ specMarkdown: SPEC, generatedAt: "2026-06-15T00:00:00Z" });
  const client = mockClient(() => TWO_PR_JSON);
  const { tickets, enrichedPhases } = await enrichGuideTickets({ guide, client });
  assert.equal(enrichedPhases, 2);
  // 2 phases × 2 PRs = 4 tickets.
  assert.equal(tickets.length, 4);
  assert.equal(tickets[0].id, "phase-1.1");
  assert.equal(tickets[1].id, "phase-1.2");
  assert.ok(tickets[0].labels.includes("pr"));
  // First sub inherits phase deps (none for P0); second sub depends on the first.
  assert.deepEqual(tickets[0].dependencies, []);
  assert.deepEqual(tickets[1].dependencies, ["Add CI workflow"]);
  assert.match(tickets[0].description, /Acceptance criteria:/);
});

test("Unit enrich enrichGuideTickets: a failing phase keeps its heuristic ticket", async () => {
  const guide = generateBuildGuide({ specMarkdown: SPEC, generatedAt: "2026-06-15T00:00:00Z" });
  // Enrich only the first phase; second returns junk → falls back.
  let call = 0;
  const client = mockClient(() => (call++ === 0 ? TWO_PR_JSON : "garbage"));
  const { tickets, enrichedPhases } = await enrichGuideTickets({ guide, client });
  assert.equal(enrichedPhases, 1);
  // phase 0 → 2 PRs, phase 1 → its original single heuristic ticket.
  assert.equal(tickets.length, 3);
  assert.equal(tickets[2].id, "phase-2"); // heuristic ticket id preserved
});

test("Unit enrich enrichGuideTickets: respects maxPhases cap", async () => {
  const guide = generateBuildGuide({ specMarkdown: SPEC, generatedAt: "2026-06-15T00:00:00Z" });
  const client = mockClient(() => TWO_PR_JSON);
  const { tickets, enrichedPhases } = await enrichGuideTickets({
    guide,
    client,
    limits: { maxPhases: 1 },
  });
  assert.equal(enrichedPhases, 1); // only phase 0 enriched
  assert.equal(tickets.length, 3); // 2 PRs + 1 heuristic ticket
});
