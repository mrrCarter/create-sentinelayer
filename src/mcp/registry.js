import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

import { resolveOutputRoot } from "../config/service.js";

export const MCP_TOOL_REGISTRY_SCHEMA_VERSION = "1.0.0";
export const MCP_SERVER_CONFIG_SCHEMA_VERSION = "1.0.0";
export const AIDENID_ADAPTER_CONTRACT_SCHEMA_VERSION = "1.0.0";

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
        requires_human_approval: z.boolean().default(false),
        kill_switch: z.enum(["enabled", "disabled"]).default("enabled"),
        scopes: z.array(z.string().min(1)).default(["identity:create"]),
      })
      .strict()
      .default({
        requires_human_approval: false,
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
        })
        .optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
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
        requires_human_approval: z.boolean().default(false),
        allow_network: z.boolean().default(false),
        kill_switch: z.enum(["enabled", "disabled"]).default("enabled"),
      })
      .strict()
      .default({
        requires_human_approval: false,
        allow_network: false,
        kill_switch: "enabled",
      }),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict();

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
          requires_human_approval: false,
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
          requires_human_approval: false,
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
      requires_human_approval: false,
      allow_network: false,
      kill_switch: "enabled",
    },
    metadata: {
      generated_at: generatedAt,
      generated_by: "create-sentinelayer",
    },
  };
}

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

export function validateMcpToolRegistry(payload) {
  const parsed = mcpRegistrySchema.parse(payload);
  return parsed;
}

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

export function validateMcpServerConfig(payload) {
  return mcpServerConfigSchema.parse(payload);
}

export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

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

export async function readJsonFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const rawText = await fsp.readFile(resolvedPath, "utf-8");
  return {
    path: resolvedPath,
    data: JSON.parse(rawText),
  };
}

export async function resolveDefaultMcpOutputPath({ cwd, outputDir, env } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd,
    outputDirOverride: outputDir,
    env,
  });
  return path.join(outputRoot, "mcp", "tool-registry.schema.json");
}

export async function resolveDefaultAidenIdAdapterContractPath({ cwd, outputDir, env } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd,
    outputDirOverride: outputDir,
    env,
  });
  return path.join(outputRoot, "mcp", "aidenid-provisioning-adapter.json");
}

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

export function resolveDefaultVsCodeBridgePath({ cwd } = {}) {
  return path.join(path.resolve(cwd || process.cwd()), ".vscode", "mcp.json");
}
