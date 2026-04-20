// Noah (reliability persona) domain-tool registry (#A18).

import { runBackpressureCheck } from "./backpressure-check.js";
import { runChaosProbe } from "./chaos-probe.js";
import { runGracefulDegradationCheck } from "./graceful-degradation-check.js";
import { runHealthCheckAudit } from "./health-check-audit.js";

export const RELIABILITY_TOOLS = Object.freeze({
  "chaos-probe": {
    id: "chaos-probe",
    description:
      "Report whether the repo has any chaos-testing / fault-injection signals (chaostoolkit, chaos-monkey-js, LitmusChaos, gremlin). Only advises when the repo has ≥3 outbound-HTTP call sites.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runChaosProbe,
  },
  "health-check-audit": {
    id: "health-check-audit",
    description:
      "Flag service directories that declare HTTP routes but don't expose /health /healthz /ready /live / _status.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runHealthCheckAudit,
  },
  "graceful-degradation-check": {
    id: "graceful-degradation-check",
    description:
      "Flag files that make outbound HTTP calls without try/catch, cached fallback, feature-flag, or circuit-breaker in scope.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runGracefulDegradationCheck,
  },
  "backpressure-check": {
    id: "backpressure-check",
    description:
      "Find queue/worker consumers (Bull, Kafka, SQS, RabbitMQ, Redis pub/sub, Celery) and flag those missing concurrency caps or DLQ / retry-limit configuration.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runBackpressureCheck,
  },
});

export const RELIABILITY_TOOL_IDS = Object.freeze(Object.keys(RELIABILITY_TOOLS));

export async function dispatchReliabilityTool(toolId, args = {}) {
  const tool = RELIABILITY_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown reliability tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllReliabilityTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of RELIABILITY_TOOL_IDS) {
    const out = await dispatchReliabilityTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export {
  runBackpressureCheck,
  runChaosProbe,
  runGracefulDegradationCheck,
  runHealthCheckAudit,
};
