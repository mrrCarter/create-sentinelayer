// Omar (release persona) domain-tool registry (#A19).

import { runChangelogDiff } from "./changelog-diff.js";
import { runFeatureFlagAudit } from "./feature-flag-audit.js";
import { runRollbackVerify } from "./rollback-verify.js";
import { runSemverCheck } from "./semver-check.js";

export const RELEASE_TOOLS = Object.freeze({
  "semver-check": {
    id: "semver-check",
    description: "Verify every non-private package.json has a valid semver version and a colocated changelog.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runSemverCheck,
  },
  "changelog-diff": {
    id: "changelog-diff",
    description: "Verify the current version in package.json has a matching heading in the colocated CHANGELOG.md.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runChangelogDiff,
  },
  "rollback-verify": {
    id: "rollback-verify",
    description: "Ensure Alembic / Rails / Knex migrations define a down / downgrade / change path so `db:rollback` isn't a no-op.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runRollbackVerify,
  },
  "feature-flag-audit": {
    id: "feature-flag-audit",
    description: "Flag feature-flag call sites in files not touched in ≥ 90 days, with no cleanup-by annotation nearby.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        staleDays: { type: "number" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runFeatureFlagAudit,
  },
});

export const RELEASE_TOOL_IDS = Object.freeze(Object.keys(RELEASE_TOOLS));

export async function dispatchReleaseTool(toolId, args = {}) {
  const tool = RELEASE_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown release tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllReleaseTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of RELEASE_TOOL_IDS) {
    const out = await dispatchReleaseTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export { runChangelogDiff, runFeatureFlagAudit, runRollbackVerify, runSemverCheck };
