import fs from "node:fs";
import path from "node:path";

const MAX_RESULTS = 200;
const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage",
  ".turbo", ".idea", ".vscode", "__pycache__", ".venv", ".cache",
  ".parcel-cache", ".svelte-kit", ".nuxt", ".output", ".vercel",
]);

/**
 * Fast file pattern matching sorted by modification time (newest first).
 *
 * @param {object} input
 * @param {string} input.pattern - Glob pattern (e.g., "**\/*.tsx", "src/**\/*.js").
 * @param {string} [input.path] - Directory to search (default: cwd).
 * @param {number} [input.limit] - Max results (default: 200).
 * @returns {{ filenames, numFiles, truncated, durationMs }}
 */
export function glob(input) {
  if (!input.pattern || typeof input.pattern !== "string") {
    throw new GlobError("pattern is required and must be a non-empty string.");
  }

  const searchPath = input.path ? path.resolve(input.path) : process.cwd();
  const limit = input.limit ?? MAX_RESULTS;
  const startMs = Date.now();

  if (!fs.existsSync(searchPath)) {
    throw new GlobError(`Directory not found: ${searchPath}`);
  }

  const stat = fs.statSync(searchPath);
  if (!stat.isDirectory()) {
    throw new GlobError(`Path is not a directory: ${searchPath}`);
  }

  const matcher = buildMatcher(input.pattern);
  const ignorePatterns = loadIgnorePatterns(searchPath);
  const results = [];

  walk(searchPath, searchPath, matcher, ignorePatterns, results, limit);

  // Sort by mtime descending (newest first)
  results.sort((a, b) => b.mtime - a.mtime);

  const truncated = results.length >= limit;
  const filenames = results.map((r) => r.relativePath);

  return {
    filenames,
    numFiles: filenames.length,
    truncated,
    durationMs: Date.now() - startMs,
  };
}

function walk(rootPath, currentPath, matcher, ignorePatterns, results, limit) {
  let entries;
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return; // skip unreadable directories
  }

  for (const entry of entries) {
    if (results.length >= limit) return;

    const name = entry.name;
    if (IGNORE_DIRS.has(name)) continue;

    const fullPath = path.join(currentPath, name);
    const relativePath = path.relative(rootPath, fullPath);

    if (ignorePatterns.some((p) => p(relativePath))) continue;

    if (entry.isDirectory()) {
      walk(rootPath, fullPath, matcher, ignorePatterns, results, limit);
    } else if (entry.isFile() && matcher(relativePath)) {
      let mtime = 0;
      try {
        mtime = fs.statSync(fullPath).mtimeMs;
      } catch { /* use 0 if stat fails */ }
      results.push({ relativePath, mtime });
    }
  }
}

/**
 * Build a filename matcher from a glob pattern.
 * Supports: *.ext, **\/*.ext, *.{ext1,ext2}, prefix*, *suffix
 */
function buildMatcher(pattern) {
  // Handle brace expansion: *.{ts,tsx} → ["*.ts", "*.tsx"]
  const expanded = expandBraces(pattern);

  const matchers = expanded.map((p) => {
    // ** recursive match
    if (p.includes("**/")) {
      const suffix = p.split("**/").pop();
      const suffixMatcher = buildSimpleMatcher(suffix);
      return (filepath) => {
        const basename = path.basename(filepath);
        const segments = filepath.split(path.sep);
        return segments.some((_, i) =>
          suffixMatcher(segments.slice(i).join(path.sep)),
        ) || suffixMatcher(basename);
      };
    }
    return buildSimpleMatcher(p);
  });

  return (filepath) => matchers.some((m) => m(filepath));
}

function buildSimpleMatcher(pattern) {
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return (filepath) => filepath.endsWith(ext) || path.basename(filepath).endsWith(ext);
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return (filepath) => filepath.startsWith(prefix) || path.basename(filepath).startsWith(prefix);
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return (filepath) => regex.test(filepath) || regex.test(path.basename(filepath));
  }
  return (filepath) => filepath === pattern || path.basename(filepath) === pattern;
}

function expandBraces(pattern) {
  const braceMatch = pattern.match(/\{([^}]+)\}/);
  if (!braceMatch) return [pattern];
  const alternatives = braceMatch[1].split(",");
  return alternatives.map((alt) =>
    pattern.replace(braceMatch[0], alt.trim()),
  );
}

function loadIgnorePatterns(rootPath) {
  const patterns = [];
  const gitignorePath = path.join(rootPath, ".gitignore");
  const slignorePath = path.join(rootPath, ".sentinelayerignore");

  for (const ignorePath of [gitignorePath, slignorePath]) {
    try {
      const content = fs.readFileSync(ignorePath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const matcher = buildSimpleMatcher(trimmed);
        patterns.push(matcher);
      }
    } catch { /* ignore missing files */ }
  }

  return patterns;
}

export class GlobError extends Error {
  constructor(message) {
    super(message);
    this.name = "GlobError";
  }
}
