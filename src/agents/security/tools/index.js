// Nina (security persona) domain-tool registry (#A13).
//
// Each entry exports (a) the tool id the LLM references in tool_use blocks,
// (b) a schema describing the expected arguments, and (c) the async handler.

import { runAuthzAudit } from "./authz-audit.js";
import { runCryptoReview } from "./crypto-review.js";
import { runSastScan } from "./sast-scan.js";
import { runSecretsScan } from "./secrets-scan.js";

export const SECURITY_TOOLS = Object.freeze({
  "sast-scan": {
    id: "sast-scan",
    description:
      "Pattern-based SAST over JS/TS/Python/Go/Ruby/Java sources. Returns P0/P1 findings for eval, dynamic Function, shell-injection, innerHTML XSS, Python exec/compile, subprocess shell=True, fs.readFile path traversal.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string", description: "Repo root (defaults to CWD)." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional explicit file list; defaults to a full repo walk.",
        },
      },
    },
    handler: runSastScan,
  },
  "secrets-scan": {
    id: "secrets-scan",
    description:
      "Scan the repo for hardcoded AWS/GitHub/Slack/OpenAI/Anthropic/Stripe tokens, private key blocks, and entropy-gated generic credentials.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runSecretsScan,
  },
  "authz-audit": {
    id: "authz-audit",
    description:
      "Inspect mutation-style route handlers (POST/PUT/PATCH/DELETE in Express / Fastify / Next.js app router / Python FastAPI / Flask) and flag those without a recognizable auth guard above them.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runAuthzAudit,
  },
  "crypto-review": {
    id: "crypto-review",
    description:
      "Flag MD5/SHA-1 for security use, Math.random in token/secret/nonce contexts, TLS verification disabled (rejectUnauthorized=false / verify=False / InsecureSkipVerify=true), and hardcoded cipher IVs.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runCryptoReview,
  },
});

export const SECURITY_TOOL_IDS = Object.freeze(Object.keys(SECURITY_TOOLS));

export async function dispatchSecurityTool(toolId, args = {}) {
  const tool = SECURITY_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown security tool: ${toolId}`);
  }
  return tool.handler(args);
}

// Run every tool in sequence and return a flat Finding[] across all of
// them. Used by the persona orchestrator when a "full security sweep" is
// requested.
export async function runAllSecurityTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of SECURITY_TOOL_IDS) {
    const out = await dispatchSecurityTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export {
  runAuthzAudit,
  runCryptoReview,
  runSastScan,
  runSecretsScan,
};
