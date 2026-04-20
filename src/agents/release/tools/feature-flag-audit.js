// feature-flag-audit — find stale feature flags (#A19).
//
// Flag debt: a flag that's been "temporary" for six months is now load-
// bearing architecture. We walk the repo for `flag.isEnabled("foo")` /
// `useFlag("foo")` / `featureFlag("foo")` calls and flag flags that:
//   1. Have been referenced for a long time (file mtime > 90 days)
//   2. Have no corresponding cleanup date in a comment near the call site

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
]);

const FLAG_PATTERNS = [
  /flag(?:s)?\.isEnabled\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /useFlag\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /useFeatureFlag\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /launchdarkly\.variation\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /optimizely\.isFeatureEnabled\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /unleash\.isEnabled\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /growthbook\.isOn\s*\(\s*['"`]([^'"`]+)['"`]/g,
];

const STALE_DAYS = 90;

function hasCleanupAnnotation(contextLines) {
  return /remove[_-]?by|cleanup[_-]?by|expires?[_-]?on|retire[_-]?by/i.test(
    contextLines.join("\n")
  );
}

export async function runFeatureFlagAudit({
  rootPath,
  files = null,
  staleDays = STALE_DAYS,
} = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const now = Date.now();
  const staleThreshold = now - staleDays * 24 * 60 * 60 * 1000;
  const findings = [];

  for await (const { fullPath, relativePath, stat } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const mtime = stat ? Number(stat.mtimeMs || 0) : now;
    const isOld = mtime && mtime < staleThreshold;
    const lines = content.split(/\r?\n/);

    for (const pattern of FLAG_PATTERNS) {
      for (const match of findLineMatches(content, pattern)) {
        const flagName =
          match.match.match(/['"`]([^'"`]+)['"`]/)?.[1] || "<unknown>";
        const contextStart = Math.max(0, match.line - 3);
        const contextEnd = Math.min(lines.length, match.line + 2);
        const contextLines = lines.slice(contextStart, contextEnd);
        if (hasCleanupAnnotation(contextLines)) {
          continue;
        }
        if (!isOld) {
          continue;
        }
        const ageDays = Math.floor((now - mtime) / (24 * 60 * 60 * 1000));
        findings.push(
          createFinding({
            tool: "feature-flag-audit",
            kind: "release.stale-flag",
            severity: "P3",
            file: toPosix(relativePath),
            line: match.line,
            evidence: `${getLineContent(content, match.line)} (file unchanged ${ageDays} days)`,
            rootCause: `Flag '${flagName}' has been referenced for ≥ ${staleDays} days with no cleanup-by annotation.`,
            recommendedFix:
              "Add a `// cleanup-by: YYYY-MM-DD` comment near the call, or inline the chosen branch and delete the flag.",
            confidence: 0.45,
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
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    const fsp = await import("node:fs/promises");
    let stat = null;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      /* ignore */
    }
    yield { fullPath, relativePath, stat };
  }
}

export { STALE_DAYS };
