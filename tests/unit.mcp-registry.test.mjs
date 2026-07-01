import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAidenIdProvisioningAdapterTemplate,
  buildHostedSentiSessionConnectorContract,
  buildAidenIdRegistryTemplate,
  buildMcpServerConfigTemplate,
  buildSentinelayerSessionRegistryTemplate,
  validateAidenIdAdapterContract,
  validateHostedSentiSessionConnectorContract,
  validateMcpToolRegistry,
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

test("Unit MCP registry: SentinelLayer session registry exposes inbox and write tools", () => {
  const registry = buildSentinelayerSessionRegistryTemplate({
    generatedAt: "2026-05-25T00:00:00.000Z",
  });
  const parsed = validateMcpToolRegistry(registry);
  const tools = new Set(parsed.tools.map((tool) => tool.name));

  assert.equal(tools.has("poll_inbox"), true);
  assert.equal(tools.has("read_history"), true);
  assert.equal(tools.has("send_message"), true);
  assert.equal(tools.has("session_action"), true);
  assert.equal(tools.has("session_react"), true);
  assert.equal(tools.has("session_reply"), true);
  assert.equal(tools.has("session_lock"), true);
  assert.equal(tools.has("session_unlock"), true);
  assert.equal(tools.has("session_locks"), true);
  assert.equal(tools.has("attention_request"), true);
  const pollInbox = parsed.tools.find((tool) => tool.name === "poll_inbox");
  const readHistory = parsed.tools.find((tool) => tool.name === "read_history");
  assert.equal(pollInbox.transport.type, "internal");
  assert.equal(pollInbox.input_schema.properties.includeActions.type, "boolean");
  assert.equal(pollInbox.input_schema.properties.actionLimit.maximum, 200);
  assert.equal(readHistory.transport.url, "sentinelayer://session/read_history");
  assert.equal(readHistory.input_schema.required.includes("agentId"), false);
  assert.equal(readHistory.input_schema.properties.beforeSequence.minimum, 1);
  assert.deepEqual(parsed.tools.find((tool) => tool.name === "send_message").security.scopes, ["session:write"]);
  assert.deepEqual(parsed.tools.find((tool) => tool.name === "session_react").security.scopes, ["session:write", "session:action"]);
  assert.deepEqual(parsed.tools.find((tool) => tool.name === "session_lock").security.scopes, ["session:lock"]);
});

test("Unit MCP registry: hosted Senti connector contract rejects identity from tool args", () => {
  const registry = buildSentinelayerSessionRegistryTemplate({
    generatedAt: "2026-06-29T00:00:00.000Z",
  });
  const contract = buildHostedSentiSessionConnectorContract({
    generatedAt: "2026-06-29T00:00:00.000Z",
  });
  const parsed = validateHostedSentiSessionConnectorContract(contract, {
    registryPayload: registry,
  });
  const joinAndHydrate = parsed.tools.find((tool) => tool.tool_name === "join_and_hydrate");
  const pollInbox = parsed.tools.find((tool) => tool.tool_name === "poll_inbox");
  const readHistory = parsed.tools.find((tool) => tool.tool_name === "read_history");
  const subscribeWake = parsed.tools.find((tool) => tool.tool_name === "subscribe_wake");

  assert.equal(parsed.runtime_status, "contract_only");
  assert.equal(parsed.boundary.identity_source, "validated_oauth_claims_and_server_session_seat");
  assert.equal(parsed.boundary.long_lived_cli_token_passthrough_allowed, false);
  assert.equal(joinAndHydrate.operation, "join_and_hydrate");
  assert.equal(joinAndHydrate.input_policy.allowed_user_args.includes("sessionId"), false);
  assert.equal(pollInbox.input_policy.identity_source, "server_session_seat");
  assert.equal(pollInbox.input_policy.rejects_identity_from_tool_args, true);
  assert.equal(pollInbox.input_policy.allowed_user_args.includes("sessionId"), false);
  assert.equal(pollInbox.input_policy.allowed_user_args.includes("agentId"), false);
  assert.equal(pollInbox.input_policy.forbidden_capability_args.includes("sessionId"), true);
  assert.equal(pollInbox.input_policy.forbidden_capability_args.includes("agentId"), true);
  assert.equal(readHistory.operation, "read_history");
  assert.equal(readHistory.input_policy.allowed_user_args.includes("beforeSequence"), true);
  assert.equal(readHistory.input_policy.allowed_user_args.includes("agentId"), false);
  assert.equal(subscribeWake.operation, "subscribe_wake");
  assert.equal(subscribeWake.wake_payload.may_include_message_content, false);
  assert.equal(subscribeWake.runner_lifecycle.revoke_token_on_idle_teardown, true);
});

test("Unit MCP registry: hosted connector validation fails if identity args are allowed", () => {
  const contract = buildHostedSentiSessionConnectorContract({
    generatedAt: "2026-06-29T00:00:00.000Z",
  });
  contract.tools[0].input_policy.allowed_user_args.push("agentId");

  assert.throws(
    () => validateHostedSentiSessionConnectorContract(contract),
    /allows forbidden capability argument agentId/i
  );
});

test("Unit MCP registry: hosted connector validation fails if wake revocation controls are missing", () => {
  const contract = buildHostedSentiSessionConnectorContract({
    generatedAt: "2026-06-29T00:00:00.000Z",
  });
  const subscribeWake = contract.tools.find((tool) => tool.tool_name === "subscribe_wake");
  delete subscribeWake.runner_lifecycle;

  assert.throws(
    () => validateHostedSentiSessionConnectorContract(contract),
    /must define scoped runner-token lifecycle controls/i
  );
});

test("Unit MCP registry: hosted connector validation fails if required release gates drift", () => {
  const contract = buildHostedSentiSessionConnectorContract({
    generatedAt: "2026-06-29T00:00:00.000Z",
  });
  contract.release_gates = contract.release_gates.filter((gate) => gate !== "wake_payload_minimization");

  assert.throws(
    () => validateHostedSentiSessionConnectorContract(contract),
    /missing required release gate wake_payload_minimization/i
  );
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
