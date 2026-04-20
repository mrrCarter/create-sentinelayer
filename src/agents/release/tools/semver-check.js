// semver-check — verify package.json version follows semver + matches the
// scope of its last release (#A19).
//
// Heuristic: look at every package.json the repo publishes and:
//  1. Verify the version literal parses as semver (N.N.N or N.N.N-prerelease)
//  2. Verify a CHANGELOG.md / CHANGES.md exists alongside it — having a
//     versioned artifact without a changelog is a release-discipline miss

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const PKG_EXTENSIONS = new Set([".json"]);
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export async function runSemverCheck({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: PKG_EXTENSIONS });

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
    if (!SEMVER_PATTERN.test(String(parsed.version))) {
      findings.push(
        createFinding({
          tool: "semver-check",
          kind: "release.invalid-semver",
          severity: "P1",
          file: toPosix(relativePath),
          line: 0,
          evidence: `version = "${parsed.version}"`,
          rootCause:
            "package.json version doesn't parse as semver. npm / Yarn / pnpm tooling and npm registry itself rely on strict semver.",
          recommendedFix: "Use the form MAJOR.MINOR.PATCH (optionally with -prerelease or +buildmeta).",
          confidence: 0.95,
        })
      );
    }

    // Look for a changelog next to the package.json.
    const dir = path.dirname(fullPath);
    const candidates = ["CHANGELOG.md", "CHANGES.md", "CHANGELOG.txt"];
    let hasChangelog = false;
    for (const candidate of candidates) {
      try {
        await fsp.stat(path.join(dir, candidate));
        hasChangelog = true;
        break;
      } catch {
        /* missing — try next */
      }
    }
    if (!hasChangelog) {
      findings.push(
        createFinding({
          tool: "semver-check",
          kind: "release.no-changelog",
          severity: "P2",
          file: toPosix(relativePath),
          line: 0,
          evidence: `No CHANGELOG.md / CHANGES.md next to ${toPosix(relativePath)}`,
          rootCause:
            "A published package without a changelog leaves consumers guessing what changed between versions.",
          recommendedFix:
            "Add CHANGELOG.md (Keep-a-Changelog format) and wire it to release-please / changesets so version bumps and entries stay in sync.",
          confidence: 0.75,
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
