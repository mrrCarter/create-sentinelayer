// AST-based ingest drift detection (#A11, spec §5.7).
//
// The existing detectIngestDrift() compares file counts. That catches "files
// added or removed" but misses the worst case: a file whose exports changed
// signature under the same count (renamed function, param list tweaked,
// re-export path switched). Those are the edits that silently invalidate
// persona findings cached against the prior ingest.
//
// This module builds a per-file signature — exported names + import
// specifiers + exported function/class shape — and diffs two signatures
// cheaply. It leverages the existing @babel/parser pipeline from
// ast-parser-layer.js so we don't spawn Python for the JS/TS majority.

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parse } from "@babel/parser";
import ignore from "ignore";

const AST_DRIFT_SCHEMA_VERSION = "1.0.0";
const DEFAULT_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  ".next",
  "dist",
  "build",
  "coverage",
  ".sentinelayer",
  ".turbo",
  ".idea",
  ".vscode",
  "__pycache__",
  ".cache",
]);
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const DEFAULT_RENAMED_SIGNATURE_THRESHOLD = 3;
const DEFAULT_AST_SNAPSHOT_RELATIVE_PATH = ".sentinelayer/AST_SNAPSHOT.json";

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function pickBabelPlugins(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const plugins = ["importAttributes", "dynamicImport"];
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    plugins.push("typescript");
  }
  if (ext === ".jsx" || ext === ".tsx") {
    plugins.push("jsx");
  }
  return plugins;
}

async function readIgnorePatterns(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return String(raw || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function createIgnoreMatcher(rootPath) {
  const matcher = ignore();
  const gitignore = await readIgnorePatterns(path.join(rootPath, ".gitignore"));
  const sentinelignore = await readIgnorePatterns(
    path.join(rootPath, ".sentinelayerignore")
  );
  matcher.add([...gitignore, ...sentinelignore]);
  return (relativePath, isDirectory) => {
    const normalized = toPosix(relativePath);
    if (!normalized) {
      return false;
    }
    const candidate = isDirectory ? `${normalized}/` : normalized;
    return matcher.ignores(candidate);
  };
}

// Walk the repo, yield candidate JS/TS files within MAX_FILE_SIZE_BYTES.
async function* walkSourceFiles(rootPath) {
  const resolvedRoot = path.resolve(rootPath || process.cwd());
  const ignoreMatcher = await createIgnoreMatcher(resolvedRoot);
  const stack = [resolvedRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(resolvedRoot, fullPath));
      if (entry.isDirectory()) {
        if (!relativePath || DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (ignoreMatcher(relativePath, true)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (ignoreMatcher(relativePath, false)) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!DEFAULT_EXTENSIONS.has(ext)) {
        continue;
      }
      let stat = null;
      try {
        stat = await fsp.stat(fullPath);
      } catch {
        stat = null;
      }
      if (!stat || stat.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }
      yield { fullPath, relativePath };
    }
  }
}

// Extract a compact signature from an AST: exported names, imported modules,
// and per-export signatures (kind + param count). The signature is designed
// to be stable under cosmetic edits (whitespace, comments) and sensitive to
// structural ones (renames, kind changes, param list edits).
export function extractFileAstSignature(astRoot) {
  const exports = new Set();
  const imports = new Set();
  const signatures = {};

  const body = Array.isArray(astRoot?.program?.body) ? astRoot.program.body : [];
  for (const node of body) {
    if (!node || typeof node !== "object") {
      continue;
    }
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      node.source &&
      typeof node.source.value === "string"
    ) {
      if (node.type === "ImportDeclaration") {
        imports.add(node.source.value);
      } else {
        // Re-export: both contributes to imports (dependency) and exports
        // (re-exported names if any).
        imports.add(node.source.value);
      }
    }
    if (node.type === "ExportNamedDeclaration") {
      if (Array.isArray(node.specifiers)) {
        for (const specifier of node.specifiers) {
          const name =
            specifier?.exported?.name ||
            specifier?.exported?.value ||
            "";
          if (name) {
            exports.add(name);
            signatures[name] = signatures[name] || {
              kind: "reexport",
              paramCount: 0,
            };
          }
        }
      }
      if (node.declaration) {
        recordDeclarationExports(node.declaration, exports, signatures);
      }
    }
    if (node.type === "ExportDefaultDeclaration") {
      exports.add("default");
      signatures.default = extractDeclarationSignature(node.declaration);
    }
    if (node.type === "ExportAllDeclaration") {
      exports.add("*");
    }
  }

  return {
    exports: Array.from(exports).sort(),
    imports: Array.from(imports).sort(),
    signatures,
  };
}

function recordDeclarationExports(decl, exports, signatures) {
  if (!decl || typeof decl !== "object") {
    return;
  }
  if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
    const name = decl.id?.name || "";
    if (name) {
      exports.add(name);
      signatures[name] = extractDeclarationSignature(decl);
    }
    return;
  }
  if (decl.type === "VariableDeclaration" && Array.isArray(decl.declarations)) {
    for (const declarator of decl.declarations) {
      const name = declarator?.id?.name || "";
      if (!name) {
        continue;
      }
      exports.add(name);
      // Variable exports don't have a param count; record the init kind so
      // `export const foo = fn` and `export const foo = class`  can be told
      // apart from primitives.
      const initKind = declarator?.init?.type || "value";
      signatures[name] = { kind: `var:${initKind}`, paramCount: 0 };
    }
    return;
  }
  if (decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration") {
    const name = decl.id?.name || "";
    if (name) {
      exports.add(name);
      signatures[name] = { kind: decl.type, paramCount: 0 };
    }
  }
}

function extractDeclarationSignature(decl) {
  if (!decl || typeof decl !== "object") {
    return { kind: "unknown", paramCount: 0 };
  }
  if (decl.type === "FunctionDeclaration" || decl.type === "FunctionExpression") {
    return {
      kind: "function",
      paramCount: Array.isArray(decl.params) ? decl.params.length : 0,
    };
  }
  if (decl.type === "ArrowFunctionExpression") {
    return {
      kind: "arrow",
      paramCount: Array.isArray(decl.params) ? decl.params.length : 0,
    };
  }
  if (decl.type === "ClassDeclaration" || decl.type === "ClassExpression") {
    return { kind: "class", paramCount: 0 };
  }
  return { kind: decl.type || "unknown", paramCount: 0 };
}

async function signatureForFile(fullPath) {
  let content = "";
  try {
    content = await fsp.readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const ast = parse(content, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowAwaitOutsideFunction: true,
      plugins: pickBabelPlugins(fullPath),
    });
    return extractFileAstSignature(ast);
  } catch {
    return null;
  }
}

// Build a snapshot of every source file's AST signature. Returns a mapping
// from posix relative path → {exports, imports, signatures}.
export async function buildAstSnapshot({ rootPath = process.cwd() } = {}) {
  const files = {};
  let skipped = 0;
  for await (const { fullPath, relativePath } of walkSourceFiles(rootPath)) {
    const signature = await signatureForFile(fullPath);
    if (!signature) {
      skipped += 1;
      continue;
    }
    files[relativePath] = signature;
  }
  return {
    schemaVersion: AST_DRIFT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    files,
    skipped,
  };
}

// Compare two snapshots and produce a structured diff. Returns:
//   - addedFiles:         paths in current not in last
//   - removedFiles:       paths in last not in current
//   - newExports:         [{file, name}] export ids new in current
//   - newImports:         [{file, specifier}] import module ids new in current
//   - renamedSignatures:  [{file, name, before, after}] signature changed
//                         between snapshots for an export still present
export function astDiff(currentSnapshot, lastSnapshot) {
  const current =
    currentSnapshot && typeof currentSnapshot === "object"
      ? currentSnapshot.files || {}
      : {};
  const last =
    lastSnapshot && typeof lastSnapshot === "object"
      ? lastSnapshot.files || {}
      : {};

  const currentFiles = new Set(Object.keys(current));
  const lastFiles = new Set(Object.keys(last));

  const addedFiles = [...currentFiles].filter((f) => !lastFiles.has(f)).sort();
  const removedFiles = [...lastFiles].filter((f) => !currentFiles.has(f)).sort();

  const newExports = [];
  const newImports = [];
  const renamedSignatures = [];

  for (const file of currentFiles) {
    const curr = current[file] || {};
    const prev = last[file] || null;

    // For added files, every export / import counts as "new".
    const prevExports = new Set(Array.isArray(prev?.exports) ? prev.exports : []);
    const prevImports = new Set(Array.isArray(prev?.imports) ? prev.imports : []);

    for (const name of curr.exports || []) {
      if (!prevExports.has(name)) {
        newExports.push({ file, name });
      }
    }
    for (const specifier of curr.imports || []) {
      if (!prevImports.has(specifier)) {
        newImports.push({ file, specifier });
      }
    }

    // Signature changes: only meaningful when both sides know the name.
    const currSignatures = curr.signatures || {};
    const prevSignatures = prev?.signatures || {};
    for (const [name, nowSig] of Object.entries(currSignatures)) {
      if (!(name in prevSignatures)) {
        continue;
      }
      const before = prevSignatures[name];
      if (signaturesEqual(before, nowSig)) {
        continue;
      }
      renamedSignatures.push({ file, name, before, after: nowSig });
    }
  }

  return {
    addedFiles,
    removedFiles,
    newExports,
    newImports,
    renamedSignatures,
  };
}

function signaturesEqual(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    String(left.kind || "") === String(right.kind || "") &&
    Number(left.paramCount || 0) === Number(right.paramCount || 0)
  );
}

// Spec §5.7 detectIngestDrift — returns {driftDetected, reason} based on the
// AST diff. Threshold for signature renames is conservative (>3) so minor
// cleanups don't trigger a re-ingest.
export function detectAstDriftFromDiff(
  diff,
  { renamedSignatureThreshold = DEFAULT_RENAMED_SIGNATURE_THRESHOLD } = {}
) {
  const empty = !diff || typeof diff !== "object";
  if (empty) {
    return { driftDetected: false, reason: null };
  }
  const reason = {
    addedFiles: Array.isArray(diff.addedFiles) ? diff.addedFiles : [],
    removedFiles: Array.isArray(diff.removedFiles) ? diff.removedFiles : [],
    newExports: Array.isArray(diff.newExports) ? diff.newExports : [],
    newImports: Array.isArray(diff.newImports) ? diff.newImports : [],
    renamedSignatures: Array.isArray(diff.renamedSignatures)
      ? diff.renamedSignatures
      : [],
  };
  if (
    reason.newExports.length > 0 ||
    reason.newImports.length > 0 ||
    reason.removedFiles.length > 0 ||
    reason.renamedSignatures.length > renamedSignatureThreshold
  ) {
    return { driftDetected: true, reason };
  }
  return { driftDetected: false, reason };
}

// Orchestration helper: build the current AST snapshot, read the prior
// snapshot (if any), and produce the drift verdict.
export async function detectAstDrift({
  rootPath = process.cwd(),
  snapshotPath = "",
  renamedSignatureThreshold = DEFAULT_RENAMED_SIGNATURE_THRESHOLD,
} = {}) {
  const resolvedSnapshotPath = snapshotPath
    ? path.resolve(rootPath, snapshotPath)
    : path.join(rootPath, DEFAULT_AST_SNAPSHOT_RELATIVE_PATH);
  const lastSnapshot = await readSnapshot(resolvedSnapshotPath);
  const currentSnapshot = await buildAstSnapshot({ rootPath });
  if (!lastSnapshot) {
    return {
      driftDetected: true,
      reason: { missingSnapshot: true },
      currentSnapshot,
      lastSnapshot: null,
    };
  }
  const diff = astDiff(currentSnapshot, lastSnapshot);
  const verdict = detectAstDriftFromDiff(diff, { renamedSignatureThreshold });
  return {
    ...verdict,
    currentSnapshot,
    lastSnapshot,
    diff,
  };
}

export async function writeAstSnapshot({
  rootPath = process.cwd(),
  snapshotPath = "",
  snapshot,
} = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("snapshot is required.");
  }
  const resolvedSnapshotPath = snapshotPath
    ? path.resolve(rootPath, snapshotPath)
    : path.join(rootPath, DEFAULT_AST_SNAPSHOT_RELATIVE_PATH);
  await fsp.mkdir(path.dirname(resolvedSnapshotPath), { recursive: true });
  const tmpPath = `${resolvedSnapshotPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(
    tmpPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf-8"
  );
  await fsp.rename(tmpPath, resolvedSnapshotPath);
  return resolvedSnapshotPath;
}

async function readSnapshot(snapshotPath) {
  try {
    const raw = await fsp.readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export {
  AST_DRIFT_SCHEMA_VERSION,
  DEFAULT_AST_SNAPSHOT_RELATIVE_PATH,
  DEFAULT_RENAMED_SIGNATURE_THRESHOLD,
};
