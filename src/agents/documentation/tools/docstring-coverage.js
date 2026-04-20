// docstring-coverage — find exported functions without a preceding comment (#A23).

import fsp from "node:fs/promises";
import path from "node:path";

import { parse } from "@babel/parser";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

function hasLeadingComment(node) {
  return Array.isArray(node.leadingComments) && node.leadingComments.length > 0;
}

export async function runDocstringCoverage({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: JS_EXTS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    const rel = toPosix(relativePath);
    if (/(^|\/)(tests?|__tests__|specs?)\//.test(rel)) continue;
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    let ast;
    try {
      ast = parse(content, {
        sourceType: "unambiguous",
        errorRecovery: true,
        plugins:
          rel.endsWith(".ts") || rel.endsWith(".tsx") ? ["typescript", "jsx"] : ["jsx"],
      });
    } catch {
      continue;
    }
    for (const stmt of ast.program.body) {
      if (
        stmt.type === "ExportNamedDeclaration" &&
        stmt.declaration?.type === "FunctionDeclaration"
      ) {
        const fn = stmt.declaration;
        if (hasLeadingComment(stmt) || hasLeadingComment(fn)) continue;
        findings.push(
          createFinding({
            tool: "docstring-coverage",
            kind: "documentation.undocumented-export",
            severity: "P3",
            file: rel,
            line: fn.loc?.start?.line || 0,
            evidence: `export function ${fn.id?.name || "<anonymous>"} has no leading comment`,
            rootCause: "Public exports ship without explanation. Consumers reverse-engineer expected behavior from implementation.",
            recommendedFix: "Add a JSDoc block describing parameters, return value, and any non-obvious preconditions.",
            confidence: 0.4,
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
    if (!trimmed) continue;
    const fullPath = path.isAbsolute(trimmed) ? trimmed : path.join(resolvedRoot, trimmed);
    const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}
