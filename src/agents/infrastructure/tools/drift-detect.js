// drift-detect — flag checked-in tfstate files and missing drift jobs (#A21).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runDriftDetect({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  let hasTf = false;
  let hasDriftJob = false;

  for await (const { fullPath, relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (/\.tf$/i.test(rel)) hasTf = true;
    if (/\.tfstate$/i.test(rel)) {
      findings.push(
        createFinding({
          tool: "drift-detect",
          kind: "infrastructure.tfstate-committed",
          severity: "P0",
          file: rel,
          line: 0,
          evidence: `.tfstate checked into source: ${rel}`,
          rootCause: "Terraform state files contain secrets (AWS creds, TLS keys, service account JSON) and should never be in source control.",
          recommendedFix: "Delete the file, rotate any credentials it contained, and add *.tfstate to .gitignore. Move state to a remote backend (S3 + DynamoDB lock, GCS, Azure Blob).",
          confidence: 0.98,
        })
      );
    }
    if (/(^|\/)\.github\/workflows\//.test(rel)) {
      try {
        const content = await fsp.readFile(fullPath, "utf-8");
        if (/terraform\s+plan\s+-detailed-exitcode|drift[-_]detect|tfplan[-_]diff/i.test(content)) {
          hasDriftJob = true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (hasTf && !hasDriftJob && !findings.some((f) => f.kind === "infrastructure.tfstate-committed")) {
    findings.push(
      createFinding({
        tool: "drift-detect",
        kind: "infrastructure.no-drift-job",
        severity: "P3",
        file: "",
        line: 0,
        evidence: "Terraform in repo but no scheduled drift-detection job in .github/workflows/",
        rootCause: "Without periodic `terraform plan`, infrastructure drifts silently when someone changes things in the console.",
        recommendedFix: "Add a scheduled workflow (daily is typical) that runs `terraform plan -detailed-exitcode` and opens an issue on non-zero exit.",
        confidence: 0.5,
      })
    );
  }
  return findings;
}
