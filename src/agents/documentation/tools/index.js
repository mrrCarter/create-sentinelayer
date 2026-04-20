// Samir (documentation persona) domain-tool registry (#A23).

import { runApiDiff } from "./api-diff.js";
import { runDeadLinkCheck } from "./dead-link-check.js";
import { runDocstringCoverage } from "./docstring-coverage.js";
import { runReadmeFreshness } from "./readme-freshness.js";

export const DOCUMENTATION_TOOLS = Object.freeze({
  "docstring-coverage": {
    id: "docstring-coverage",
    description: "Flag exported functions (JS/TS) without a leading comment / JSDoc block.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runDocstringCoverage,
  },
  "readme-freshness": {
    id: "readme-freshness",
    description: "Flag missing top-level README.md or README > 180 days older than the newest source file.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, staleDays: { type: "number" } } },
    handler: runReadmeFreshness,
  },
  "api-diff": {
    id: "api-diff",
    description: "Detect HTTP endpoints in source and flag any that lack a matching entry in docs/, openapi*, swagger*, or API.md.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runApiDiff,
  },
  "dead-link-check": {
    id: "dead-link-check",
    description: "Scan markdown files for relative links whose target file doesn't exist.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runDeadLinkCheck,
  },
});

export const DOCUMENTATION_TOOL_IDS = Object.freeze(Object.keys(DOCUMENTATION_TOOLS));

export async function dispatchDocumentationTool(toolId, args = {}) {
  const tool = DOCUMENTATION_TOOLS[toolId];
  if (!tool) throw new Error(`Unknown documentation tool: ${toolId}`);
  return tool.handler(args);
}

export async function runAllDocumentationTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of DOCUMENTATION_TOOL_IDS) {
    const out = await dispatchDocumentationTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export { runApiDiff, runDeadLinkCheck, runDocstringCoverage, runReadmeFreshness };
