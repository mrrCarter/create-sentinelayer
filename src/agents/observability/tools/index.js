// Sofia (observability persona) domain-tool registry (#A20).

import { runAlertAudit } from "./alert-audit.js";
import { runDashboardGap } from "./dashboard-gap.js";
import { runLogSchemaCheck } from "./log-schema-check.js";
import { runSpanCoverage } from "./span-coverage.js";

export const OBSERVABILITY_TOOLS = Object.freeze({
  "span-coverage": {
    id: "span-coverage",
    description: "Flag route handlers that have no OpenTelemetry / Sentry / Datadog tracing span in scope.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runSpanCoverage,
  },
  "dashboard-gap": {
    id: "dashboard-gap",
    description: "Report if no dashboard configuration (Grafana JSON, Datadog TF, observability dir) is checked into the repo.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runDashboardGap,
  },
  "alert-audit": {
    id: "alert-audit",
    description: "Report if no declarative alert definitions (Prometheus rules, Datadog monitors, alertmanager) are checked in.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runAlertAudit,
  },
  "log-schema-check": {
    id: "log-schema-check",
    description: "Flag production source files (not tests / scripts / docs) that use console.log / print() instead of a structured logger.",
    schema: { type: "object", properties: { rootPath: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
    handler: runLogSchemaCheck,
  },
});

export const OBSERVABILITY_TOOL_IDS = Object.freeze(Object.keys(OBSERVABILITY_TOOLS));

export async function dispatchObservabilityTool(toolId, args = {}) {
  const tool = OBSERVABILITY_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown observability tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllObservabilityTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of OBSERVABILITY_TOOL_IDS) {
    const out = await dispatchObservabilityTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export { runAlertAudit, runDashboardGap, runLogSchemaCheck, runSpanCoverage };
