// n-plus-one-detect - flag loop-scoped I/O and query calls (#A16).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, iterateFiles, toPosix } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
]);

const LOOP_IO_PATTERN =
  /(?:for\s*(?:await\s*)?\([^)]*\)|while\s*\([^)]*\)|\.forEach\s*\([^=]*=>)\s*\{?[\s\S]{0,650}?\b(?:await\s+)?(?:fetch|axios(?:\.[a-z]+)?|got(?:\.[a-z]+)?|requests\.(?:get|post)|httpx\.(?:get|post)|db\.\w+|prisma\.\w+|repository\.\w+|Model\.\w+|findAll|findMany|find_one|find_all|query|execute)\s*\(/gi;

export async function runNPlusOneDetect({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  for await (const { fullPath, relativePath } of iterateFiles(resolvedRoot, files, CODE_EXTENSIONS)) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const match of findLineMatches(content, LOOP_IO_PATTERN)) {
      findings.push(
        createFinding({
          tool: "n-plus-one-detect",
          kind: "performance.n-plus-one-loop",
          severity: "P1",
          file: toPosix(relativePath),
          line: match.line,
          evidence: getLineContent(content, match.line),
          rootCause:
            "Loop body performs a database, HTTP, or repository call. Runtime cost grows linearly with item count and can become an N+1 query or fan-out storm.",
          recommendedFix:
            "Batch the work outside the loop, prefetch related data, use `WHERE id IN (...)`, or add a bounded concurrency pool with request coalescing.",
          confidence: 0.68,
        })
      );
    }
  }
  return findings;
}

export { LOOP_IO_PATTERN };
