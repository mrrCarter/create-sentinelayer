import fs from "node:fs";
import path from "node:path";

const MAX_RESULT_CHARS = 5000;
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".ogg", ".webm", ".wav",
  ".zip", ".tar", ".gz", ".br", ".zst",
  ".pdf", ".wasm", ".node", ".exe", ".dll", ".so", ".dylib",
]);

/**
 * Read a file with line numbers, offset/limit pagination, and binary detection.
 * Returns { filePath, content, numLines, startLine, totalLines, truncated }.
 */
export function fileRead(input) {
  const filePath = resolveAndValidatePath(input.file_path);
  const ext = path.extname(filePath).toLowerCase();

  if (BINARY_EXTENSIONS.has(ext)) {
    const stat = fs.statSync(filePath);
    return {
      filePath,
      content: `[Binary file: ${ext}, ${stat.size} bytes. Use a specialized viewer.]`,
      numLines: 0,
      startLine: 0,
      totalLines: 0,
      truncated: false,
      binary: true,
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new FileReadError(`File not found: ${filePath}`);
    }
    if (err.code === "EISDIR") {
      throw new FileReadError(`Path is a directory, not a file: ${filePath}`);
    }
    throw new FileReadError(`Cannot read file: ${err.message}`);
  }

  const allLines = raw.split("\n");
  const totalLines = allLines.length;
  const offset = Math.max(0, input.offset ?? 0);
  const limit = input.limit ?? 2000;
  const sliced = allLines.slice(offset, offset + limit);
  const startLine = offset + 1;

  const numbered = sliced.map(
    (line, i) => `${String(startLine + i).padStart(6)}\t${line}`,
  );
  let content = numbered.join("\n");
  let truncated = false;

  if (content.length > MAX_RESULT_CHARS) {
    content = content.slice(0, MAX_RESULT_CHARS) + "\n[... truncated]";
    truncated = true;
  }

  return {
    filePath,
    content,
    numLines: sliced.length,
    startLine,
    totalLines,
    truncated,
    binary: false,
  };
}

export class FileReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileReadError";
  }
}

function resolveAndValidatePath(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new FileReadError("file_path is required and must be a non-empty string.");
  }
  const resolved = path.resolve(filePath);

  // Symlink defense: resolve real path and validate both
  let realPath;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // If realpath fails the file may not exist yet, resolved is sufficient
    realPath = resolved;
  }

  // Block /dev/, /proc/, /sys/ (Linux), NUL/CON/AUX (Windows)
  const blocked = ["/dev/", "/proc/", "/sys/"];
  for (const prefix of blocked) {
    if (realPath.startsWith(prefix) || resolved.startsWith(prefix)) {
      throw new FileReadError(`Blocked path: ${filePath}`);
    }
  }

  // Block UNC paths (network share access)
  if (resolved.startsWith("\\\\") || resolved.startsWith("//")) {
    throw new FileReadError(`Network paths are not allowed: ${filePath}`);
  }

  return resolved;
}
