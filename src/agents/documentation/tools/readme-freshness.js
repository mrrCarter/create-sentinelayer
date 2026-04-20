// readme-freshness — flag stale READMEs (#A23).

import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const STALE_DAYS = 180;

export async function runReadmeFreshness({ rootPath, staleDays = STALE_DAYS } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const now = Date.now();
  const threshold = now - staleDays * 24 * 60 * 60 * 1000;
  const findings = [];
  let codeMaxMtime = 0;
  let readme = null;
  for await (const { relativePath, stat } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (/(^|\/)README\.md$/i.test(rel) && !readme) {
      readme = { rel, mtime: Number(stat?.mtimeMs || 0) };
    }
    if (/\.(js|jsx|ts|tsx|py|go|rb|mjs|cjs)$/i.test(rel)) {
      codeMaxMtime = Math.max(codeMaxMtime, Number(stat?.mtimeMs || 0));
    }
  }
  if (!readme) {
    findings.push(
      createFinding({
        tool: "readme-freshness",
        kind: "documentation.no-readme",
        severity: "P2",
        file: "",
        line: 0,
        evidence: "No top-level README.md",
        rootCause: "A repo without a README has no entry point for new contributors.",
        recommendedFix: "Add a README.md with: project purpose, quickstart, and how to contribute.",
        confidence: 0.9,
      })
    );
    return findings;
  }
  if (readme.mtime && readme.mtime < threshold && codeMaxMtime > readme.mtime) {
    const ageDays = Math.floor((now - readme.mtime) / (24 * 60 * 60 * 1000));
    const driftDays = Math.floor((codeMaxMtime - readme.mtime) / (24 * 60 * 60 * 1000));
    findings.push(
      createFinding({
        tool: "readme-freshness",
        kind: "documentation.stale-readme",
        severity: "P3",
        file: readme.rel,
        line: 0,
        evidence: `README last modified ${ageDays}d ago; newest code ${driftDays}d newer`,
        rootCause: "README is falling behind the code. New contributors will be guided by outdated instructions.",
        recommendedFix: "Review the quickstart + architecture sections and update anything that's moved.",
        confidence: 0.45,
      })
    );
  }
  return findings;
}

export { STALE_DAYS };
