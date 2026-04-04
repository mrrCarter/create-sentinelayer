import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CODING_AGENT_ID,
  detectCodingAgentFromEnv,
  detectIdeFromEnv,
  listSupportedCodingAgents,
  resolveCodingAgent,
} from "../src/config/agent-dictionary.js";

test("Unit agent dictionary: exposes deterministic coding-agent catalog", () => {
  const agents = listSupportedCodingAgents();
  assert.equal(Array.isArray(agents), true);
  assert.equal(agents.length >= 10, true);
  assert.equal(agents.some((agent) => agent.id === "claude-code"), true);
  assert.equal(agents.some((agent) => agent.id === "cursor"), true);
  assert.equal(agents.some((agent) => agent.id === "codex"), true);

  const cursor = resolveCodingAgent("cursor");
  assert.equal(cursor.name, "Cursor");
  assert.equal(cursor.promptTarget, "cursor");
  assert.equal(cursor.configFile, ".cursorrules");

  const fallback = resolveCodingAgent(DEFAULT_CODING_AGENT_ID);
  assert.equal(fallback.id, "generic");

  assert.throws(() => resolveCodingAgent("unknown-agent"), /Unsupported coding agent/);
});

test("Unit agent dictionary: coding-agent detection honors explicit override then cursor signal", () => {
  const explicit = detectCodingAgentFromEnv({
    SENTINELAYER_CODING_AGENT: "codex",
  });
  assert.equal(explicit.id, "codex");

  const cursorDetected = detectCodingAgentFromEnv({
    CURSOR_TRACE_ID: "trace_123",
  });
  assert.equal(cursorDetected.id, "cursor");

  const defaultDetected = detectCodingAgentFromEnv({});
  assert.equal(defaultDetected.id, "generic");
});

test("Unit agent dictionary: IDE detection distinguishes cursor from vscode", () => {
  const cursor = detectIdeFromEnv({
    TERM_PROGRAM: "vscode",
    CURSOR_TRACE_ID: "cursor_abc",
  });
  assert.equal(cursor.id, "cursor");

  const vscode = detectIdeFromEnv({
    TERM_PROGRAM: "vscode",
  });
  assert.equal(vscode.id, "vscode");

  const jetbrains = detectIdeFromEnv({
    JETBRAINS_IDE: "WebStorm",
  });
  assert.equal(jetbrains.id, "jetbrains");

  const terminal = detectIdeFromEnv({});
  assert.equal(terminal.id, "terminal");
});
