// Kat (infrastructure persona) domain-tool registry (#A21).

import { runCheckovRun } from "./checkov-run.js";
import { runDriftDetect } from "./drift-detect.js";
import { runIamLeastPrivCheck } from "./iam-least-priv-check.js";
import { runTflintRun } from "./tflint-run.js";

export const INFRASTRUCTURE_TOOLS = Object.freeze({
  "tflint-run": {
    id: "tflint-run",
    description: "Advise when Terraform files are present but no .tflint.hcl config.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runTflintRun,
  },
  "checkov-run": {
    id: "checkov-run",
    description: "Advise when IaC (Terraform / Dockerfile / K8s) is present but no .checkov.yaml config.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runCheckovRun,
  },
  "drift-detect": {
    id: "drift-detect",
    description: "Flag any .tfstate committed to source and advise when no scheduled drift-detection job exists.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runDriftDetect,
  },
  "iam-least-priv-check": {
    id: "iam-least-priv-check",
    description: "Flag Action:\"*\" / Resource:\"*\" wildcards in IAM policy JSON + Terraform.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runIamLeastPrivCheck,
  },
});

export const INFRASTRUCTURE_TOOL_IDS = Object.freeze(Object.keys(INFRASTRUCTURE_TOOLS));

export async function dispatchInfrastructureTool(toolId, args = {}) {
  const tool = INFRASTRUCTURE_TOOLS[toolId];
  if (!tool) throw new Error(`Unknown infrastructure tool: ${toolId}`);
  return tool.handler(args);
}

export async function runAllInfrastructureTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of INFRASTRUCTURE_TOOL_IDS) {
    const out = await dispatchInfrastructureTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export { runCheckovRun, runDriftDetect, runIamLeastPrivCheck, runTflintRun };
