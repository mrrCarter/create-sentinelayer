// dead-link-check — find markdown relative links that point at non-existent files (#A23).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const LINK_REGEX = /\[[^\]]*\]\(([^)\s]+)\)/g;

export async function runDeadLinkCheck({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  for await (const { fullPath, relativePath } of walkRepoFiles({
    rootPath: resolvedRoot,
    extensions: new Set([".md"]),
  })) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const rel = toPosix(relativePath);
    const dir = path.posix.dirname(rel);
    let m;
    while ((m = LINK_REGEX.exec(content)) !== null) {
      const target = m[1].split("#")[0];
      if (!target || /^https?:/i.test(target) || target.startsWith("mailto:")) continue;
      const normalizedTarget = target.replace(/\?.*$/, "");
      const resolvedTarget = path.posix.normalize(`${dir}/${normalizedTarget}`);
      const absolute = path.join(resolvedRoot, resolvedTarget);
      let exists = false;
      try {
        await fsp.stat(absolute);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) {
        const lineIndex = content.slice(0, m.index).split(/\r?\n/).length;
        findings.push(
          createFinding({
            tool: "dead-link-check",
            kind: "documentation.dead-link",
            severity: "P3",
            file: rel,
            line: lineIndex,
            evidence: `${m[0]} → ${resolvedTarget} does not exist`,
            rootCause: "Broken markdown link — readers follow it to a 404 and lose trust in the docs.",
            recommendedFix: "Update the link to the new path, or delete the reference if the target was intentionally removed.",
            confidence: 0.85,
          })
        );
      }
    }
  }
  return findings;
}
