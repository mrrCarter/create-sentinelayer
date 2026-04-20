// Nora (supply-chain persona) domain-tool registry (#A22).

import { runAttestationCheck } from "./attestation-check.js";
import { runLockfileIntegrity } from "./lockfile-integrity.js";
import { runPackageVerify } from "./package-verify.js";
import { runSbomDiff } from "./sbom-diff.js";

export const SUPPLY_CHAIN_TOOLS = Object.freeze({
  "sbom-diff": {
    id: "sbom-diff",
    description: "Advise when project has a manifest but no SBOM (CycloneDX / SPDX) checked in.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runSbomDiff,
  },
  "package-verify": {
    id: "package-verify",
    description: "Flag package.json deps pinned to git URLs, file: paths, or wildcards.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runPackageVerify,
  },
  "attestation-check": {
    id: "attestation-check",
    description: "Advise when a release / publish workflow ships artifacts without sigstore / cosign / SLSA provenance.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runAttestationCheck,
  },
  "lockfile-integrity": {
    id: "lockfile-integrity",
    description: "Verify every non-private package.json has a colocated lockfile at a modern version.",
    schema: { type: "object", properties: { rootPath: { type: "string" } } },
    handler: runLockfileIntegrity,
  },
});

export const SUPPLY_CHAIN_TOOL_IDS = Object.freeze(Object.keys(SUPPLY_CHAIN_TOOLS));

export async function dispatchSupplyChainTool(toolId, args = {}) {
  const tool = SUPPLY_CHAIN_TOOLS[toolId];
  if (!tool) throw new Error(`Unknown supply-chain tool: ${toolId}`);
  return tool.handler(args);
}

export async function runAllSupplyChainTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of SUPPLY_CHAIN_TOOL_IDS) {
    const out = await dispatchSupplyChainTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export { runAttestationCheck, runLockfileIntegrity, runPackageVerify, runSbomDiff };
