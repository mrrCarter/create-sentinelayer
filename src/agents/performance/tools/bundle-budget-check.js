// bundle-budget-check - flag heavy client imports and oversized assets (#A16).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, iterateFiles, toPosix } from "./base.js";

const CLIENT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".css",
]);
const FRONTEND_PATH_PATTERN =
  /(?:^|\/)(?:app|pages|components|ui|frontend|client|public)(?:\/|$)/i;
const LARGE_SOURCE_THRESHOLD_BYTES = 150 * 1024;
const LARGE_STYLE_THRESHOLD_BYTES = 100 * 1024;
const HEAVY_IMPORT_PATTERN =
  /\bimport\s+[^;]*?\bfrom\s+["'](?:moment|lodash|chart\.js(?:\/auto)?|monaco-editor|mapbox-gl|three)["']|require\s*\(\s*["'](?:moment|lodash|chart\.js(?:\/auto)?|monaco-editor|mapbox-gl|three)["']\s*\)/g;

function budgetForFile(relativePath) {
  return path.extname(relativePath).toLowerCase() === ".css"
    ? LARGE_STYLE_THRESHOLD_BYTES
    : LARGE_SOURCE_THRESHOLD_BYTES;
}

export async function runBundleBudgetCheck({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  for await (const { fullPath, relativePath, sizeBytes } of iterateFiles(
    resolvedRoot,
    files,
    CLIENT_EXTENSIONS
  )) {
    const normalizedPath = toPosix(relativePath);
    if (!FRONTEND_PATH_PATTERN.test(normalizedPath)) {
      continue;
    }
    let content = "";
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    const budget = budgetForFile(normalizedPath);
    if (sizeBytes > budget) {
      findings.push(
        createFinding({
          tool: "bundle-budget-check",
          kind: "performance.bundle-budget-exceeded",
          severity: "P2",
          file: normalizedPath,
          line: 1,
          evidence: `size=${sizeBytes} bytes budget=${budget} bytes`,
          rootCause:
            "Client-side source/style file exceeds the local budget, increasing parse, transfer, and hydration cost.",
          recommendedFix:
            "Split the module, lazy-load non-critical code, move static data out of the client bundle, or add an explicit budget exception.",
          confidence: 0.72,
        })
      );
    }

    for (const match of findLineMatches(content, HEAVY_IMPORT_PATTERN)) {
      findings.push(
        createFinding({
          tool: "bundle-budget-check",
          kind: "performance.heavy-client-import",
          severity: "P2",
          file: normalizedPath,
          line: match.line,
          evidence: getLineContent(content, match.line),
          rootCause:
            "Client code imports a known heavyweight package at module scope, which can inflate initial JavaScript payloads.",
          recommendedFix:
            "Use scoped imports, dynamic import(), route-level code splitting, or a lighter package.",
          confidence: 0.66,
        })
      );
    }
  }
  return findings;
}

export {
  FRONTEND_PATH_PATTERN,
  HEAVY_IMPORT_PATTERN,
  LARGE_SOURCE_THRESHOLD_BYTES,
  LARGE_STYLE_THRESHOLD_BYTES,
};
