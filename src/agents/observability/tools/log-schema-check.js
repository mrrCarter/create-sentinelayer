// log-schema-check — flag console.log in production code paths (#A20).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"]);

function isProductionSource(relPath) {
  const p = toPosix(relPath);
  if (/(^|\/)(tests?|__tests__|specs?)\//.test(p)) return false;
  if (/\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|py)$/.test(p)) return false;
  if (/(^|\/)scripts\//.test(p)) return false;
  if (/(^|\/)bin\//.test(p)) return false;
  if (/(^|\/)docs?\//.test(p)) return false;
  return true;
}

const UNSTRUCTURED_LOG_PATTERNS_JS = /\bconsole\.(log|info|warn|error|debug)\s*\(/;
const UNSTRUCTURED_LOG_PATTERNS_PY = /\bprint\s*\(/;

export async function runLogSchemaCheck({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  const reported = new Set();
  for await (const { fullPath, relativePath } of iterator) {
    if (!isProductionSource(relativePath)) continue;
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const pattern = ext === ".py" ? UNSTRUCTURED_LOG_PATTERNS_PY : UNSTRUCTURED_LOG_PATTERNS_JS;
    const matches = findLineMatches(content, pattern);
    if (matches.length === 0) continue;
    const rel = toPosix(relativePath);
    if (reported.has(rel)) continue;
    reported.add(rel);
    findings.push(
      createFinding({
        tool: "log-schema-check",
        kind: "observability.unstructured-log",
        severity: "P3",
        file: rel,
        line: matches[0].line,
        evidence: getLineContent(content, matches[0].line),
        rootCause: "Production code uses console.log / print() — unindexed output that can't be queried, correlated, or redacted at collection time.",
        recommendedFix: "Route through a structured logger (pino, winston, structlog) with a shared schema. Configure PII fields to be automatically redacted.",
        confidence: 0.55,
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

export { isProductionSource };
