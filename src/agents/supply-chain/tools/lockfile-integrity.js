// lockfile-integrity — verify lockfile shape (#A22).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runLockfileIntegrity({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  const manifestsByDir = new Map();
  const lockfilesByDir = new Map();
  for await (const { fullPath, relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    const dir = path.posix.dirname(rel);
    if (/(^|\/)package\.json$/.test(rel)) {
      try {
        const raw = await fsp.readFile(fullPath, "utf-8");
        manifestsByDir.set(dir, { fullPath, rel, parsed: JSON.parse(raw) });
      } catch {
        /* bad JSON — skip */
      }
    }
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(rel)) {
      lockfilesByDir.set(dir, { fullPath, rel });
    }
  }
  for (const [dir, manifest] of manifestsByDir) {
    if (manifest.parsed?.private === true) continue;
    const lockfile = lockfilesByDir.get(dir);
    if (!lockfile) {
      findings.push(
        createFinding({
          tool: "lockfile-integrity",
          kind: "supply-chain.no-lockfile",
          severity: "P1",
          file: manifest.rel,
          line: 0,
          evidence: `package.json in ${dir}/ has no colocated lockfile`,
          rootCause: "Without a lockfile every install resolves dependencies freshly — non-reproducible builds and open to dependency-confusion attacks.",
          recommendedFix: "Commit package-lock.json (npm 7+), yarn.lock, or pnpm-lock.yaml. Run `npm ci` / `yarn install --frozen-lockfile` / `pnpm install --frozen-lockfile` in CI.",
          confidence: 0.95,
        })
      );
      continue;
    }
    // Quick shape check on package-lock.json
    if (/package-lock\.json$/.test(lockfile.rel)) {
      try {
        const raw = await fsp.readFile(lockfile.fullPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed.lockfileVersion || parsed.lockfileVersion < 2) {
          findings.push(
            createFinding({
              tool: "lockfile-integrity",
              kind: "supply-chain.stale-lockfile-version",
              severity: "P2",
              file: lockfile.rel,
              line: 0,
              evidence: `lockfileVersion = ${parsed.lockfileVersion}`,
              rootCause: "npm lockfileVersion < 2 misses integrity hashes for nested deps and is incompatible with modern npm.",
              recommendedFix: "Run `npm install` with npm 7+ to regenerate the lockfile at version 3.",
              confidence: 0.85,
            })
          );
        }
      } catch {
        /* malformed lockfile — skip */
      }
    }
  }
  return findings;
}
