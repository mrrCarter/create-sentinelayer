import test from "node:test";
import assert from "node:assert/strict";

import { inferSessionAgentIdentity } from "../src/session/agent-identity.js";

test("Unit session agent identity: infers Codex metadata from a weak CLI model", () => {
  assert.deepEqual(
    inferSessionAgentIdentity({
      agentId: "codex",
      model: "cli",
      clientKind: "cli",
    }),
    {
      agentId: "codex",
      model: "gpt-5-codex",
      displayName: "Codex",
      provider: "openai",
      clientKind: "cli",
    },
  );
});

test("Unit session agent identity: infers Claude verifier display/provider", () => {
  const identity = inferSessionAgentIdentity({
    agentId: "claude-verifier",
    model: "",
    clientKind: "cli",
  });

  assert.equal(identity.model, "claude");
  assert.equal(identity.displayName, "Claude Verifier");
  assert.equal(identity.provider, "anthropic");
  assert.equal(identity.clientKind, "cli");
});

test("Unit session agent identity: preserves explicit non-weak metadata", () => {
  assert.deepEqual(
    inferSessionAgentIdentity({
      agentId: "custom-bot",
      model: "custom-model-v1",
      displayName: "Custom Bot",
      provider: "internal",
      clientKind: "daemon",
    }),
    {
      agentId: "custom-bot",
      model: "custom-model-v1",
      displayName: "Custom Bot",
      provider: "internal",
      clientKind: "daemon",
    },
  );
});

test("Unit session agent identity: malformed inputs normalize without throwing", () => {
  assert.deepEqual(inferSessionAgentIdentity(null), {
    model: "unknown",
    clientKind: "cli",
  });
  assert.deepEqual(inferSessionAgentIdentity("codex"), {
    model: "unknown",
    clientKind: "cli",
  });
  assert.deepEqual(
    inferSessionAgentIdentity({
      agentId: "  ",
      model: "  ",
      displayName: null,
      provider: undefined,
      clientKind: "",
    }),
    {
      model: "unknown",
      clientKind: "cli",
    },
  );
});
