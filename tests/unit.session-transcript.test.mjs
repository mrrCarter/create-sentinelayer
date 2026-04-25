// Unit tests for the iMessage-style session transcript renderer.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_FAMILY_AVATARS,
  buildTranscriptMarkdown,
  computeTranscriptStats,
  resolveSpeakerIdentity,
} from "../src/session/transcript.js";

function ev({ event, agentId, model, ts, payload = {} }) {
  return {
    event,
    agent: { id: agentId, model: model || "" },
    ts,
    payload,
  };
}

test("resolveSpeakerIdentity routes Senti orchestrator to gold shield", () => {
  const senti = resolveSpeakerIdentity({ agentId: "senti", agentModel: "kai-chen" });
  assert.equal(senti.family, "senti");
  assert.match(senti.displayName, /Senti|Kai/);
  assert.ok(senti.avatar, "senti must have an avatar");
});

test("resolveSpeakerIdentity uses persona visuals for Nina/Maya/Jules", () => {
  const nina = resolveSpeakerIdentity({ agentId: "nina" });
  assert.equal(nina.family, "nina");
  assert.ok(nina.displayName, "persona must have a displayName");
});

test("resolveSpeakerIdentity falls back to client-family avatar for claude/codex/gemini/grok", () => {
  for (const family of ["claude", "codex", "gemini", "grok"]) {
    const ident = resolveSpeakerIdentity({ agentId: `${family}-1`, agentModel: family });
    assert.equal(ident.family, family);
    assert.equal(ident.avatar, CLIENT_FAMILY_AVATARS[family].avatar);
  }
});

test("resolveSpeakerIdentity prefers caller-supplied profile (gh/google avatar) for humans", () => {
  const ident = resolveSpeakerIdentity({
    agentId: "carter",
    agentModel: "human",
    profile: {
      displayName: "Carter Smith",
      avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
    },
  });
  assert.equal(ident.displayName, "Carter Smith");
  assert.equal(ident.avatarUrl, "https://avatars.githubusercontent.com/u/123?v=4");
});

test("computeTranscriptStats returns zeros for empty events", () => {
  const stats = computeTranscriptStats({ sessionMeta: {}, events: [] });
  assert.equal(stats.sessionLiveSeconds, 0);
  assert.equal(stats.agents.length, 0);
  assert.equal(stats.totals.tokenTotal, 0);
  assert.equal(stats.totals.costTotalUsd, 0);
  assert.equal(stats.sentiActions, 0);
});

test("computeTranscriptStats: sessionLiveSeconds spans createdAt → last event", () => {
  const createdAt = "2026-04-25T10:00:00.000Z";
  const events = [
    ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:30.000Z", payload: { message: "hi" } }),
    ev({ event: "agent_response", agentId: "claude-1", ts: "2026-04-25T10:02:00.000Z", payload: { response: "hello" } }),
  ];
  const stats = computeTranscriptStats({ sessionMeta: { createdAt }, events });
  assert.equal(stats.sessionLiveSeconds, 120);
  assert.equal(stats.startedAt, createdAt);
});

test("computeTranscriptStats: per-agent activeSeconds = first→last event with that id", () => {
  const events = [
    ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:00.000Z" }),
    ev({ event: "agent_response", agentId: "claude-1", ts: "2026-04-25T10:01:00.000Z" }),
    ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:05:00.000Z" }),
  ];
  const stats = computeTranscriptStats({ sessionMeta: {}, events });
  const carter = stats.agents.find((a) => a.agentId === "carter");
  assert.equal(carter.activeSeconds, 300, "carter active 5m between first and last event");
  assert.equal(carter.eventCount, 2);
});

test("computeTranscriptStats: rolls up tokens + cost from payload.usage", () => {
  const events = [
    ev({
      event: "agent_response",
      agentId: "claude-1",
      ts: "2026-04-25T10:00:00.000Z",
      payload: { response: "x", usage: { totalTokens: 1500, costUsd: 0.012 } },
    }),
    ev({
      event: "agent_response",
      agentId: "codex-2",
      ts: "2026-04-25T10:00:30.000Z",
      payload: { response: "y", usage: { total_tokens: 2500, cost_usd: 0.025 } },
    }),
  ];
  const stats = computeTranscriptStats({ sessionMeta: {}, events });
  assert.equal(stats.totals.tokenTotal, 4000);
  assert.equal(stats.totals.costTotalUsd.toFixed(4), "0.0370");
  const claude = stats.agents.find((a) => a.agentId === "claude-1");
  assert.equal(claude.tokens, 1500);
});

test("computeTranscriptStats: counts senti orchestrator actions", () => {
  const events = [
    ev({ event: "agent_join", agentId: "senti", ts: "2026-04-25T10:00:00.000Z" }),
    ev({ event: "agent_identified", agentId: "senti", ts: "2026-04-25T10:00:01.000Z" }),
    ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:02.000Z" }),
  ];
  const stats = computeTranscriptStats({ sessionMeta: {}, events });
  assert.equal(stats.sentiActions, 2);
});

test("buildTranscriptMarkdown: header includes Generated/Started/Live for/Senti actions", () => {
  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "abc123", createdAt: "2026-04-25T10:00:00.000Z" },
    events: [
      ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:30.000Z", payload: { message: "go" } }),
    ],
  });
  assert.match(markdown, /^# Session abc123/m);
  assert.match(markdown, /Generated:/);
  assert.match(markdown, /Started: 2026-04-25T10:00:00/);
  assert.match(markdown, /Live for:/);
  assert.match(markdown, /Senti actions: 0/);
});

test("buildTranscriptMarkdown: Participants table has one row per speaker", () => {
  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "s1", createdAt: "2026-04-25T10:00:00.000Z" },
    events: [
      ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:05.000Z", payload: { message: "hello" } }),
      ev({ event: "agent_response", agentId: "claude-1", ts: "2026-04-25T10:00:06.000Z", payload: { response: "hi" } }),
      ev({ event: "agent_response", agentId: "codex-2", ts: "2026-04-25T10:00:07.000Z", payload: { response: "yo" } }),
    ],
  });
  assert.match(markdown, /## Participants/);
  assert.match(markdown, /\| .* \| \*\*[^*]+\*\* `carter` \|/);
  assert.match(markdown, /\| .* \| \*\*[^*]+\*\* `claude-1` \|/);
  assert.match(markdown, /\| .* \| \*\*[^*]+\*\* `codex-2` \|/);
});

test("buildTranscriptMarkdown: conversation renders user message as ### heading + blockquote ts", () => {
  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "s1" },
    events: [
      ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:30.000Z", payload: { message: "ship it" } }),
    ],
  });
  assert.match(markdown, /### .* carter/);
  assert.match(markdown, /^> 2026-04-25 10:00:30 UTC/m);
  assert.match(markdown, /^ship it$/m);
});

test("buildTranscriptMarkdown: system events render as italic dash-bullets", () => {
  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "s1" },
    events: [
      ev({
        event: "agent_join",
        agentId: "claude-1",
        ts: "2026-04-25T10:00:01.000Z",
        payload: { reason: "joined session" },
      }),
    ],
  });
  // Italic line that signs the avatar + name + ts. The line starts with "- _"
  assert.match(markdown, /- _2026-04-25 10:00:01.*claude-1.*joined session_/);
});

test("buildTranscriptMarkdown: includeSystemEvents:false suppresses join/leave/alerts", () => {
  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "s1" },
    events: [
      ev({ event: "agent_join", agentId: "claude-1", ts: "2026-04-25T10:00:01.000Z", payload: {} }),
      ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:02.000Z", payload: { message: "go" } }),
    ],
    options: { includeSystemEvents: false },
  });
  assert.ok(!/agent_join/.test(markdown), "join event must not appear in markdown");
  assert.match(markdown, /^go$/m);
});

test("buildTranscriptMarkdown: scales to 20 distinct speakers without dropping rows", () => {
  const events = [];
  for (let i = 0; i < 20; i += 1) {
    events.push(
      ev({
        event: "agent_response",
        agentId: `agent-${i}`,
        model: i % 2 === 0 ? "claude" : "codex",
        ts: `2026-04-25T10:${String(i).padStart(2, "0")}:00.000Z`,
        payload: { response: `msg ${i}`, usage: { totalTokens: 100, costUsd: 0.001 } },
      }),
    );
  }
  const { markdown, stats } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "scale", createdAt: "2026-04-25T10:00:00.000Z" },
    events,
  });
  assert.equal(stats.agents.length, 20);
  assert.equal(stats.totals.tokenTotal, 2000);
  // Spot-check that each agent id appears in the participants table.
  for (let i = 0; i < 20; i += 1) {
    assert.ok(
      markdown.includes(`\`agent-${i}\``),
      `agent-${i} must appear in participants table`,
    );
  }
});

test("buildTranscriptMarkdown: registered-but-silent agents still appear in participants", () => {
  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "s1" },
    events: [],
    agents: [{ agentId: "claude-3", model: "claude-opus-4-7", role: "coder" }],
  });
  assert.match(markdown, /\| .* \| \*\*[^*]+\*\* `claude-3` \|.*idle/);
});

test("buildTranscriptMarkdown: humans get profile avatar URL embedded as image markdown", () => {
  const profiles = new Map();
  profiles.set("carter", {
    displayName: "Carter",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  });
  const { markdown } = buildTranscriptMarkdown({
    sessionMeta: { sessionId: "s1" },
    events: [
      ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:30.000Z", payload: { message: "hi" } }),
    ],
    speakerProfiles: profiles,
  });
  assert.match(markdown, /!\[Carter\]\(https:\/\/avatars\.githubusercontent\.com\/u\/1\?v=4\)/);
});

test("buildTranscriptMarkdown: deterministic — same inputs → same body (modulo Generated line)", () => {
  const args = {
    sessionMeta: { sessionId: "det", createdAt: "2026-04-25T10:00:00.000Z" },
    events: [
      ev({ event: "session_message", agentId: "carter", ts: "2026-04-25T10:00:30.000Z", payload: { message: "hi" } }),
      ev({ event: "agent_response", agentId: "claude-1", ts: "2026-04-25T10:00:35.000Z", payload: { response: "yo" } }),
    ],
  };
  const a = buildTranscriptMarkdown(args).markdown.replace(/^Generated:.*$/m, "Generated: <ts>");
  const b = buildTranscriptMarkdown(args).markdown.replace(/^Generated:.*$/m, "Generated: <ts>");
  assert.equal(a, b);
});
