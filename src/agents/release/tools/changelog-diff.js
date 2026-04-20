// changelog-diff — verify the changelog has an entry for the current version (#A19).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runChangelogDiff({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: new Set([".json"]) });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    if (!/(^|\/)package\.json$/.test(toPosix(relativePath))) {
      continue;
    }
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
    if (!parsed?.version || parsed.private === true) {
      continue;
    }
    const dir = path.dirname(fullPath);
    let changelog = "";
    for (const candidate of ["CHANGELOG.md", "CHANGES.md"]) {
      try {
        changelog = await fsp.readFile(path.join(dir, candidate), "utf-8");
        break;
      } catch {
        /* try next */
      }
    }
    if (!changelog) {
      continue; // semver-check already advises on missing changelog
    }
    const versionPattern = new RegExp(
      `##\\s*(?:\\[|v)?\\s*${String(parsed.version).replace(/\./g, "\\.")}\\b`
    );
    if (!versionPattern.test(changelog)) {
      findings.push(
        createFinding({
          tool: "changelog-diff",
          kind: "release.version-not-in-changelog",
          severity: "P2",
          file: toPosix(relativePath),
          line: 0,
          evidence: `package.json version "${parsed.version}" not found as a heading in the colocated changelog`,
          rootCause:
            "Changelog is out of sync with the manifest. Releases shipped without a changelog entry are invisible to consumers tracking what's new.",
          recommendedFix:
            "Add a `## [${version}] - YYYY-MM-DD` heading to the changelog before publishing. Wire release-please / changesets to keep them in sync automatically.",
          confidence: 0.8,
        })
      );
    }
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}
