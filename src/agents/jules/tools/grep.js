import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const DEFAULT_HEAD_LIMIT = 250;
const MAX_LINE_LENGTH = 500;
const VCS_EXCLUDE_DIRS = [
  ".git", ".svn", ".hg", "node_modules", ".next", "dist", "build",
  "coverage", ".turbo", ".idea", ".vscode", "__pycache__", ".venv",
];

/**
 * Search file contents using ripgrep.
 * Falls back to a naive line-by-line search if rg is not installed.
 *
 * @param {object} input
 * @param {string} input.pattern - Regex pattern to search for.
 * @param {string} [input.path] - Directory to search (default: cwd).
 * @param {string} [input.glob] - Glob filter (e.g., "*.tsx").
 * @param {string} [input.output_mode] - "content" | "files_with_matches" | "count"
 * @param {number} [input.context] - Lines of context before and after match.
 * @param {boolean} [input.case_insensitive] - Case-insensitive search.
 * @param {number} [input.head_limit] - Max results (default 250).
 * @param {boolean} [input.multiline] - Enable multiline matching.
 * @returns {{ mode, numFiles, filenames, content, numMatches, appliedLimit }}
 */
export function grep(input) {
  if (!input.pattern || typeof input.pattern !== "string") {
    throw new GrepError("pattern is required and must be a non-empty string.");
  }

  const searchPath = input.path ? path.resolve(input.path) : process.cwd();
  const outputMode = input.output_mode || "files_with_matches";
  const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT;

  const args = buildRgArgs(input, searchPath, outputMode);

  let stdout;
  try {
    stdout = execFileSync("rg", args, {
      cwd: searchPath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (err) {
    // rg exits with code 1 when no matches found — that's normal
    if (err.status === 1) {
      return {
        mode: outputMode,
        numFiles: 0,
        filenames: [],
        content: "",
        numMatches: 0,
        appliedLimit: headLimit,
      };
    }
    // rg not installed — fall back to naive search
    if (err.code === "ENOENT") {
      return naiveFallbackGrep(input, searchPath, outputMode, headLimit);
    }
    throw new GrepError(`ripgrep failed: ${err.message}`);
  }

  return parseRgOutput(stdout, outputMode, headLimit);
}

function buildRgArgs(input, searchPath, outputMode) {
  const args = ["--no-heading", "--color", "never"];

  // Output mode flags
  if (outputMode === "files_with_matches") {
    args.push("-l");
  } else if (outputMode === "count") {
    args.push("-c");
  } else {
    args.push("-n"); // line numbers for content mode
  }

  // Context
  if (input.context && outputMode === "content") {
    args.push("-C", String(input.context));
  }

  // Case insensitive
  if (input.case_insensitive) {
    args.push("-i");
  }

  // Multiline
  if (input.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  // Glob filter
  if (input.glob) {
    args.push("--glob", input.glob);
  }

  // Exclude VCS and build directories
  for (const dir of VCS_EXCLUDE_DIRS) {
    args.push("--glob", `!${dir}`);
  }

  // Max line length to prevent base64/minified content noise
  args.push("--max-columns", String(MAX_LINE_LENGTH));
  args.push("--max-columns-preview");

  args.push("--", input.pattern, searchPath);
  return args;
}

function parseRgOutput(stdout, outputMode, headLimit) {
  const lines = stdout.split("\n").filter(Boolean);
  const limited = headLimit > 0 ? lines.slice(0, headLimit) : lines;

  if (outputMode === "files_with_matches") {
    return {
      mode: outputMode,
      numFiles: limited.length,
      filenames: limited,
      content: "",
      numMatches: limited.length,
      appliedLimit: headLimit,
    };
  }

  if (outputMode === "count") {
    let totalMatches = 0;
    const filenames = [];
    for (const line of limited) {
      const colonIdx = line.lastIndexOf(":");
      if (colonIdx > 0) {
        filenames.push(line.slice(0, colonIdx));
        totalMatches += parseInt(line.slice(colonIdx + 1), 10) || 0;
      }
    }
    return {
      mode: outputMode,
      numFiles: filenames.length,
      filenames,
      content: limited.join("\n"),
      numMatches: totalMatches,
      appliedLimit: headLimit,
    };
  }

  // Content mode
  const fileSet = new Set();
  for (const line of limited) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      fileSet.add(line.slice(0, colonIdx));
    }
  }
  return {
    mode: outputMode,
    numFiles: fileSet.size,
    filenames: [...fileSet],
    content: limited.join("\n"),
    numMatches: limited.length,
    appliedLimit: headLimit,
  };
}

/**
 * Naive line-by-line fallback when ripgrep is not installed.
 * Significantly slower but functional.
 */
function naiveFallbackGrep(input, searchPath, outputMode, headLimit) {
  const { readdirSync, readFileSync, statSync } = fs;
  const regex = new RegExp(input.pattern, input.case_insensitive ? "gi" : "g");
  const globPattern = input.glob;
  const results = [];
  const filenames = new Set();

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (VCS_EXCLUDE_DIRS.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (globPattern && !matchGlob(entry.name, globPattern)) continue;
        try {
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              filenames.add(fullPath);
              results.push(`${fullPath}:${i + 1}:${lines[i].slice(0, MAX_LINE_LENGTH)}`);
              if (headLimit > 0 && results.length >= headLimit) return;
            }
            regex.lastIndex = 0;
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(searchPath);

  return {
    mode: outputMode,
    numFiles: filenames.size,
    filenames: [...filenames],
    content: outputMode === "content" ? results.join("\n") : "",
    numMatches: results.length,
    appliedLimit: headLimit,
    fallback: true,
  };
}

function matchGlob(filename, glob) {
  // Simple extension glob matching (e.g., "*.tsx", "*.{ts,tsx}")
  if (glob.startsWith("*.")) {
    const exts = glob.slice(1).replace(/[{}]/g, "").split(",");
    return exts.some((ext) => filename.endsWith(ext));
  }
  return true;
}

export class GrepError extends Error {
  constructor(message) {
    super(message);
    this.name = "GrepError";
  }
}
