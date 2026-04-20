// checkov-run — advise when IaC is present but Checkov config is not (#A21).

import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runCheckovRun({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  let hasIac = false;
  let hasConfig = false;
  for await (const { relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (/\.tf$/i.test(rel)) hasIac = true;
    if (/(^|\/)Dockerfile(\.[\w-]+)?$/i.test(rel)) hasIac = true;
    if (/(^|\/)k8s\/|(^|\/)kubernetes\/|\.ya?ml$/i.test(rel) && /(deploy|statefulset|cronjob|job|daemonset)/i.test(rel)) hasIac = true;
    if (/(^|\/)\.checkov\.ya?ml$/i.test(rel)) hasConfig = true;
  }
  if (!hasIac || hasConfig) return [];
  return [
    createFinding({
      tool: "checkov-run",
      kind: "infrastructure.no-checkov-config",
      severity: "P2",
      file: "",
      line: 0,
      evidence: "Terraform / Dockerfile / K8s manifests present but no .checkov.yaml config",
      rootCause: "Without Checkov (or equivalent IaC scanner), misconfigurations (public S3 buckets, privileged containers) ship to production.",
      recommendedFix: "Add .checkov.yaml with a baseline skip-list and run `checkov -d .` in CI before apply.",
      confidence: 0.6,
    }),
  ];
}
