// package-verify — flag packages pinned to suspicious versions (#A22).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const SUSPICIOUS_VERSION_PATTERNS = [
  { pattern: /^(?:github|git)[:+]/i, reason: "installed directly from a git URL" },
  { pattern: /^file:/i, reason: "installed from a local file path" },
  { pattern: /^\*$/, reason: "wildcard version (pins to any release)" },
];

export async function runPackageVerify({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  for await (const { fullPath, relativePath } of walkRepoFiles({ rootPath: resolvedRoot, extensions: new Set([".json"]) })) {
    if (!/(^|\/)package\.json$/.test(toPosix(relativePath))) continue;
    let raw;
    try {
      raw = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = parsed?.[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, version] of Object.entries(deps)) {
        for (const rule of SUSPICIOUS_VERSION_PATTERNS) {
          if (rule.pattern.test(String(version))) {
            findings.push(
              createFinding({
                tool: "package-verify",
                kind: "supply-chain.unpinned-dep",
                severity: rule.reason.includes("wildcard") ? "P1" : "P2",
                file: toPosix(relativePath),
                line: 0,
                evidence: `"${name}": "${version}" — ${rule.reason}`,
                rootCause: "Dependencies pinned to unverifiable sources (git URLs, local paths, wildcards) mean the install graph is non-reproducible and potentially unaudited.",
                recommendedFix: "Pin to a registry version (semver range or exact). If you truly need a git dep, pin to a commit SHA and mirror through a private registry.",
                confidence: 0.75,
              })
            );
          }
        }
      }
    }
  }
  return findings;
}
