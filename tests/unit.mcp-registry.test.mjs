import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAidenIdProvisioningAdapterTemplate,
  buildAidenIdRegistryTemplate,
  validateAidenIdAdapterContract,
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
