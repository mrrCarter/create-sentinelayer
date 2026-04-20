// prompt-drift — advise when prompt files aren't versioned (#A24).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

export async function runPromptDrift({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  for await (const { fullPath, relativePath } of walkRepoFiles({
    rootPath: resolvedRoot,
  })) {
    const rel = toPosix(relativePath);
    if (!/(^|\/)(prompts?|ai|llm)\//i.test(rel)) continue;
    if (!/\.(md|txt|ya?ml|json|prompt)$/i.test(rel)) continue;
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const hasVersion = /version\s*[:=]\s*['"]?v?\d+\.\d+/i.test(content) ||
      /---[\s\S]*?version:[\s\S]*?---/.test(content);
    if (!hasVersion) {
      findings.push(
        createFinding({
          tool: "prompt-drift",
          kind: "ai-governance.unversioned-prompt",
          severity: "P2",
          file: rel,
          line: 0,
          evidence: "No version header in prompt file",
          rootCause: "Prompts without explicit versions make it impossible to roll back behavior changes or compare eval runs across versions.",
          recommendedFix: "Add a `version: 1.2.0` frontmatter header. Bump on every edit. Pair with eval-regression runs keyed on version.",
          confidence: 0.55,
        })
      );
    }
  }
  return findings;
}
