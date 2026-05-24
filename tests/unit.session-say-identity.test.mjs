import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  resolveSessionSayIdentity,
  sessionSayRegistryRole,
  shouldBlockImplicitCliUserSessionSay,
} from "../src/commands/session.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { createSession } from "../src/session/store.js";

async function makeWorkspace(prefix = "session-say-identity-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(root, "package.json"), '{"name":"identity-fixture","version":"1.0.0"}\n', "utf-8");
  return root;
}

test("Unit session say identity: explicit --agent wins without warning", async () => {
  const identity = await resolveSessionSayIdentity({
    sessionId: "sess-explicit",
    agentId: "Codex Agent",
    targetPath: process.cwd(),
    env: {},
  });

  assert.equal(identity.agentId, "codex-agent");
  assert.equal(identity.source, "option");
  assert.equal(identity.identityWarning, "");
});

test("Unit session say identity: SENTINELAYER_AGENT_ID is the default agent envelope", async () => {
  const identity = await resolveSessionSayIdentity({
    sessionId: "sess-env",
    targetPath: process.cwd(),
    env: { SENTINELAYER_AGENT_ID: "codex", SENTINELAYER_AGENT_MODEL: "gpt-5.3-codex" },
  });

  assert.equal(identity.agentId, "codex");
  assert.equal(identity.source, "env");
  assert.equal(identity.identityWarning, "");
});

test("Unit session say identity: sole local joined agent is used when no env or option exists", async () => {
  const root = await makeWorkspace();
  try {
    const session = await createSession({ targetPath: root, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "codex",
      model: "gpt-5.3-codex",
      role: "coder",
      targetPath: root,
      trackProcessExit: false,
    });

    const identity = await resolveSessionSayIdentity({
      sessionId: session.sessionId,
      targetPath: root,
      env: {},
    });

    assert.equal(identity.agentId, "codex");
    assert.equal(identity.source, "local-agent");
    assert.deepEqual(identity.candidateAgentIds, ["codex"]);
    assert.equal(identity.identityWarning, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unit session say identity: ambiguous local agents fall back to cli-user with warning", async () => {
  const root = await makeWorkspace();
  try {
    const session = await createSession({ targetPath: root, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "codex",
      model: "gpt-5.3-codex",
      role: "coder",
      targetPath: root,
      trackProcessExit: false,
    });
    await registerAgent(session.sessionId, {
      agentId: "claude-verifier",
      model: "claude-opus-4-7",
      role: "reviewer",
      targetPath: root,
      trackProcessExit: false,
    });

    const identity = await resolveSessionSayIdentity({
      sessionId: session.sessionId,
      targetPath: root,
      env: {},
    });

    assert.equal(identity.agentId, "cli-user");
    assert.equal(identity.source, "fallback");
    assert.match(identity.identityWarning, /multiple local joined agents are active/);
    assert.deepEqual(new Set(identity.candidateAgentIds), new Set(["codex", "claude-verifier"]));
    assert.equal(shouldBlockImplicitCliUserSessionSay(identity), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unit session say identity: no usable identity falls back loudly", async () => {
  const identity = await resolveSessionSayIdentity({
    sessionId: "sess-none",
    targetPath: process.cwd(),
    env: { SENTINELAYER_AGENT_ID: "cli-user" },
  });

  assert.equal(identity.agentId, "cli-user");
  assert.equal(identity.source, "fallback");
  assert.match(identity.identityWarning, /reserved or human-scoped/);
  assert.equal(shouldBlockImplicitCliUserSessionSay(identity), true);
});

test("Unit session say identity: concrete agent identities do not require cli-user force", async () => {
  const identity = await resolveSessionSayIdentity({
    sessionId: "sess-force",
    agentId: "codex",
    targetPath: process.cwd(),
    env: {},
  });

  assert.equal(identity.agentId, "codex");
  assert.equal(shouldBlockImplicitCliUserSessionSay(identity), false);
});

test("Unit session say identity: registry persistence tolerates participant metadata roles", () => {
  assert.equal(sessionSayRegistryRole("participant"), "coder");
  assert.equal(sessionSayRegistryRole("reviewer"), "reviewer");
});
