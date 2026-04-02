import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAidenIdProvisioningAdapterTemplate,
  buildAidenIdRegistryTemplate,
  buildMcpServerConfigTemplate,
  validateAidenIdAdapterContract,
  validateMcpServerConfig,
} from "../src/mcp/registry.js";

test("Unit MCP registry: AIdenID adapter template validates and exposes provision-email binding", () => {
  const registry = buildAidenIdRegistryTemplate();
  const adapter = buildAidenIdProvisioningAdapterTemplate();
  const parsed = validateAidenIdAdapterContract(adapter, {
    registryPayload: registry,
  });

  assert.equal(parsed.provider, "aidenid");
  assert.equal(parsed.tool_bindings.length, 1);
  assert.equal(parsed.tool_bindings[0].tool_name, "aidenid.provision_email");
  assert.equal(parsed.tool_bindings[0].operation, "provision_email");
});

test("Unit MCP registry: adapter validation fails when tool binding is missing from registry", () => {
  const registry = buildAidenIdRegistryTemplate();
  registry.tools = [
    {
      ...registry.tools[0],
      name: "aidenid.other_operation",
    },
  ];

  const adapter = buildAidenIdProvisioningAdapterTemplate();

  assert.throws(
    () =>
      validateAidenIdAdapterContract(adapter, {
        registryPayload: registry,
      }),
    /tools not present in registry/i
  );
});

test("Unit MCP registry: AIdenID templates require human approval by default", () => {
  const registry = buildAidenIdRegistryTemplate();
  const adapter = buildAidenIdProvisioningAdapterTemplate();

  assert.equal(registry.tools[0].security.requires_human_approval, true);
  assert.equal(adapter.tool_bindings[0].security.requires_human_approval, true);
});

test("Unit MCP registry: MCP server config rejects bearer auth without audience", () => {
  const config = buildMcpServerConfigTemplate({
    serverId: "mcp-aidenid",
    registryFile: ".sentinelayer/mcp/tool-registry.aidenid-template.json",
  });
  config.transport = {
    mode: "http",
    url: "https://mcp.sentinelayer.dev/endpoint",
    auth: {
      mode: "bearer",
      secret_ref: "SENTINELAYER_TOKEN",
    },
  };

  assert.throws(
    () => validateMcpServerConfig(config),
    /audience is required when auth\.mode is bearer or oauth2/i
  );
});

test("Unit MCP registry: MCP server config accepts bearer auth with audience", () => {
  const config = buildMcpServerConfigTemplate({
    serverId: "mcp-aidenid",
    registryFile: ".sentinelayer/mcp/tool-registry.aidenid-template.json",
  });
  config.transport = {
    mode: "http",
    url: "https://mcp.sentinelayer.dev/endpoint",
    auth: {
      mode: "bearer",
      secret_ref: "SENTINELAYER_TOKEN",
      audience: "sentinelayer-mcp",
    },
  };

  const parsed = validateMcpServerConfig(config);
  assert.equal(parsed.transport.mode, "http");
  assert.equal(parsed.transport.auth.mode, "bearer");
  assert.equal(parsed.transport.auth.audience, "sentinelayer-mcp");
});
