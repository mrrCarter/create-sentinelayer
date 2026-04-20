// provenance-check — advise when AI-generated content lacks provenance signals (#A24).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"]);

const GENERATION_PATTERNS = [
  /\bgenerate(?:Content|Response|Completion|Text|Draft|Message)?\s*\(/,
  /\bcompose(?:Email|Message|Reply)\s*\(/,
  /\bllm[._](?:complete|generate)\s*\(/,
];

const PROVENANCE_SIGNALS = [
  /ai[_-]?generated|generated[_-]?by[_-]?ai/i,
  /provenance|attribution/i,
  /X-AI-Generated|x_ai_generated/,
  /watermark/i,
  /c2pa/i,
];

export async function runProvenanceCheck({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const matches = GENERATION_PATTERNS.flatMap((p) => findLineMatches(content, p));
    if (matches.length === 0) continue;
    const hasProvenance = PROVENANCE_SIGNALS.some((p) => p.test(content));
    if (hasProvenance) continue;
    const first = matches.sort((a, b) => a.line - b.line)[0];
    findings.push(
      createFinding({
        tool: "provenance-check",
        kind: "ai-governance.no-provenance",
        severity: "P2",
        file: toPosix(relativePath),
        line: first.line,
        evidence: getLineContent(content, first.line),
        rootCause: "AI-generated content shipped without provenance metadata (ai-generated header, attribution line, C2PA manifest). Downstream can't tell it from human output.",
        recommendedFix: "Tag generated content with an AI-generated marker (HTTP header, Markdown frontmatter, or C2PA manifest for images). Regulated domains (health, legal, elections) often require this by law.",
        confidence: 0.5,
      })
    );
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
