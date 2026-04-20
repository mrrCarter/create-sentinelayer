// iam-least-priv-check — flag IAM wildcards (#A21).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const EXTENSIONS = new Set([".json", ".tf", ".yaml", ".yml"]);

const WILDCARD_RULES = [
  {
    pattern: /"Action"\s*:\s*\[?\s*"\*"/,
    kind: "infrastructure.iam-action-wildcard",
    severity: "P1",
    rootCause: "IAM policy grants Action:\"*\" — allows anything the principal can be used for. Privilege escalation path.",
    recommendedFix: "Enumerate the specific actions required (e.g. \"s3:GetObject\", \"s3:PutObject\"). Use IAM Access Analyzer to derive a least-privilege policy from CloudTrail.",
  },
  {
    pattern: /"Resource"\s*:\s*\[?\s*"\*"/,
    kind: "infrastructure.iam-resource-wildcard",
    severity: "P1",
    rootCause: "IAM policy grants Resource:\"*\" — permission applies to every resource in every account the principal can reach.",
    recommendedFix: "Scope Resource to specific ARNs (arn:aws:s3:::my-bucket/*). For actions that legitimately need all, document why.",
  },
  {
    pattern: /action\s*=\s*\[[^\]]*"\*"/,
    kind: "infrastructure.iam-action-wildcard",
    severity: "P1",
    rootCause: "Terraform IAM policy block grants action = [\"*\"] — same risk as the JSON form.",
    recommendedFix: "Enumerate specific actions.",
  },
];

export async function runIamLeastPrivCheck({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const rule of WILDCARD_RULES) {
      for (const match of findLineMatches(content, rule.pattern)) {
        findings.push(
          createFinding({
            tool: "iam-least-priv-check",
            kind: rule.kind,
            severity: rule.severity,
            file: toPosix(relativePath),
            line: match.line,
            evidence: getLineContent(content, match.line),
            rootCause: rule.rootCause,
            recommendedFix: rule.recommendedFix,
            confidence: 0.8,
          })
        );
      }
    }
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) continue;
    const fullPath = path.isAbsolute(trimmed) ? trimmed : path.join(resolvedRoot, trimmed);
    const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}
