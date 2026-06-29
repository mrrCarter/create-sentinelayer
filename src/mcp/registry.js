import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

import { resolveOutputRoot } from "../config/service.js";

/** MCP tool-registry schema version used by Sentinelayer CLI generated artifacts. */
export const MCP_TOOL_REGISTRY_SCHEMA_VERSION = "1.0.0";
/** MCP server-config schema version used by Sentinelayer CLI generated artifacts. */
export const MCP_SERVER_CONFIG_SCHEMA_VERSION = "1.0.0";
/** AIdenID adapter-contract schema version used by Sentinelayer CLI generated artifacts. */
export const AIDENID_ADAPTER_CONTRACT_SCHEMA_VERSION = "1.0.0";
/** Hosted Senti session connector-contract schema version. */
export const HOSTED_SENTI_SESSION_CONNECTOR_CONTRACT_SCHEMA_VERSION = "1.0.0";

const serverIdRegex = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const inputPlaceholderRegex = /^\{\{input\.[a-zA-Z0-9_.-]+\}\}$/;

const jsonSchemaObject = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.any()).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.union([z.boolean(), z.any()]).optional(),
});

const mcpToolSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_.:-]+$/, "tool name must contain only [a-zA-Z0-9_.:-]"),
    title: z.string().min(1).optional(),
    description: z.string().min(1),
    input_schema: jsonSchemaObject,
    transport: z.object({
      type: z.enum(["http", "internal", "bridge"]),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
      url: z.string().min(1),
      timeout_ms: z.number().int().positive().optional(),
      auth: z
        .object({
          mode: z.enum(["bearer", "api_key", "oauth2", "none"]).default("bearer"),
          secret_ref: z.string().min(1).optional(),
        })
        .optional(),
    }),
    budgets: z
      .object({
        max_calls_per_run: z.number().int().positive().default(5),
        max_runtime_ms: z.number().int().positive().default(15000),
      })
      .optional(),
    security: z
      .object({
        requires_human_approval: z.boolean().default(false),
        kill_switch: z.enum(["enabled", "disabled"]).default("enabled"),
        scopes: z.array(z.string().min(1)).default([]),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const mcpRegistrySchema = z
  .object({
    version: z.string().min(1),
    generated_at: z.string().optional(),
    tools: z.array(mcpToolSchema).min(1),
  })
  .strict();

const aidenIdProvisioningBindingSchema = z
  .object({
    tool_name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_.:-]+$/, "tool_name must contain only [a-zA-Z0-9_.:-]"),
    operation: z.literal("provision_email"),
    method: z.literal("POST"),
    path: z.literal("/v1/identities"),
    request_template: z
      .object({
        ttl_seconds: z.string().regex(inputPlaceholderRegex),
        tags: z.string().regex(inputPlaceholderRegex).optional(),
        policy: z.string().regex(inputPlaceholderRegex).optional(),
      })
      .strict(),
    response_contract: z
      .object({
        identity_id_path: z.string().min(1),
        email_path: z.string().min(1),
        expires_at_path: z.string().min(1),
      })
      .strict(),
    budgets: z
      .object({
        max_calls_per_run: z.number().int().positive().default(3),
        max_runtime_ms: z.number().int().positive().default(20000),
      })
      .strict()
      .default({
        max_calls_per_run: 3,
        max_runtime_ms: 20000,
      }),
    security: z
      .object({
        requires_human_approval: z.boolean().default(true),
        kill_switch: z.enum(["enabled", "disabled"]).default("enabled"),
        scopes: z.array(z.string().min(1)).default(["identity:create"]),
      })
      .strict()
      .default({
        requires_human_approval: true,
        kill_switch: "enabled",
        scopes: ["identity:create"],
      }),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict();

const aidenIdAdapterContractSchema = z
  .object({
    version: z
      .literal(AIDENID_ADAPTER_CONTRACT_SCHEMA_VERSION)
      .default(AIDENID_ADAPTER_CONTRACT_SCHEMA_VERSION),
    provider: z.literal("aidenid"),
    generated_at: z.string().min(1),
    registry_file: z.string().min(1),
    transport: z
      .object({
        base_url: z.string().url(),
        timeout_ms: z.number().int().positive().default(15000),
        auth: z
          .object({
            mode: z.enum(["bearer", "api_key", "oauth2", "none"]).default("bearer"),
            secret_ref: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    tool_bindings: z.array(aidenIdProvisioningBindingSchema).min(1),
  })
  .strict();

const hostedSessionConnectorToolSchema = z
  .object({
    tool_name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_.:-]+$/, "tool_name must contain only [a-zA-Z0-9_.:-]"),
    local_tool_name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_.:-]+$/, "local_tool_name must contain only [a-zA-Z0-9_.:-]"),
    operation: z.enum([
      "join_and_hydrate",
      "read_history",
      "send_message",
      "session_action",
      "session_lock",
      "session_unlock",
      "list_locks",
      "attention_request",
      "subscribe_wake",
      "presence_renew",
      "runner_teardown",
    ]),
    input_policy: z
      .object({
        identity_source: z.literal("server_session_seat"),
        rejects_identity_from_tool_args: z.literal(true),
        allowed_user_args: z.array(z.string().min(1)).default([]),
        forbidden_capability_args: z
          .array(z.enum(["sessionId", "session_id", "agentId", "agent_id", "userId", "user_id", "orgId", "org_id"]))
          .default(["sessionId", "session_id", "agentId", "agent_id", "userId", "user_id", "orgId", "org_id"]),
      })
      .strict(),
    authorization: z
      .object({
        requires_validated_claims: z.literal(true),
        requires_session_seat: z.literal(true),
        required_scopes: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    wake_payload: z
      .object({
        policy: z.enum(["none", "cursor_reason_counts_only", "bounded_redacted_window"]),
        may_include_message_content: z.boolean().default(false),
        max_events: z.number().int().positive().max(200).optional(),
      })
      .strict()
      .superRefine((payload, ctx) => {
        if (payload.policy === "cursor_reason_counts_only" && payload.may_include_message_content) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["may_include_message_content"],
            message: "cursor/reason wake payloads must not include message content.",
          });
        }
      }),
    audit: z
      .object({
        durable_receipt_required: z.literal(true),
        idempotency_key_fields: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    runner_lifecycle: z
      .object({
        requires_scoped_runner_token: z.literal(true),
        revoke_token_on_idle_teardown: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();

const hostedSessionConnectorContractSchema = z
  .object({
    version: z
      .literal(HOSTED_SENTI_SESSION_CONNECTOR_CONTRACT_SCHEMA_VERSION)
      .default(HOSTED_SENTI_SESSION_CONNECTOR_CONTRACT_SCHEMA_VERSION),
    provider: z.literal("sentinelayer"),
    connector: z.literal("hosted-senti-session"),
    generated_at: z.string().min(1),
    local_registry_file: z.string().min(1),
    runtime_status: z.literal("contract_only"),
    boundary: z
      .object({
        transport: z.literal("https_mcp_streamable_http"),
        identity_source: z.literal("validated_oauth_claims_and_server_session_seat"),
        local_stdio_registry_is_not_hosted_capability: z.literal(true),
        long_lived_cli_token_passthrough_allowed: z.literal(false),
      })
      .strict(),
    tools: z.array(hostedSessionConnectorToolSchema).min(1),
    release_gates: z.array(z.string().min(1)).min(1),
  })
  .strict();

const REQUIRED_HOSTED_SESSION_CONNECTOR_RELEASE_GATES = [
  "oauth_resource_binding",
  "session_seat_ownership",
  "deny_identity_from_tool_args",
  "approval_policy_enforcement",
  "scoped_runner_token_revocation",
  "wake_payload_minimization",
  "durable_audit_receipts",
  "output_redaction",
  "omar_gate_mcp_security_pack",
];

const mcpServerTransportSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("http"),
      url: z.string().min(1),
      timeout_ms: z.number().int().positive().default(15000),
      auth: z
        .object({
          mode: z.enum(["bearer", "api_key", "oauth2", "none"]).default("bearer"),
          secret_ref: z.string().min(1).optional(),
          audience: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict()
    .superRefine((transport, ctx) => {
      if (!transport.auth) {
        return;
      }
      const mode = transport.auth.mode;
      if ((mode === "bearer" || mode === "oauth2") && !transport.auth.audience) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["auth", "audience"],
          message: "audience is required when auth.mode is bearer or oauth2.",
        });
      }
    }),
]);

const mcpServerConfigSchema = z
  .object({
    version: z.literal(MCP_SERVER_CONFIG_SCHEMA_VERSION).default(MCP_SERVER_CONFIG_SCHEMA_VERSION),
    server_id: z.string().regex(serverIdRegex),
    registry_file: z.string().min(1),
    transport: mcpServerTransportSchema,
    budgets: z
      .object({
        max_calls_per_run: z.number().int().positive().default(20),
        max_runtime_ms: z.number().int().positive().default(60000),
      })
      .strict()
      .default({
        max_calls_per_run: 20,
        max_runtime_ms: 60000,
      }),
    security: z
      .object({
        requires_human_approval: z.boolean().default(true),
        allow_network: z.boolean().default(false),
        kill_switch: z.enum(["enabled", "disabled"]).default("enabled"),
      })
      .strict()
      .default({
        requires_human_approval: true,
        allow_network: false,
        kill_switch: "enabled",
      }),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict();

/**
 * Build JSON schema for Sentinelayer MCP tool-registry documents.
 *
 * @returns {Record<string, any>}
 */
export function buildMcpToolRegistrySchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://sentinelayer.com/schemas/mcp-tool-registry.schema.json",
    title: "Sentinelayer MCP Tool Registry",
    type: "object",
    additionalProperties: false,
    required: ["version", "tools"],
    properties: {
      version: {
        type: "string",
        description: "Registry schema version.",
      },
      generated_at: {
        type: "string",
        format: "date-time",
      },
      tools: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "description", "input_schema", "transport"],
          properties: {
            name: {
              type: "string",
              pattern: "^[a-zA-Z0-9_.:-]+$",
            },
            title: {
              type: "string",
            },
            description: {
              type: "string",
            },
            input_schema: {
              type: "object",
            },
            transport: {
              type: "object",
              additionalProperties: false,
              required: ["type", "method", "url"],
              properties: {
                type: {
                  type: "string",
                  enum: ["http", "internal", "bridge"],
                },
                method: {
                  type: "string",
                  enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
                },
                url: {
                  type: "string",
                },
                timeout_ms: {
                  type: "integer",
                  minimum: 1,
                },
                auth: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    mode: {
                      type: "string",
                      enum: ["bearer", "api_key", "oauth2", "none"],
                    },
                    secret_ref: {
                      type: "string",
                    },
                  },
                },
              },
            },
            budgets: {
              type: "object",
              additionalProperties: false,
              properties: {
                max_calls_per_run: {
                  type: "integer",
                  minimum: 1,
                },
                max_runtime_ms: {
                  type: "integer",
                  minimum: 1,
                },
              },
            },
            security: {
              type: "object",
              additionalProperties: false,
              properties: {
                requires_human_approval: {
                  type: "boolean",
                },
                kill_switch: {
                  type: "string",
                  enum: ["enabled", "disabled"],
                },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
            metadata: {
              type: "object",
            },
          },
        },
      },
    },
  };
}

/**
 * Create a secure-by-default MCP tool-registry template for AIdenID provisioning.
 *
 * @param {{ generatedAt?: string }} [options]
 * @returns {Record<string, any>}
 */
export function buildAidenIdRegistryTemplate({ generatedAt = new Date().toISOString() } = {}) {
  return {
    version: MCP_TOOL_REGISTRY_SCHEMA_VERSION,
    generated_at: generatedAt,
    tools: [
      {
        name: "aidenid.provision_email",
        title: "AIdenID Provision Email Identity",
        description:
          "Provision an ephemeral email identity through AIdenID for autonomous agent workflows.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["ttl_seconds"],
          properties: {
            ttl_seconds: {
              type: "integer",
              minimum: 60,
              maximum: 86400,
              description: "Identity TTL in seconds.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
            },
            policy: {
              type: "object",
              additionalProperties: true,
              description: "Optional policy envelope passed to AIdenID.",
            },
          },
        },
        transport: {
          type: "http",
          method: "POST",
          url: "https://api.aidenid.com/v1/identities",
          timeout_ms: 15000,
          auth: {
            mode: "bearer",
            secret_ref: "AIDENID_API_KEY",
          },
        },
        budgets: {
          max_calls_per_run: 3,
          max_runtime_ms: 20000,
        },
        security: {
          requires_human_approval: true,
          kill_switch: "enabled",
          scopes: ["identity:create"],
        },
        metadata: {
          provider: "aidenid",
          adapter: "sentinelayer-cli",
          adapter_contract_file: ".sentinelayer/mcp/aidenid-provisioning-adapter.json",
        },
      },
    ],
  };
}

/**
 * Create a local SentinelLayer session MCP registry template.
 *
 * @param {{ generatedAt?: string }} [options]
 * @returns {Record<string, any>}
 */
export function buildSentinelayerSessionRegistryTemplate({ generatedAt = new Date().toISOString() } = {}) {
  return {
    version: MCP_TOOL_REGISTRY_SCHEMA_VERSION,
    generated_at: generatedAt,
    tools: [
      {
        name: "poll_inbox",
        title: "Poll Senti Inbox",
        description:
          "Poll durable SentinelLayer session events after an optional cursor and return events visible to one agent.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            actionLimit: { type: "integer", minimum: 1, maximum: 200 },
            includeActions: { type: "boolean" },
            includeSelf: { type: "boolean" },
            includeControlEvents: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/poll_inbox",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 60,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:read"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "send_message",
        title: "Send Senti Message",
        description:
          "Send an authenticated agent session_message through the canonical SentinelLayer session event API.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId", "message"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            message: { type: "string" },
            to: {
              type: "array",
              items: { type: "string" },
            },
            model: { type: "string" },
            role: { type: "string" },
            displayName: { type: "string" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/send_message",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 20,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:write"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "session_action",
        title: "Record Senti Session Action",
        description:
          "Record a low-noise message action such as ack, working_on, disregard, view, like, dislike, or reply against a target session event.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId", "actionType"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            actionType: {
              type: "string",
              enum: ["ack", "working_on", "reply", "like", "dislike", "disregard", "view"],
            },
            targetSequenceId: { type: "integer", minimum: 1 },
            targetCursor: { type: "string" },
            targetActionId: { type: "string" },
            note: { type: "string" },
            idempotencyKey: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1 },
            dryRun: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/session_action",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 40,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:write", "session:action"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "session_react",
        title: "React To Senti Message",
        description:
          "Acknowledge or react to a target session event with ack, like, or dislike.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId", "reaction"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            reaction: { type: "string", enum: ["ack", "like", "dislike"] },
            targetSequenceId: { type: "integer", minimum: 1 },
            targetCursor: { type: "string" },
            targetActionId: { type: "string" },
            idempotencyKey: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1 },
            dryRun: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/session_react",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 60,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:write", "session:action"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "session_reply",
        title: "Reply In Senti Thread",
        description:
          "Add a threaded reply/comment under a specific session event using the session action channel.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId", "targetSequenceId", "message"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            targetSequenceId: { type: "integer", minimum: 1 },
            targetCursor: { type: "string" },
            targetActionId: { type: "string" },
            message: { type: "string" },
            idempotencyKey: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1 },
            dryRun: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/session_reply",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 40,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:write", "session:action"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "session_lock",
        title: "Lock Senti Files",
        description:
          "Claim session-scoped file locks before editing files, using the same fail-closed lock registry as the CLI.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId", "files"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            files: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" }, minItems: 1 },
              ],
            },
            intent: { type: "string" },
            ttlSeconds: { type: "integer", minimum: 1 },
            syncRemote: { type: "boolean" },
            awaitRemoteSync: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/session_lock",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 20,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:lock"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "session_unlock",
        title: "Unlock Senti Files",
        description:
          "Release session-scoped file locks held by an agent.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId", "files"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            files: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" }, minItems: 1 },
              ],
            },
            reason: { type: "string" },
            force: { type: "boolean" },
            syncRemote: { type: "boolean" },
            awaitRemoteSync: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/session_unlock",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 20,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:lock"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "session_locks",
        title: "List Senti File Locks",
        description:
          "List active file locks for a session.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/session_locks",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 20,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:lock"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
      {
        name: "attention_request",
        title: "Request Senti Attention",
        description:
          "Create a help_request event for high-signal agent or human attention without chat polling.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "agentId", "message"],
          properties: {
            sessionId: { type: "string" },
            agentId: { type: "string" },
            message: { type: "string" },
            to: {
              type: "array",
              items: { type: "string" },
            },
            priority: { type: "string" },
            severity: { type: "string" },
            model: { type: "string" },
            role: { type: "string" },
            displayName: { type: "string" },
            idempotencyKey: { type: "string" },
            dryRun: { type: "boolean" },
          },
        },
        transport: {
          type: "internal",
          method: "POST",
          url: "sentinelayer://session/attention_request",
          timeout_ms: 15000,
          auth: { mode: "none" },
        },
        budgets: {
          max_calls_per_run: 20,
          max_runtime_ms: 15000,
        },
        security: {
          requires_human_approval: false,
          kill_switch: "enabled",
          scopes: ["session:write"],
        },
        metadata: {
          provider: "sentinelayer",
          adapter: "sentinelayer-cli",
          server: "sentinelayer-session-mcp",
        },
      },
    ],
  };
}

function hostedSessionTool({
  toolName,
  operation,
  allowedUserArgs,
  requiredScopes,
  wakePayload = { policy: "none", may_include_message_content: false },
  runnerLifecycle = null,
}) {
  const tool = {
    tool_name: toolName,
    local_tool_name: toolName,
    operation,
    input_policy: {
      identity_source: "server_session_seat",
      rejects_identity_from_tool_args: true,
      allowed_user_args: allowedUserArgs,
      forbidden_capability_args: ["sessionId", "session_id", "agentId", "agent_id", "userId", "user_id", "orgId", "org_id"],
    },
    authorization: {
      requires_validated_claims: true,
      requires_session_seat: true,
      required_scopes: requiredScopes,
    },
    wake_payload: wakePayload,
    audit: {
      durable_receipt_required: true,
      idempotency_key_fields: ["subject", "session_seat", "tool_name", "normalized_inputs"],
    },
  };
  if (runnerLifecycle) {
    tool.runner_lifecycle = runnerLifecycle;
  }
  return tool;
}

/**
 * Create the hosted Senti session connector contract.
 *
 * This is intentionally separate from the local stdio session registry. Local
 * tools need sessionId/agentId arguments; hosted tools must derive identity from
 * validated OAuth claims plus a server-side session seat and must not treat those
 * arguments as capabilities.
 *
 * @param {{ generatedAt?: string, localRegistryFile?: string }} [options]
 * @returns {Record<string, any>}
 */
export function buildHostedSentiSessionConnectorContract({
  generatedAt = new Date().toISOString(),
  localRegistryFile = ".sentinelayer/mcp/tool-registry.session-tools.json",
} = {}) {
  return {
    version: HOSTED_SENTI_SESSION_CONNECTOR_CONTRACT_SCHEMA_VERSION,
    provider: "sentinelayer",
    connector: "hosted-senti-session",
    generated_at: generatedAt,
    local_registry_file: String(localRegistryFile || "").trim() || ".sentinelayer/mcp/tool-registry.session-tools.json",
    runtime_status: "contract_only",
    boundary: {
      transport: "https_mcp_streamable_http",
      identity_source: "validated_oauth_claims_and_server_session_seat",
      local_stdio_registry_is_not_hosted_capability: true,
      long_lived_cli_token_passthrough_allowed: false,
    },
    tools: [
      hostedSessionTool({
        toolName: "poll_inbox",
        operation: "read_history",
        allowedUserArgs: ["cursor", "limit", "actionLimit", "includeActions"],
        requiredScopes: ["session:read"],
        wakePayload: { policy: "bounded_redacted_window", may_include_message_content: true, max_events: 50 },
      }),
      hostedSessionTool({
        toolName: "send_message",
        operation: "send_message",
        allowedUserArgs: ["message", "to", "idempotencyKey"],
        requiredScopes: ["session:write"],
      }),
      hostedSessionTool({
        toolName: "session_action",
        operation: "session_action",
        allowedUserArgs: ["actionType", "targetSequenceId", "targetCursor", "targetActionId", "note", "idempotencyKey"],
        requiredScopes: ["session:write", "session:action"],
      }),
      hostedSessionTool({
        toolName: "session_react",
        operation: "session_action",
        allowedUserArgs: ["reaction", "targetSequenceId", "targetCursor", "targetActionId", "idempotencyKey"],
        requiredScopes: ["session:write", "session:action"],
      }),
      hostedSessionTool({
        toolName: "session_reply",
        operation: "session_action",
        allowedUserArgs: ["targetSequenceId", "targetCursor", "targetActionId", "message", "idempotencyKey"],
        requiredScopes: ["session:write", "session:action"],
      }),
      hostedSessionTool({
        toolName: "session_lock",
        operation: "session_lock",
        allowedUserArgs: ["files", "intent", "ttlSeconds"],
        requiredScopes: ["session:lock"],
      }),
      hostedSessionTool({
        toolName: "session_unlock",
        operation: "session_unlock",
        allowedUserArgs: ["files", "reason"],
        requiredScopes: ["session:lock"],
      }),
      hostedSessionTool({
        toolName: "session_locks",
        operation: "list_locks",
        allowedUserArgs: [],
        requiredScopes: ["session:lock"],
      }),
      hostedSessionTool({
        toolName: "attention_request",
        operation: "attention_request",
        allowedUserArgs: ["message", "to", "priority", "severity", "idempotencyKey"],
        requiredScopes: ["session:write"],
        wakePayload: { policy: "cursor_reason_counts_only", may_include_message_content: false },
      }),
      hostedSessionTool({
        toolName: "subscribe_wake",
        operation: "subscribe_wake",
        allowedUserArgs: ["cadencePreset", "wakeTriggers", "sinceCursor"],
        requiredScopes: ["session:read", "session:wake"],
        wakePayload: { policy: "cursor_reason_counts_only", may_include_message_content: false },
        runnerLifecycle: {
          requires_scoped_runner_token: true,
          revoke_token_on_idle_teardown: true,
        },
      }),
    ],
    release_gates: [
      "oauth_resource_binding",
      "session_seat_ownership",
      "deny_identity_from_tool_args",
      "approval_policy_enforcement",
      "scoped_runner_token_revocation",
      "wake_payload_minimization",
      "durable_audit_receipts",
      "output_redaction",
      "omar_gate_mcp_security_pack",
    ],
  };
}

/**
 * Create an AIdenID adapter contract template that binds MCP tools to provisioning endpoints.
 *
 * @param {{ generatedAt?: string, registryFile?: string }} [options]
 * @returns {Record<string, any>}
 */
export function buildAidenIdProvisioningAdapterTemplate({
  generatedAt = new Date().toISOString(),
  registryFile = ".sentinelayer/mcp/tool-registry.aidenid-template.json",
} = {}) {
  return {
    version: AIDENID_ADAPTER_CONTRACT_SCHEMA_VERSION,
    provider: "aidenid",
    generated_at: generatedAt,
    registry_file: String(registryFile || "").trim() || ".sentinelayer/mcp/tool-registry.aidenid-template.json",
    transport: {
      base_url: "https://api.aidenid.com",
      timeout_ms: 15000,
      auth: {
        mode: "bearer",
        secret_ref: "AIDENID_API_KEY",
      },
    },
    tool_bindings: [
      {
        tool_name: "aidenid.provision_email",
        operation: "provision_email",
        method: "POST",
        path: "/v1/identities",
        request_template: {
          ttl_seconds: "{{input.ttl_seconds}}",
          tags: "{{input.tags}}",
          policy: "{{input.policy}}",
        },
        response_contract: {
          identity_id_path: "$.identity.id",
          email_path: "$.identity.email",
          expires_at_path: "$.identity.expires_at",
        },
        budgets: {
          max_calls_per_run: 3,
          max_runtime_ms: 20000,
        },
        security: {
          requires_human_approval: true,
          kill_switch: "enabled",
          scopes: ["identity:create"],
        },
        metadata: {
          provider: "aidenid",
          adapter: "sentinelayer-cli",
        },
      },
    ],
  };
}

/**
 * Create a local MCP server config template with deterministic runtime budgets and security defaults.
 *
 * @param {{ serverId?: string, registryFile?: string, generatedAt?: string }} [options]
 * @returns {Record<string, any>}
 */
export function buildMcpServerConfigTemplate({
  serverId = "sentinelayer-local",
  registryFile = ".sentinelayer/mcp/tool-registry.aidenid-template.json",
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedId = String(serverId || "")
    .trim()
    .toLowerCase();
  if (!serverIdRegex.test(normalizedId)) {
    throw new Error("server id must use lowercase [a-z0-9._-] and be 1-64 chars.");
  }
  return {
    version: MCP_SERVER_CONFIG_SCHEMA_VERSION,
    server_id: normalizedId,
    registry_file: String(registryFile || "").trim() || ".sentinelayer/mcp/tool-registry.aidenid-template.json",
    transport: {
      mode: "stdio",
      command: "create-sentinelayer",
      args: ["mcp", "server", "run", "--config", `.sentinelayer/mcp/servers/${normalizedId}.json`],
    },
    budgets: {
      max_calls_per_run: 20,
      max_runtime_ms: 60000,
    },
    security: {
      requires_human_approval: true,
      allow_network: false,
      kill_switch: "enabled",
    },
    metadata: {
      generated_at: generatedAt,
      generated_by: "create-sentinelayer",
    },
  };
}

/**
 * Build VS Code bridge config content that points to Sentinelayer MCP server runtime.
 *
 * @param {{ serverId?: string, serverConfigFile?: string }} [options]
 * @returns {{ mcpServers: Record<string, { command: string, args: string[] }> }}
 */
export function buildVsCodeMcpBridgeTemplate({
  serverId,
  serverConfigFile,
} = {}) {
  const normalizedId = String(serverId || "")
    .trim()
    .toLowerCase();
  if (!serverIdRegex.test(normalizedId)) {
    throw new Error("server id must use lowercase [a-z0-9._-] and be 1-64 chars.");
  }
  return {
    mcpServers: {
      [normalizedId]: {
        command: "create-sentinelayer",
        args: ["mcp", "server", "run", "--config", String(serverConfigFile || "").trim()],
      },
    },
  };
}

/**
 * Validate and normalize a tool-registry payload against Sentinelayer MCP registry schema.
 *
 * @param {unknown} payload
 * @returns {any}
 */
export function validateMcpToolRegistry(payload) {
  const parsed = mcpRegistrySchema.parse(payload);
  return parsed;
}

/**
 * Validate and normalize AIdenID adapter contract payload.
 * Optionally cross-validates adapter tool bindings against a provided registry payload.
 *
 * @param {unknown} payload
 * @param {{ registryPayload?: unknown }} [options]
 * @returns {any}
 */
export function validateAidenIdAdapterContract(payload, { registryPayload } = {}) {
  const parsed = aidenIdAdapterContractSchema.parse(payload);

  if (registryPayload !== undefined) {
    const registry = validateMcpToolRegistry(registryPayload);
    const toolNameSet = new Set(registry.tools.map((tool) => tool.name));
    const missingToolBindings = parsed.tool_bindings
      .map((binding) => binding.tool_name)
      .filter((toolName) => !toolNameSet.has(toolName));
    if (missingToolBindings.length > 0) {
      throw new Error(
        `Adapter contract references tools not present in registry: ${missingToolBindings.join(", ")}`
      );
    }
  }

  return parsed;
}

/**
 * Validate and normalize hosted Senti session connector contract payload.
 * Optionally cross-validates hosted local_tool_name references against a local
 * session registry payload. Contract-only hosted tools, such as subscribe_wake,
 * can omit a local registry binding by using the same name as a non-local tool.
 *
 * @param {unknown} payload
 * @param {{ registryPayload?: unknown }} [options]
 * @returns {any}
 */
export function validateHostedSentiSessionConnectorContract(payload, { registryPayload } = {}) {
  const parsed = hostedSessionConnectorContractSchema.parse(payload);
  const releaseGateSet = new Set(parsed.release_gates);

  for (const gate of REQUIRED_HOSTED_SESSION_CONNECTOR_RELEASE_GATES) {
    if (!releaseGateSet.has(gate)) {
      throw new Error(`Hosted connector contract is missing required release gate ${gate}.`);
    }
  }

  for (const tool of parsed.tools) {
    const forbidden = new Set(tool.input_policy.forbidden_capability_args);
    for (const key of ["sessionId", "session_id", "agentId", "agent_id"]) {
      if (!forbidden.has(key)) {
        throw new Error(`Hosted connector tool ${tool.tool_name} must forbid capability argument ${key}.`);
      }
    }
    for (const arg of tool.input_policy.allowed_user_args) {
      if (forbidden.has(arg)) {
        throw new Error(`Hosted connector tool ${tool.tool_name} allows forbidden capability argument ${arg}.`);
      }
    }
    if (tool.operation === "subscribe_wake") {
      if (!tool.runner_lifecycle) {
        throw new Error(`Hosted connector tool ${tool.tool_name} must define scoped runner-token lifecycle controls.`);
      }
      if (!tool.runner_lifecycle.requires_scoped_runner_token) {
        throw new Error(`Hosted connector tool ${tool.tool_name} must require a scoped runner token.`);
      }
      if (!tool.runner_lifecycle.revoke_token_on_idle_teardown) {
        throw new Error(`Hosted connector tool ${tool.tool_name} must revoke runner tokens on idle teardown.`);
      }
    }
  }

  if (registryPayload !== undefined) {
    const registry = validateMcpToolRegistry(registryPayload);
    const localToolNames = new Set(registry.tools.map((tool) => tool.name));
    const missingLocalTools = parsed.tools
      .filter((tool) => tool.operation !== "subscribe_wake" && tool.operation !== "presence_renew" && tool.operation !== "runner_teardown")
      .map((tool) => tool.local_tool_name)
      .filter((toolName) => !localToolNames.has(toolName));
    if (missingLocalTools.length > 0) {
      throw new Error(
        `Hosted connector references local tools not present in registry: ${[...new Set(missingLocalTools)].join(", ")}`
      );
    }
  }

  return parsed;
}

/**
 * Validate and normalize MCP server runtime config payload.
 *
 * @param {unknown} payload
 * @returns {any}
 */
export function validateMcpServerConfig(payload) {
  return mcpServerConfigSchema.parse(payload);
}

/**
 * Serialize a value into pretty-printed JSON with trailing newline for deterministic artifacts.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write JSON file with optional overwrite protection.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function writeJsonFile(filePath, value, { force = false } = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!force) {
    try {
      await fsp.access(resolvedPath);
      throw new Error(`File already exists: ${resolvedPath}. Use --force to overwrite.`);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        // missing file is expected
      } else if (error instanceof Error && error.message.startsWith("File already exists:")) {
        throw error;
      } else if (error) {
        throw error;
      }
    }
  }
  await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fsp.writeFile(resolvedPath, stringifyJson(value), "utf-8");
  return resolvedPath;
}

/**
 * Read and parse JSON from disk using an absolute resolved path.
 *
 * @param {string} filePath
 * @returns {Promise<{ path: string, data: any }>}
 */
export async function readJsonFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const rawText = await fsp.readFile(resolvedPath, "utf-8");
  return {
    path: resolvedPath,
    data: JSON.parse(rawText),
  };
}

/**
 * Resolve default output path for generated MCP registry schema artifacts.
 *
 * @param {{ cwd?: string, outputDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<string>}
 */
export async function resolveDefaultMcpOutputPath({ cwd, outputDir, env } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd,
    outputDirOverride: outputDir,
    env,
  });
  return path.join(outputRoot, "mcp", "tool-registry.schema.json");
}

/**
 * Resolve default output path for generated AIdenID adapter contract artifacts.
 *
 * @param {{ cwd?: string, outputDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<string>}
 */
export async function resolveDefaultAidenIdAdapterContractPath({ cwd, outputDir, env } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd,
    outputDirOverride: outputDir,
    env,
  });
  return path.join(outputRoot, "mcp", "aidenid-provisioning-adapter.json");
}

/**
 * Resolve default output path for hosted Senti session connector contracts.
 *
 * @param {{ cwd?: string, outputDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<string>}
 */
export async function resolveDefaultHostedSentiSessionConnectorContractPath({ cwd, outputDir, env } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd,
    outputDirOverride: outputDir,
    env,
  });
  return path.join(outputRoot, "mcp", "hosted-senti-session-connector.json");
}

/**
 * Resolve default MCP server config output path for a specific server id.
 *
 * @param {{ cwd?: string, outputDir?: string, env?: NodeJS.ProcessEnv, serverId?: string }} [options]
 * @returns {Promise<string>}
 */
export async function resolveDefaultMcpServerConfigPath({
  cwd,
  outputDir,
  env,
  serverId,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd,
    outputDirOverride: outputDir,
    env,
  });
  const normalizedId = String(serverId || "")
    .trim()
    .toLowerCase();
  if (!serverIdRegex.test(normalizedId)) {
    throw new Error("server id must use lowercase [a-z0-9._-] and be 1-64 chars.");
  }
  return path.join(outputRoot, "mcp", "servers", `${normalizedId}.json`);
}

/**
 * Resolve default VS Code MCP bridge file path.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
export function resolveDefaultVsCodeBridgePath({ cwd } = {}) {
  return path.join(path.resolve(cwd || process.cwd()), ".vscode", "mcp.json");
}
