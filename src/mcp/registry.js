import fsp from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { resolveOutputRoot } from "../config/service.js";

export const MCP_TOOL_REGISTRY_SCHEMA_VERSION = "1.0.0";

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
        },
      },
    ],
  };
}

export function validateMcpToolRegistry(payload) {
  const parsed = mcpRegistrySchema.parse(payload);
  return parsed;
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
