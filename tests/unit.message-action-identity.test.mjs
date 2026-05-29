import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  resolveMessageActionIdentity,
  shouldBlockImplicitCliUserSessionSay,
} from "../src/commands/session.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { createSession } from "../src/session/store.js";

async function makeWorkspace(prefix = "message-action-identity-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(
    path.join(root, "package.json"),
    '{"name":"identity-fixture","version":"1.0.0"}\n',
    "utf-8",
  );
  return root;
}

test("Unit message-action identity: bare cli-user default resolves the sole joined agent", async () => {
  // Reproduces the api_422 bug: `sl session react ...` with no --agent passes
  // the literal "cli-user" default. It must resolve the joined agent instead.
  const root = await makeWorkspace();
  try {
    const session = await createSession({ targetPath: root, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "claude-mythos",
      model: "cli",
      role: "coder",
      targetPath: root,
      trackProcessExit: false,
    });

    const identity = await resolveMessageActionIdentity({
      sessionId: session.sessionId,
      optionAgent: "cli-user",
      targetPath: root,
      env: {},
    });

    assert.equal(identity.agentId, "claude-mythos");
    assert.equal(identity.source, "local-agent");
    assert.equal(shouldBlockImplicitCliUserSessionSay(identity), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unit message-action identity: explicit --agent wins over the cli-user default", async () => {
  const identity = await resolveMessageActionIdentity({
    sessionId: "sess-explicit",
    optionAgent: "Claude Mythos",
    targetPath: process.cwd(),
    env: {},
  });

  assert.equal(identity.agentId, "claude-mythos");
  assert.equal(identity.source, "option");
  assert.equal(shouldBlockImplicitCliUserSessionSay(identity), false);
});

test("Unit message-action identity: SENTINELAYER_AGENT_ID is used when only the cli-user default is present", async () => {
  const identity = await resolveMessageActionIdentity({
    sessionId: "sess-env",
    optionAgent: "cli-user",
    targetPath: process.cwd(),
    env: { SENTINELAYER_AGENT_ID: "codex" },
  });

  assert.equal(identity.agentId, "codex");
  assert.equal(identity.source, "env");
  assert.equal(shouldBlockImplicitCliUserSessionSay(identity), false);
});

test("Unit message-action identity: ambiguous joined agents are blocked with guidance instead of api_422", async () => {
  const root = await makeWorkspace();
  try {
    const session = await createSession({ targetPath: root, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "claude-mythos",
      model: "cli",
      role: "coder",
      targetPath: root,
      trackProcessExit: false,
    });
    await registerAgent(session.sessionId, {
      agentId: "codex",
      model: "gpt-5",
      role: "reviewer",
      targetPath: root,
      trackProcessExit: false,
    });

    const identity = await resolveMessageActionIdentity({
      sessionId: session.sessionId,
      optionAgent: "cli-user",
      targetPath: root,
      env: {},
    });

    assert.equal(identity.agentId, "cli-user");
    assert.equal(identity.source, "fallback");
    assert.match(identity.identityWarning, /multiple local joined agents are active/);
    // The caller must refuse this instead of POSTing cli-user (the api_422 path).
    assert.equal(shouldBlockImplicitCliUserSessionSay(identity), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
