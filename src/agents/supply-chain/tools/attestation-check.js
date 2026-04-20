// attestation-check — advise when CI doesn't publish provenance (#A22).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runAttestationCheck({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  let hasRelease = false;
  let hasAttestation = false;
  for await (const { fullPath, relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (!/(^|\/)\.github\/workflows\//.test(rel)) continue;
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    if (/(?:release|publish|deploy)/i.test(rel) || /npm\s+publish|docker\s+push|gh\s+release\s+create/.test(content)) {
      hasRelease = true;
    }
    if (/actions\/attest-build-provenance|sigstore|cosign|slsa/i.test(content)) {
      hasAttestation = true;
    }
  }
  if (!hasRelease || hasAttestation) return [];
  return [
    createFinding({
      tool: "attestation-check",
      kind: "supply-chain.no-attestation",
      severity: "P2",
      file: "",
      line: 0,
      evidence: "Release / publish workflow found without any sigstore / cosign / SLSA provenance attestation",
      rootCause: "Artifacts published without attestations can't be verified downstream. Attackers who compromise a maintainer account ship silently.",
      recommendedFix: "Add actions/attest-build-provenance (GitHub) or cosign to the release workflow. Verify on install via cosign verify-blob / npm-audit-signatures.",
      confidence: 0.6,
    }),
  ];
}
