// Linh (data-layer persona) domain-tool registry (#A17).

import { runIndexAudit } from "./index-audit.js";
import { runMigrationScan } from "./migration-scan.js";
import { runQueryExplain } from "./query-explain.js";
import { runTenancyScan } from "./tenancy-scan.js";

export const DATA_LAYER_TOOLS = Object.freeze({
  "query-explain": {
    id: "query-explain",
    description:
      "Scan source for query anti-patterns: SELECT without LIMIT, findAll in a loop (N+1), string-concatenated SQL, SELECT *.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runQueryExplain,
  },
  "migration-scan": {
    id: "migration-scan",
    description:
      "Scan migration files (.sql, alembic, prisma, knex, Rails db/migrate) for unsafe patterns: DROP TABLE/COLUMN, ADD COLUMN NOT NULL w/o default, CREATE INDEX w/o CONCURRENTLY, unbatched UPDATE.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runMigrationScan,
  },
  "index-audit": {
    id: "index-audit",
    description:
      "Cross-reference WHERE / JOIN columns in application code vs. CREATE INDEX / @Index / db_index declarations in migrations + models. Flag lookups with no matching index.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runIndexAudit,
  },
  "tenancy-scan": {
    id: "tenancy-scan",
    description:
      "Identify tenancy-owning tables (those whose schema includes tenant_id / org_id / workspace_id) and flag application queries that touch them without a tenancy filter.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        tenancyTables: { type: "array", items: { type: "string" } },
      },
    },
    handler: runTenancyScan,
  },
});

export const DATA_LAYER_TOOL_IDS = Object.freeze(Object.keys(DATA_LAYER_TOOLS));

export async function dispatchDataLayerTool(toolId, args = {}) {
  const tool = DATA_LAYER_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown data-layer tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllDataLayerTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of DATA_LAYER_TOOL_IDS) {
    const out = await dispatchDataLayerTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export { runIndexAudit, runMigrationScan, runQueryExplain, runTenancyScan };
