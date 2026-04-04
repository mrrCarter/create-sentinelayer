import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PathGuardError, resolveGuardedPath } from "./path-guards.js";

/**
 * String replacement in files with uniqueness enforcement and diff generation.
 * Designed for use inside a worktree — validates path is within allowed directory.
 *
 * @param {object} input
 * @param {string} input.file_path - Absolute path to the file to modify.
 * @param {string} input.old_string - Exact text to replace.
 * @param {string} input.new_string - Replacement text (must differ from old_string).
 * @param {boolean} [input.replace_all] - Replace all occurrences (default: false).
 * @param {string} [input.allowed_root] - Root directory edits are permitted in (worktree guard).
 * @returns {{ filePath, diff, occurrencesFound, occurrencesReplaced, linesChanged }}
 */
export function fileEdit(input) {
  if (!input.old_string && input.old_string !== "") {
    throw new FileEditError("old_string is required.");
  }
  if (input.new_string === undefined || input.new_string === null) {
    throw new FileEditError("new_string is required.");
  }
  if (input.old_string === input.new_string) {
    throw new FileEditError("old_string and new_string must be different.");
  }

  let filePath;
  try {
    const guarded = resolveGuardedPath({
      filePath: input.file_path,
      allowedRoot: input.allowed_root || undefined,
    });
    filePath = guarded.resolvedPath;
  } catch (error) {
    if (error instanceof PathGuardError) {
      throw new FileEditError(error.message);
    }
    if (error instanceof FileEditError) {
      throw error;
    }
    throw new FileEditError(`Cannot access path: ${error.message}`);
  }

  // Read current content
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new FileEditError(`File not found: ${filePath}`);
    }
    throw new FileEditError(`Cannot read file: ${err.message}`);
  }

  // Count occurrences
  const occurrences = countOccurrences(content, input.old_string);
  if (occurrences === 0) {
    throw new FileEditError(
      `old_string not found in ${filePath}. Verify the exact text including whitespace and indentation.`,
    );
  }
  if (occurrences > 1 && !input.replace_all) {
    throw new FileEditError(
      `old_string found ${occurrences} times in ${filePath}. Use replace_all: true to replace all, or provide more surrounding context to make it unique.`,
    );
  }

  // Perform replacement
  const replaceCount = input.replace_all ? occurrences : 1;
  let newContent = content;
  if (input.replace_all) {
    newContent = content.split(input.old_string).join(input.new_string);
  } else {
    const idx = content.indexOf(input.old_string);
    newContent =
      content.slice(0, idx) +
      input.new_string +
      content.slice(idx + input.old_string.length);
  }

  // Generate unified diff for display
  const diff = generateUnifiedDiff(filePath, content, newContent);

  // Count changed lines
  const oldLines = content.split("\n").length;
  const newLines = newContent.split("\n").length;
  const linesChanged = Math.abs(newLines - oldLines) +
    countDiffLines(content, newContent);

  // Write atomically: temp file + rename
  const tmpPath = filePath + `.sl-edit-${Date.now()}`;
  fs.writeFileSync(tmpPath, newContent, "utf-8");
  fs.renameSync(tmpPath, filePath);

  return {
    filePath,
    diff,
    occurrencesFound: occurrences,
    occurrencesReplaced: replaceCount,
    linesChanged,
    beforeHash: hashContent(content),
    afterHash: hashContent(newContent),
  };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function generateUnifiedDiff(filePath, oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diffLines = [];

  diffLines.push(`--- a/${path.basename(filePath)}`);
  diffLines.push(`+++ b/${path.basename(filePath)}`);

  // Simple line-by-line diff (not full Myers — sufficient for review display)
  const maxLines = Math.max(oldLines.length, newLines.length);
  let chunkStart = -1;
  let chunkOld = [];
  let chunkNew = [];

  for (let i = 0; i < maxLines; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine !== newLine) {
      if (chunkStart === -1) chunkStart = i;
      if (oldLine !== undefined) chunkOld.push(`-${oldLine}`);
      if (newLine !== undefined) chunkNew.push(`+${newLine}`);
    } else if (chunkStart !== -1) {
      // Flush chunk
      diffLines.push(`@@ -${chunkStart + 1},${chunkOld.length} +${chunkStart + 1},${chunkNew.length} @@`);
      diffLines.push(...chunkOld, ...chunkNew);
      chunkStart = -1;
      chunkOld = [];
      chunkNew = [];
    }
  }

  // Flush final chunk
  if (chunkStart !== -1) {
    diffLines.push(`@@ -${chunkStart + 1},${chunkOld.length} +${chunkStart + 1},${chunkNew.length} @@`);
    diffLines.push(...chunkOld, ...chunkNew);
  }

  return diffLines.join("\n");
}

function countDiffLines(oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let changed = 0;
  const max = Math.min(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) changed++;
  }
  return changed;
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export class FileEditError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileEditError";
  }
}
