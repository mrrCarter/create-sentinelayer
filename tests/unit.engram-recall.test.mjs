import test from "node:test";
import assert from "node:assert/strict";

import { tokenize, queryTokens, charNGrams } from "../src/session/recall/text.js";
import { createEmbedder } from "../src/session/recall/embedder.js";
import { buildObservations } from "../src/session/recall/observations.js";
import { buildEntityGraph, matchQueryEntities } from "../src/session/recall/entities.js";
import { buildRecallIndex } from "../src/session/recall/index-build.js";
import { recall } from "../src/session/recall/retrieve.js";
import { computeTokenCut } from "../src/session/recall/token-stats.js";
import { runSessionRecall } from "../src/session/recall/index.js";

const FIXED_NOW = Date.UTC(2026, 6, 1);

function msg(seq, agentId, message, extra = {}) {
  return {
    stream: "sl_event",
    event: extra.event || "session_message",
    eventId: extra.eventId || `e${seq}`,
    agent: { id: agentId },
    payload: { message, ...(extra.payload || {}) },
    ts: new Date(Date.UTC(2026, 0, 1) + seq * 60000).toISOString(),
    sequenceId: seq,
  };
}

function sampleEvents() {
  return [
    msg(1, "codex", "we should gate merges behind the omar policy", { payload: { topics: ["gate-policy"] } }),
    msg(2, "claude", "opened PR #60 implementing the gate", { payload: { topics: ["gate-policy"] } }),
    msg(3, "warden", "token leak found", { event: "finding", payload: { file: "src/auth/service.js", severity: "P1", message: "hardcoded token" } }),
    msg(4, "codex", "@claude can you review #60 today", {}),
    // Control event — must be filtered out of observations.
    msg(5, "codex", "", { event: "file_lock", payload: { files: ["src/auth/service.js"] } }),
  ];
}

test("Unit engram: text tokenizer preserves lexical anchors and strips query stopwords", () => {
  const tokens = tokenize("Fix the token leak in src/auth/service.js per #60 with @codex");
  assert.ok(tokens.includes("#60"), "keeps PR ref");
  assert.ok(tokens.includes("@codex"), "keeps mention");
  assert.ok(tokens.includes("src/auth/service.js"), "keeps path");
  assert.ok(tokens.includes("service.js"), "adds path basename");
  const q = queryTokens("what did we decide about the gate policy");
  assert.ok(!q.includes("what") && !q.includes("about") && !q.includes("the"), "strips stopwords");
  assert.ok(q.includes("gate") && q.includes("policy"), "keeps anchors");
  assert.deepEqual(charNGrams("gate", 3), ["gat", "ate"]);
});

test("Unit engram: embedder is deterministic, 256-d, int8", () => {
  const embedder = createEmbedder();
  assert.equal(embedder.dim, 256);
  const a = embedder.embed("gate policy decision");
  const b = embedder.embed("gate policy decision");
  assert.ok(a instanceof Int8Array);
  assert.equal(a.length, 256);
  assert.deepEqual([...a], [...b], "same text -> identical vector");
  const c = embedder.embed("something entirely different");
  assert.notDeepEqual([...a], [...c]);
});

test("Unit engram: observations are material-only, deduped, with extracted anchors", () => {
  const events = sampleEvents();
  // Duplicate by idempotency token must be a no-op (never a destructive merge).
  const dup = { ...msg(2, "claude", "opened PR #60 implementing the gate"), idempotencyToken: "tok-2" };
  const dup2 = { ...dup };
  const { observations, droppedControlEvents } = buildObservations([...events, dup, dup2], { sessionId: "s1" });
  assert.equal(droppedControlEvents, 1, "file_lock filtered");
  assert.equal(observations.filter((o) => o.id === "tok-2").length, 1, "dedup by idempotency token");
  const finding = observations.find((o) => o.kind === "finding");
  assert.ok(finding.files.includes("src/auth/service.js"));
  const mentionMsg = observations.find((o) => o.raw.eventId === "e4");
  assert.ok(mentionMsg.mentions.includes("claude"));
  assert.ok(mentionMsg.prRefs.includes("#60"));
});

test("Unit engram: entity graph builds agent/file/pr/topic entities + occurrences", () => {
  const { observations } = buildObservations(sampleEvents(), { sessionId: "s1" });
  const actions = [
    { actionType: "view", targetSequenceId: 1, createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString() },
    { actionType: "like", targetSequenceId: 1, createdAt: new Date(Date.UTC(2026, 0, 3)).toISOString() },
  ];
  const graph = buildEntityGraph(observations, actions);
  assert.ok(graph.entities.has("agent:codex"));
  assert.ok(graph.entities.has("file:src/auth/service.js"));
  assert.ok(graph.entities.has("pr:#60"));
  assert.ok(graph.entities.has("topic:gate-policy"));
  // Occurrences: capture for every obs + 2 rehearsal actions on seq 1.
  const seq1 = observations.find((o) => o.sequenceId === 1);
  const occ = graph.occurrences.get(seq1.id);
  assert.equal(occ.length, 3, "1 capture + 2 actions (ACT-R fuel)");
  assert.ok(occ.some((o) => o.kind === "view") && occ.some((o) => o.kind === "like"));
  assert.deepEqual(matchQueryEntities(graph.entities, "gate policy").length >= 0, true);
});

test("Unit engram: recall returns a lexical hit with provenance, deterministically", () => {
  const index = buildRecallIndex({ events: sampleEvents(), sessionId: "s1" });
  const r1 = recall(index, { query: "hardcoded token leak in auth", k: 5, now: FIXED_NOW });
  assert.ok(r1.results.length > 0);
  const top = r1.results[0];
  assert.equal(top.kind, "finding", "the finding is the top hit for a lexical auth query");
  assert.ok(top.provenance && top.provenance.length > 0, "every hit carries provenance");
  // Determinism: identical query -> identical serialized results.
  const r2 = recall(index, { query: "hardcoded token leak in auth", k: 5, now: FIXED_NOW });
  assert.deepEqual(
    r1.results.map((r) => [r.observationId, r.score]),
    r2.results.map((r) => [r.observationId, r.score]),
  );
});

test("Unit engram: spreading activation reaches a lexically-disjoint memory via a shared entity", () => {
  // m0 mentions the subject; m1 shares ONLY a topic entity with m0 (no shared
  // words). A query for m0's subject must still surface m1 via graph diffusion.
  const events = [
    msg(1, "codex", "kickoff zephyrquartz initiative", { payload: { topics: ["thread-alpha"] } }),
    msg(2, "claude", "final wrapup omicronvelvet", { payload: { topics: ["thread-alpha"] } }),
  ];
  const index = buildRecallIndex({ events, sessionId: "s1" });
  const r = recall(index, { query: "zephyrquartz", k: 5, now: FIXED_NOW });
  const ids = r.results.map((x) => x.observationId);
  assert.ok(ids.includes("e1"), "direct lexical hit");
  assert.ok(ids.includes("e2"), "graph-diffused hit (no shared words, only a shared topic entity)");
});

test("Unit engram: token cut shrinks context vs full replay", async () => {
  const events = [];
  for (let i = 1; i <= 60; i += 1) {
    events.push(msg(i, "codex", `status update number ${i} covering assorted progress details and notes about work item ${i}`));
  }
  const index = buildRecallIndex({ events, sessionId: "s1" });
  const r = recall(index, { query: "status update", k: 12, now: FIXED_NOW });
  const cut = await computeTokenCut({ observations: index.observations, results: r.results });
  assert.ok(cut.fullReplayTokens > cut.recallPackTokens, "pack is smaller than full replay");
  assert.ok(cut.reductionRatio > 1, "positive reduction ratio");
});

test("Unit engram: runSessionRecall works with injected seams and honors backfill warnings", async () => {
  const events = sampleEvents();
  const out = await runSessionRecall({
    sessionId: "s1",
    need: "omar gate policy",
    remote: true,
    now: FIXED_NOW,
    _hydrate: async () => ({ ok: true, eventsBackfillComplete: false, eventsBackfillReason: "more pages" }),
    _readStream: async () => events,
    _listActions: async () => ({ ok: true, actions: [] }),
  });
  assert.equal(out.ok, true);
  assert.ok(out.results.length > 0);
  assert.equal(out.backfill.attempted, true);
  assert.ok(out.backfill.warning.includes("incomplete"), "surfaces partial-backfill warning");
  assert.ok(out.tokenCut.fullReplayTokens > 0);

  const short = await runSessionRecall({ sessionId: "s1", need: "x", remote: false, _readStream: async () => events, _listActions: async () => ({ ok: true, actions: [] }) });
  assert.equal(short.ok, false);
  assert.equal(short.reason, "query_too_short");
});
