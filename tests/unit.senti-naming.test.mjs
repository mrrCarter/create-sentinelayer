// Unit tests for Senti's auto-naming + anonymous-detection helpers.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assignFriendlyName,
  buildSentiWelcome,
  isAnonymousAgent,
  shouldAutoRenameInRegistry,
} from "../src/session/senti-naming.js";
import { listAgents, registerAgent } from "../src/session/agent-registry.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function makeRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-name-"));
}

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

// shouldAutoRenameInRegistry guards the registry hook from clobbering
// caller-supplied real ids. The original registry hook in PR 418 had to
// be reverted because it used isAnonymousAgent (model-aware), which
// renamed legitimate ids like `codex-task-holder-1` whenever model="".
test("shouldAutoRenameInRegistry: empty caller id => rename", () => {
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "" }), true);
});

test("shouldAutoRenameInRegistry: literal cli-user placeholder => rename", () => {
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "cli-user" }), true);
});

test("shouldAutoRenameInRegistry: caller-supplied real id => preserve (kill-test + e2e guard)", () => {
  // PR 348/351 kill tests register `codex-task-holder-1` with model=""
  // and expect verbatim round-trip. e2e test #91 does
  // `session join --name agent-alpha` and asserts agent-alpha round-trips.
  // Anything but empty or literal `cli-user` is caller-authoritative.
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "codex-task-holder-1" }), false);
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "agent-alpha" }), false);
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "agent-abcd" }), false);
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "guest-1" }), false);
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "claude-1" }), false);
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "human-mrrcarter" }), false);
  assert.equal(shouldAutoRenameInRegistry({ originalCallerAgentId: "senti" }), false);
});

test("registerAgent: agent-alpha round-trips verbatim (e2e #91 regression)", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    const result = await registerAgent(created.sessionId, {
      agentId: "agent-alpha",
      model: "",
      role: "coder",
      targetPath: root,
    });
    assert.equal(result.agentId, "agent-alpha");
    const list = await listAgents(created.sessionId, { targetPath: root });
    assert.deepEqual(list.map((a) => a.agentId), ["agent-alpha"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("registerAgent: caller-supplied real id round-trips verbatim (codex-task-holder regression)", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    const result = await registerAgent(created.sessionId, {
      agentId: "codex-task-holder-1",
      model: "",
      role: "coder",
      targetPath: root,
    });
    assert.equal(result.agentId, "codex-task-holder-1");
    const list = await listAgents(created.sessionId, { targetPath: root });
    assert.deepEqual(list.map((a) => a.agentId), ["codex-task-holder-1"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("registerAgent: empty agentId + claude model => Senti renames to claude-1", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    const result = await registerAgent(created.sessionId, {
      agentId: "",
      model: "claude-opus-4-7",
      role: "coder",
      targetPath: root,
    });
    assert.equal(result.agentId, "claude-1");
    const events = await readStream(created.sessionId, { targetPath: root, tail: 0 });
    const identified = events.filter((e) => e.event === "agent_identified");
    assert.equal(identified.length, 1, "Senti must emit one welcome event");
    assert.equal(identified[0].payload.wasAnonymous, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("registerAgent: cli-user placeholder => Senti renames to friendly id", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    const result = await registerAgent(created.sessionId, {
      agentId: "cli-user",
      model: "claude-opus-4-7",
      role: "coder",
      targetPath: root,
    });
    assert.notEqual(result.agentId, "cli-user");
    assert.equal(result.agentId, "claude-1");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("registerAgent: ordinals advance across multiple anonymous joins", async () => {
  const root = await makeRoot();
  try {
    const created = await createSession({ targetPath: root });
    const a = await registerAgent(created.sessionId, { agentId: "", model: "claude-opus-4-7", targetPath: root });
    const b = await registerAgent(created.sessionId, { agentId: "", model: "claude-sonnet-4-6", targetPath: root });
    const c = await registerAgent(created.sessionId, { agentId: "", model: "gpt-5.3-codex", targetPath: root });
    assert.equal(a.agentId, "claude-1");
    assert.equal(b.agentId, "claude-2");
    assert.equal(c.agentId, "codex-1");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
