// Amina (ai-governance persona) domain-tool registry (#A24).

import { runEvalRegression } from "./eval-regression.js";
import { runHitlAudit } from "./hitl-audit.js";
import { runProvenanceCheck } from "./provenance-check.js";
import { runPromptDrift } from "./prompt-drift.js";

export const AI_GOVERNANCE_TOOLS = Object.freeze({
  "eval-regression": {
    id: "eval-regression",
    description: "Advise when LLM usage is detected but no evals/ or promptfoo config exists.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runEvalRegression,
  },
  "prompt-drift": {
    id: "prompt-drift",
    description: "Flag prompt files under prompts/ / ai/ / llm/ that lack a version header.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runPromptDrift,
  },
  "hitl-audit": {
    id: "hitl-audit",
    description: "Flag files that call an LLM and then run a destructive action without human-in-the-loop approval signals.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runHitlAudit,
  },
  "provenance-check": {
    id: "provenance-check",
    description: "Flag generateContent / composeEmail / LLM-generated content without provenance (ai-generated header, C2PA, watermark).",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runProvenanceCheck,
  },
});

export const AI_GOVERNANCE_TOOL_IDS = Object.freeze(Object.keys(AI_GOVERNANCE_TOOLS));

export async function dispatchAiGovernanceTool(toolId, args = {}) {
  const tool = AI_GOVERNANCE_TOOLS[toolId];
  if (!tool) throw new Error(`Unknown ai-governance tool: ${toolId}`);
  return tool.handler(args);
}

export async function runAllAiGovernanceTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of AI_GOVERNANCE_TOOL_IDS) {
    const out = await dispatchAiGovernanceTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export { runEvalRegression, runHitlAudit, runProvenanceCheck, runPromptDrift };
