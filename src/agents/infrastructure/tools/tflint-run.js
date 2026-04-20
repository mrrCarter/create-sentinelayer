// tflint-run — advise when Terraform is present but tflint config is not (#A21).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runTflintRun({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  let hasTf = false;
  let hasConfig = false;
  for await (const { relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (/\.tf(vars)?$/i.test(rel)) hasTf = true;
    if (/(^|\/)\.tflint\.hcl$/i.test(rel)) hasConfig = true;
  }
  if (!hasTf || hasConfig) return [];
  return [
    createFinding({
      tool: "tflint-run",
      kind: "infrastructure.no-tflint-config",
      severity: "P2",
      file: "",
      line: 0,
      evidence: "Terraform files present but no .tflint.hcl config",
      rootCause: "Without tflint, Terraform lint issues (invalid attributes, deprecated syntax) make it to production plans.",
      recommendedFix: "Add .tflint.hcl and run tflint in CI before every terraform plan.",
      confidence: 0.65,
    }),
  ];
}
