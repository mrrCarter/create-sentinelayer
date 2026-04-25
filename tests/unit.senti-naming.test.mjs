// Unit tests for Senti's auto-naming + anonymous-detection helpers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  assignFriendlyName,
  buildSentiWelcome,
  isAnonymousAgent,
} from "../src/session/senti-naming.js";

test("isAnonymousAgent: empty + cli-user + agent- prefix all flag", () => {
  assert.equal(isAnonymousAgent({ agentId: "", model: "claude" }), true);
  assert.equal(isAnonymousAgent({ agentId: "cli-user" }), true);
  assert.equal(isAnonymousAgent({ agentId: "agent-abcd" }), true);
  assert.equal(isAnonymousAgent({ agentId: "guest-1" }), true);
});

test("isAnonymousAgent: unknown / cli model alone flags", () => {
  assert.equal(isAnonymousAgent({ agentId: "claude-1", model: "unknown" }), true);
  assert.equal(isAnonymousAgent({ agentId: "claude-1", model: "" }), true);
  assert.equal(isAnonymousAgent({ agentId: "claude-1", model: "cli" }), true);
});

test("isAnonymousAgent: real id + real model is identified", () => {
  assert.equal(
    isAnonymousAgent({ agentId: "claude-1", model: "claude-opus-4-7" }),
    false,
  );
  assert.equal(
    isAnonymousAgent({ agentId: "human-mrrcarter", model: "human" }),
    false,
  );
});

test("assignFriendlyName: claude family ordinal advances", () => {
  const existing = [
    { agentId: "claude-1" },
    { agentId: "claude-2" },
  ];
  assert.equal(
    assignFriendlyName({ model: "claude-opus-4-7", existingAgents: existing }),
    "claude-3",
  );
});

test("assignFriendlyName: maps codex / gpt to codex family", () => {
  assert.equal(
    assignFriendlyName({ model: "gpt-5.3-codex", existingAgents: [] }),
    "codex-1",
  );
});

test("assignFriendlyName: unknown model falls back to guest", () => {
  assert.equal(
    assignFriendlyName({ model: "", existingAgents: [{ agentId: "guest-1" }] }),
    "guest-2",
  );
  assert.equal(
    assignFriendlyName({ model: "unknown", existingAgents: [] }),
    "guest-1",
  );
});

test("assignFriendlyName: novel model still gets sanitized prefix", () => {
  assert.equal(
    assignFriendlyName({ model: "qwen-2.5-72b", existingAgents: [] }),
    "qwen-1",
  );
});

test("buildSentiWelcome: anonymous welcome carries auto-named flag", () => {
  const payload = buildSentiWelcome({
    agentId: "claude-3",
    model: "claude-opus-4-7",
    role: "reviewer",
    wasAnonymous: true,
    originalAgentId: "agent-1234",
  });
  assert.equal(payload.alert, "agent_identified");
  assert.equal(payload.agentId, "claude-3");
  assert.equal(payload.wasAnonymous, true);
  assert.equal(payload.originalAgentId, "agent-1234");
  assert.match(payload.message, /auto-named/);
  assert.match(payload.instructions, /sl session rename/);
});

test("buildSentiWelcome: identified welcome is shorter", () => {
  const payload = buildSentiWelcome({
    agentId: "human-mrrcarter",
    model: "human",
    role: "owner",
    wasAnonymous: false,
  });
  assert.equal(payload.wasAnonymous, false);
  assert.match(payload.message, /You're in as owner/);
});
