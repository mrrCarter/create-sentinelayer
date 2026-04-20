// Ethan (code-quality persona) domain-tool registry (#A16).

import { runComplexityMeasure } from "./complexity-measure.js";
import { runCouplingAnalysis } from "./coupling-analysis.js";
import { runCycleDetect } from "./cycle-detect.js";
import { runDepGraph } from "./dep-graph.js";

export const CODE_QUALITY_TOOLS = Object.freeze({
  "dep-graph": {
    id: "dep-graph",
    description:
      "Build the module-level import graph (local modules + npm: synthetic nodes for external packages). Returns a summary Finding; the graph is available on the finding's `graph` field.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runDepGraph,
  },
  "coupling-analysis": {
    id: "coupling-analysis",
    description:
      "Flag files with high fan-out (many imports) or high fan-in (many importers). Uses the dep-graph under the hood.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runCouplingAnalysis,
  },
  "cycle-detect": {
    id: "cycle-detect",
    description:
      "Find import cycles between local modules (npm: and absolute nodes are stripped before SCC).",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runCycleDetect,
  },
  "complexity-measure": {
    id: "complexity-measure",
    description:
      "Estimate per-function cyclomatic complexity via AST branching-node count. Defaults: P2 at CC ≥ 15, P1 at CC ≥ 30.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        p1Threshold: { type: "number" },
        p2Threshold: { type: "number" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runComplexityMeasure,
  },
});

export const CODE_QUALITY_TOOL_IDS = Object.freeze(Object.keys(CODE_QUALITY_TOOLS));

export async function dispatchCodeQualityTool(toolId, args = {}) {
  const tool = CODE_QUALITY_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown code-quality tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllCodeQualityTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of CODE_QUALITY_TOOL_IDS) {
    const out = await dispatchCodeQualityTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export {
  runComplexityMeasure,
  runCouplingAnalysis,
  runCycleDetect,
  runDepGraph,
};
