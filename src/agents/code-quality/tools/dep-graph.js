// dep-graph — extract a module-level import graph from JS/TS sources (#A16).
//
// We use @babel/parser (already a dep) to collect every ImportDeclaration /
// dynamic import / require call per file. Local imports (starting with
// '.' or the repo's src root) are resolved against the filesystem so we
// get a directed graph with fully-qualified node keys. External packages
// are kept under a synthetic 'npm:<pkg>' / 'npm:@scope/pkg' key so the
// graph isn't polluted by node_modules paths but still captures the fan-out.

import fsp from "node:fs/promises";
import path from "node:path";

import { parse } from "@babel/parser";

import { toPosix, walkRepoFiles } from "./base.js";

const DEFAULT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

function pickBabelPlugins(filePath) {
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

function collectSpecifiers(astRoot) {
  const specifiers = new Set();
  const queue = [astRoot];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      for (const value of node) {
        queue.push(value);
      }
      continue;
    }
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      node.source &&
      typeof node.source.value === "string"
    ) {
      specifiers.add(node.source.value);
    }
    if (
      node.type === "CallExpression" &&
      node.callee &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      Array.isArray(node.arguments) &&
      node.arguments[0]?.type === "StringLiteral"
    ) {
      specifiers.add(node.arguments[0].value);
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Import" &&
      Array.isArray(node.arguments) &&
      node.arguments[0]?.type === "StringLiteral"
    ) {
      specifiers.add(node.arguments[0].value);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return Array.from(specifiers);
}

function normalizeImportSpec(spec, sourceRelativePath) {
  const raw = String(spec || "").trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith(".")) {
    const sourceDir = path.posix.dirname(sourceRelativePath);
    const resolved = path.posix.normalize(`${sourceDir}/${raw}`);
    return { kind: "local", key: resolved };
  }
  if (raw.startsWith("/")) {
    return { kind: "absolute", key: raw };
  }
  const parts = raw.split("/");
  if (parts[0].startsWith("@") && parts.length > 1) {
    return { kind: "npm", key: `npm:${parts[0]}/${parts[1]}` };
  }
  return { kind: "npm", key: `npm:${parts[0]}` };
}

export async function buildDependencyGraph({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: DEFAULT_EXTENSIONS });

  const graph = {};
  for await (const { fullPath, relativePath } of iterator) {
    const relPos = toPosix(relativePath);
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
        plugins: pickBabelPlugins(fullPath),
      });
    } catch {
      continue;
    }
    const specifiers = collectSpecifiers(ast);
    const edges = new Set();
    for (const spec of specifiers) {
      const normalized = normalizeImportSpec(spec, relPos);
      if (!normalized) {
        continue;
      }
      edges.add(normalized.key);
    }
    graph[relPos] = Array.from(edges).sort();
  }
  return graph;
}

// Thin wrapper so the tool conforms to the persona-tool contract (returns
// Finding[]). The graph itself is returned on the single "report" finding's
// rootCause payload — the LLM layer can reach in for detail.
export async function runDepGraph({ rootPath, files = null } = {}) {
  const graph = await buildDependencyGraph({ rootPath, files });
  const moduleCount = Object.keys(graph).length;
  const edgeCount = Object.values(graph).reduce(
    (acc, list) => acc + list.length,
    0
  );
  const densestFile = Object.entries(graph).reduce(
    (acc, [file, edges]) => (edges.length > acc.edges ? { file, edges: edges.length } : acc),
    { file: "", edges: 0 }
  );
  return [
    {
      persona: "code-quality",
      tool: "dep-graph",
      kind: "code-quality.dep-graph-report",
      severity: "P3",
      file: densestFile.file || "",
      line: 0,
      evidence: `modules=${moduleCount}, edges=${edgeCount}, densest=${densestFile.file || "n/a"} (${densestFile.edges} imports)`,
      rootCause: "Module-level dependency graph summary",
      recommendedFix:
        "Inspect the densest modules first. Consider splitting or introducing an indirection layer if fan-out is > 20.",
      confidence: 0.9,
      graph,
    },
  ];
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

export { collectSpecifiers, normalizeImportSpec };
