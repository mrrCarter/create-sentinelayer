// Arjun (performance persona) domain-tool registry (#A16).

import { runBlockingIoAudit } from "./blocking-io-audit.js";
import { runBundleBudgetCheck } from "./bundle-budget-check.js";
import { runCachePolicyAudit } from "./cache-policy-audit.js";
import { runNPlusOneDetect } from "./n-plus-one-detect.js";

export const PERFORMANCE_TOOLS = Object.freeze({
  "n-plus-one-detect": {
    id: "n-plus-one-detect",
    description:
      "Flag loop-scoped HTTP, database, repository, or query calls that can become N+1 fan-out under load.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runNPlusOneDetect,
  },
  "blocking-io-audit": {
    id: "blocking-io-audit",
    description:
      "Flag synchronous filesystem, child-process, or sleep calls that block hot runtime paths.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runBlockingIoAudit,
  },
  "cache-policy-audit": {
    id: "cache-policy-audit",
    description:
      "Flag request handlers that do expensive remote/database work without a cache, TTL, revalidation, or no-store policy.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runCachePolicyAudit,
  },
  "bundle-budget-check": {
    id: "bundle-budget-check",
    description:
      "Flag oversized client files and heavyweight module-scope imports that can inflate frontend bundles.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runBundleBudgetCheck,
  },
});

export const PERFORMANCE_TOOL_IDS = Object.freeze(Object.keys(PERFORMANCE_TOOLS));

export async function dispatchPerformanceTool(toolId, args = {}) {
  const tool = PERFORMANCE_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown performance tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllPerformanceTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of PERFORMANCE_TOOL_IDS) {
    const out = await dispatchPerformanceTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export {
  runBlockingIoAudit,
  runBundleBudgetCheck,
  runCachePolicyAudit,
  runNPlusOneDetect,
};
