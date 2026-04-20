// sbom-diff — advise when no SBOM is generated (#A22).

import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runSbomDiff({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  let hasManifest = false;
  let hasSbom = false;
  for await (const { relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (/(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile)$/i.test(rel)) {
      hasManifest = true;
    }
    if (/(^|\/)(sbom|bom)\.(xml|json|spdx|spdx\.json|cdx\.json)$/i.test(rel) || /cyclonedx|spdx/i.test(rel)) {
      hasSbom = true;
    }
  }
  if (!hasManifest || hasSbom) return [];
  return [
    createFinding({
      tool: "sbom-diff",
      kind: "supply-chain.no-sbom",
      severity: "P2",
      file: "",
      line: 0,
      evidence: "Project manifest present but no SBOM (CycloneDX / SPDX) checked in",
      rootCause: "Without an SBOM, consumers of the build can't verify what they're running. Compliance regimes (EO 14028, CRA) increasingly require one.",
      recommendedFix: "Generate SBOM in CI via syft or cyclonedx-bom and attach to every release. Commit an example (sbom.cdx.json) so reviewers can diff.",
      confidence: 0.55,
    }),
  ];
}
