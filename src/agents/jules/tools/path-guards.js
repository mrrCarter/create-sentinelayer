import fs from "node:fs";
import path from "node:path";

const POSIX_BLOCKED_PREFIXES = ["/dev", "/proc", "/sys"];
const WINDOWS_DEVICE_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_DEVICE_NAMESPACE_PATTERN = /^\\\\[?.]\\.+/;
const WINDOWS_UNC_PATTERN = /^\\\\(?![?.]\\)/;
const POSIX_UNC_PATTERN = /^\/\/[^/]/;

/**
 * Resolve a user-provided file path and enforce sandbox-style guardrails.
 * Returns the resolved path and realpath so callers can safely read/write.
 */
export function resolveGuardedPath({ filePath, allowedRoot }) {
  const rawFilePath = normalizeInputPath(filePath);
  assertPathNotNetwork(rawFilePath);
  assertPathNotDeviceNamespace(rawFilePath);

  const resolvedPath = path.resolve(rawFilePath);
  const realPath = resolveRealPathOrFallback(resolvedPath);

  assertPathNotNetwork(resolvedPath);
  assertPathNotNetwork(realPath);
  assertPathNotDeviceNamespace(resolvedPath);
  assertPathNotDeviceNamespace(realPath);
  assertPathNotBlockedPosixSystemPath(resolvedPath);
  assertPathNotBlockedPosixSystemPath(realPath);
  assertPathNotWindowsDeviceSegment(resolvedPath);
  assertPathNotWindowsDeviceSegment(realPath);

  if (allowedRoot !== undefined && allowedRoot !== null && String(allowedRoot).trim()) {
    const resolvedAllowedRoot = path.resolve(String(allowedRoot));
    const allowedRootRealPath = resolveRealPathOrFallback(resolvedAllowedRoot);
    assertPathWithinAllowedRoot(resolvedPath, resolvedAllowedRoot);
    assertPathWithinAllowedRoot(realPath, allowedRootRealPath);
  }

  return {
    resolvedPath,
    realPath,
  };
}

function normalizeInputPath(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new PathGuardError(
      "PATH_INVALID",
      "file_path is required and must be a non-empty string.",
    );
  }

  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new PathGuardError(
      "PATH_INVALID",
      "file_path is required and must be a non-empty string.",
    );
  }
  return trimmed;
}

function resolveRealPathOrFallback(candidatePath) {
  try {
    if (typeof fs.realpathSync.native === "function") {
      return fs.realpathSync.native(candidatePath);
    }
    return fs.realpathSync(candidatePath);
  } catch {
    return candidatePath;
  }
}

function assertPathNotNetwork(candidatePath) {
  const normalized = String(candidatePath || "");
  if (WINDOWS_UNC_PATTERN.test(normalized) || POSIX_UNC_PATTERN.test(normalized)) {
    throw new PathGuardError(
      "PATH_UNC_BLOCKED",
      `Network paths are not allowed: ${candidatePath}`,
    );
  }
}

function assertPathNotDeviceNamespace(candidatePath) {
  const normalized = String(candidatePath || "");
  if (WINDOWS_DEVICE_NAMESPACE_PATTERN.test(normalized)) {
    throw new PathGuardError(
      "PATH_DEVICE_NAMESPACE_BLOCKED",
      `Device namespace paths are not allowed: ${candidatePath}`,
    );
  }
}

function assertPathNotBlockedPosixSystemPath(candidatePath) {
  const normalized = String(candidatePath || "").replace(/\\/g, "/");
  for (const prefix of POSIX_BLOCKED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      throw new PathGuardError(
        "PATH_SYSTEM_BLOCKED",
        `Blocked system path: ${candidatePath}`,
      );
    }
  }
}

function assertPathNotWindowsDeviceSegment(candidatePath) {
  if (process.platform !== "win32") {
    return;
  }

  const normalized = String(candidatePath || "").replace(/\//g, "\\");
  const segments = normalized.split("\\").filter(Boolean);
  for (const segment of segments) {
    if (/^[a-z]:$/i.test(segment)) {
      continue;
    }
    if (WINDOWS_DEVICE_SEGMENT.test(segment)) {
      throw new PathGuardError(
        "PATH_WINDOWS_DEVICE_BLOCKED",
        `Blocked device path segment: ${candidatePath}`,
      );
    }
  }
}

function assertPathWithinAllowedRoot(candidatePath, allowedRoot) {
  if (isPathInsideRoot(candidatePath, allowedRoot)) {
    return;
  }
  throw new PathGuardError(
    "PATH_OUTSIDE_ALLOWED_ROOT",
    `Path escapes allowed root: ${candidatePath} (root: ${allowedRoot})`,
  );
}

function isPathInsideRoot(candidatePath, rootPath) {
  const normalizedCandidate = normalizeForComparison(candidatePath);
  const normalizedRoot = normalizeForComparison(rootPath);
  const relative = path.relative(normalizedRoot, normalizedCandidate);

  if (!relative) {
    return true;
  }

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeForComparison(candidatePath) {
  const resolved = path.resolve(candidatePath);
  if (process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

export class PathGuardError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "PathGuardError";
    this.code = code;
  }
}
