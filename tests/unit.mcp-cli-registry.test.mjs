import test from "node:test";
import assert from "node:assert/strict";

import { buildCliProgram } from "../src/cli.js";
import { buildSentinelayerCliRegistryTemplate } from "../src/mcp/cli-registry.js";
import { validateMcpToolRegistry } from "../src/mcp/registry.js";

async function buildRegistry() {
  const program = await buildCliProgram({
    invokeLegacy: async () => {},
  });
  return buildSentinelayerCliRegistryTemplate({
    generatedAt: "2026-06-29T00:00:00.000Z",
    program,
  });
}

function getTool(registry, name) {
  const tool = registry.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected generated tool ${name}`);
  return tool;
}

test("Unit MCP CLI registry: generated registry validates and exposes known CLI leaves", async () => {
  const registry = await buildRegistry();
  const parsed = validateMcpToolRegistry(registry);
  const names = new Set(parsed.tools.map((tool) => tool.name));

  assert.equal(parsed.version, "1.0.0");
  assert.ok(parsed.tools.length > 40);
  assert.equal(names.has("sl.session.say"), true);
  assert.equal(names.has("sl.mcp.registry.init-session"), true);
  assert.equal(names.has("sl.audit.local"), true);
});

test("Unit MCP CLI registry: session say schema preserves args and options", async () => {
  const registry = await buildRegistry();
  const tool = getTool(registry, "sl.session.say");

  assert.equal(tool.transport.type, "bridge");
  assert.equal(tool.transport.url, "sentinelayer://cli/session.say");
  assert.deepEqual(tool.security.scopes, ["cli:execute"]);
  assert.equal(tool.security.requires_human_approval, true);
  assert.deepEqual(tool.metadata.argv, ["session", "say"]);
  assert.equal(tool.input_schema.required.includes("sessionId"), true);
  assert.equal(tool.input_schema.properties.sessionId.type, "string");
  assert.equal(tool.input_schema.properties.message.type, "array");
  assert.equal(tool.input_schema.properties.message.items.type, "string");
  assert.equal(tool.input_schema.properties.to.type, "string");
  assert.equal(tool.input_schema.properties.stdin.type, "boolean");
  assert.equal(tool.input_schema.properties.localOnly.type, "boolean");
});

test("Unit MCP CLI registry: init-session schema records bridge command metadata", async () => {
  const registry = await buildRegistry();
  const tool = getTool(registry, "sl.mcp.registry.init-session");

  assert.equal(tool.description, "Write the built-in SentinelLayer session MCP tool registry");
  assert.deepEqual(tool.metadata.argv, ["mcp", "registry", "init-session"]);
  assert.equal(tool.metadata.command, "mcp registry init-session");
  assert.equal(tool.metadata.generated_from, "commander");
  assert.equal(tool.input_schema.properties.path.type, "string");
  assert.equal(tool.input_schema.properties.force.type, "boolean");
  assert.equal(tool.input_schema.properties.json.type, "boolean");
});
