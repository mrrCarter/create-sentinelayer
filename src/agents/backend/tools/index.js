// Maya (backend persona) domain-tool registry (#A14).

import { runCircuitBreakerCheck } from "./circuit-breaker-check.js";
import { runIdempotencyAudit } from "./idempotency-audit.js";
import { runRetryAudit } from "./retry-audit.js";
import { runTimeoutAudit } from "./timeout-audit.js";

export const BACKEND_TOOLS = Object.freeze({
  "circuit-breaker-check": {
    id: "circuit-breaker-check",
    description:
      "Flag files that make outbound HTTP calls (fetch / axios / got / http(s) / requests / httpx / urllib / aiohttp) without any circuit-breaker signal in scope.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runCircuitBreakerCheck,
  },
  "retry-audit": {
    id: "retry-audit",
    description:
      "Flag hand-rolled retry loops using constant delays (classic thundering-herd risk). Does not fire when p-retry / async-retry / tenacity / Polly is already in use.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runRetryAudit,
  },
  "timeout-audit": {
    id: "timeout-audit",
    description:
      "Flag outbound HTTP calls declared without an explicit timeout / AbortSignal — default timeouts in major clients are effectively infinite.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runTimeoutAudit,
  },
  "idempotency-audit": {
    id: "idempotency-audit",
    description:
      "Flag files that declare POST/PUT/PATCH handlers without any idempotency-key or dedupe plumbing. Catches double-charge / double-send risk.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runIdempotencyAudit,
  },
});

export const BACKEND_TOOL_IDS = Object.freeze(Object.keys(BACKEND_TOOLS));

export async function dispatchBackendTool(toolId, args = {}) {
  const tool = BACKEND_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown backend tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllBackendTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of BACKEND_TOOL_IDS) {
    const out = await dispatchBackendTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export {
  runCircuitBreakerCheck,
  runIdempotencyAudit,
  runRetryAudit,
  runTimeoutAudit,
};
