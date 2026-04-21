// Shared helpers for Nina's (security) domain tools (#A13).
//
// Every security tool returns the same Finding shape so the orchestrator can
// bin / merge results without case analysis. We also centralize the file
// walker and scope filter here so no tool re-invents the ignore logic.

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import ignore from "ignore";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  ".next",
  "dist",
  "build",
  "coverage",
  ".sentinelayer",
  ".sentinel",
  ".turbo",
  ".idea",
  ".vscode",
  "__pycache__",
  ".cache",
]);
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);

export function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

export function normalizeSeverity(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (SEVERITIES.includes(normalized)) {
    return normalized;
  }
  return "P2";
}

// Canonical Finding shape — every security tool returns objects matching
// this schema.
export function createFinding({
  severity,
  kind,
  file,
  line = 0,
  evidence = "",
  rootCause = "",
  recommendedFix = "",
  confidence = null,
  tool = "",
  persona = "security",
} = {}) {
  return {
    persona,
    tool: String(tool || "").trim(),
    kind: String(kind || "").trim() || "security",
    severity: normalizeSeverity(severity),
    file: toPosix(file || ""),
    line: Number.isFinite(Number(line)) ? Math.max(0, Math.floor(Number(line))) : 0,
    evidence: String(evidence || "").trim().slice(0, 400),
    rootCause: String(rootCause || "").trim(),
    recommendedFix: String(recommendedFix || "").trim(),
    confidence:
      confidence === null || confidence === undefined
        ? null
        : Math.max(0, Math.min(1, Number(confidence) || 0)),
  };
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
  const sentinel = await readIgnorePatterns(
    path.join(rootPath, ".sentinelayerignore")
  );
  matcher.add([...gitignore, ...sentinel]);
  return (relativePath, isDirectory) => {
    const normalized = toPosix(relativePath);
    if (!normalized) {
      return false;
    }
    const candidate = isDirectory ? `${normalized}/` : normalized;
    return matcher.ignores(candidate);
  };
}

// Walk the target repo, yielding files whose extension is in `extensions`
// (or all files when `extensions` is empty). Respects .gitignore +
// .sentinelayerignore + DEFAULT_IGNORED_DIRS.
export async function* walkRepoFiles({
  rootPath = process.cwd(),
  extensions = new Set(),
  maxFileSize = MAX_FILE_SIZE_BYTES,
} = {}) {
  const resolvedRoot = path.resolve(rootPath);
  const ignoreMatcher = await createIgnoreMatcher(resolvedRoot);
  const wantedExtensions =
    extensions instanceof Set
      ? extensions
      : new Set(Array.isArray(extensions) ? extensions : []);
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
      if (wantedExtensions.size > 0 && !wantedExtensions.has(ext) && !wantedExtensions.has("")) {
        continue;
      }
      let stat = null;
      try {
        stat = await fsp.stat(fullPath);
      } catch {
        stat = null;
      }
      if (!stat || stat.size > maxFileSize) {
        continue;
      }
      yield { fullPath, relativePath };
    }
  }
}

// Find line number of the first occurrence of a pattern in `content`.
// Returns 0 when not found.
export function lineNumberOf(content, pattern) {
  const text = String(content || "");
  if (!pattern) {
    return 0;
  }
  const idx = text.search(pattern);
  if (idx < 0) {
    return 0;
  }
  const before = text.slice(0, idx);
  return before.split(/\r?\n/).length;
}

// Capture one matching line (trimmed) for evidence.
export function evidenceAroundMatch(content, line) {
  const lines = String(content || "").split(/\r?\n/);
  const idx = Math.max(0, (Number(line) || 1) - 1);
  return (lines[idx] || "").trim();
}

export { DEFAULT_IGNORED_DIRS, MAX_FILE_SIZE_BYTES, SEVERITIES };
