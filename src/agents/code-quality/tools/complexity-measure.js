// complexity-measure — simple cyclomatic complexity estimate per function (#A16).
//
// We don't try to be ESLint-strict — we estimate cyclomatic complexity by
// counting branching keywords within each function body. It's an
// approximation (it doesn't handle labeled break / conditional short-circuit
// perfectly) but it's enough to surface the worst offenders.
//
// Threshold defaults: P1 at CC >= 30, P2 at CC >= 15. Tune via options.

import fsp from "node:fs/promises";
import path from "node:path";

import { parse } from "@babel/parser";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const DEFAULT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

const BRANCHING_NODE_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchCase",
  "CatchClause",
  "ConditionalExpression",
  "LogicalExpression", // &&, ||, ??
]);

function pickPlugins(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const plugins = ["importAttributes", "dynamicImport"];
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    plugins.push("typescript");
  }
  if (ext === ".jsx" || ext === ".tsx") {
    plugins.push("jsx");
  }
  return plugins;
}

function estimateComplexity(bodyNode) {
  if (!bodyNode || typeof bodyNode !== "object") {
    return 1;
  }
  let count = 1; // Minimum CC = 1 (straight-line function)
  const queue = [bodyNode];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (BRANCHING_NODE_TYPES.has(node.type)) {
      count += 1;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        if (Array.isArray(value)) {
          queue.push(...value);
        } else {
          queue.push(value);
        }
      }
    }
  }
  return count;
}

function functionName(node) {
  if (!node) {
    return "<anonymous>";
  }
  if (node.id?.name) {
    return node.id.name;
  }
  return "<anonymous>";
}

function collectFunctions(astRoot, filePath) {
  const results = [];
  const queue = [astRoot];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      for (const v of node) {
        queue.push(v);
      }
      continue;
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassMethod" ||
      node.type === "ObjectMethod"
    ) {
      results.push({
        name: functionName(node),
        line: node.loc?.start?.line ?? 0,
        complexity: estimateComplexity(node.body),
        file: filePath,
      });
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return results;
}

export async function runComplexityMeasure({
  rootPath,
  files = null,
  p1Threshold = 30,
  p2Threshold = 15,
} = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: DEFAULT_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
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
        plugins: pickPlugins(fullPath),
      });
    } catch {
      continue;
    }
    const functions = collectFunctions(ast, toPosix(relativePath));
    for (const fn of functions) {
      if (fn.complexity < p2Threshold) {
        continue;
      }
      const severity = fn.complexity >= p1Threshold ? "P1" : "P2";
      findings.push(
        createFinding({
          tool: "complexity-measure",
          kind: "code-quality.high-complexity",
          severity,
          file: fn.file,
          line: fn.line,
          evidence: `function '${fn.name}' has estimated CC=${fn.complexity}`,
          rootCause:
            "High cyclomatic complexity means many independent paths through the function — hard to test exhaustively and easy to break on edits.",
          recommendedFix:
            "Split on the dominant branch axis (early-return guards, extract-method on nested conditionals, or convert a long switch into a dispatch table).",
          confidence: 0.7,
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

export { BRANCHING_NODE_TYPES, estimateComplexity };
