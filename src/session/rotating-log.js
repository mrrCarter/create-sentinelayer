import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import util from "node:util";

export const DEFAULT_ROTATING_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_ROTATING_LOG_MAX_FILES = 5;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizePositiveInteger(value, fallbackValue) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackValue;
  }
  return Math.max(1, Math.floor(numeric));
}

export function normalizeRotatingLogOptions({
  maxBytes = DEFAULT_ROTATING_LOG_MAX_BYTES,
  maxFiles = DEFAULT_ROTATING_LOG_MAX_FILES,
} = {}) {
  return {
    maxBytes: normalizePositiveInteger(maxBytes, DEFAULT_ROTATING_LOG_MAX_BYTES),
    maxFiles: normalizePositiveInteger(maxFiles, DEFAULT_ROTATING_LOG_MAX_FILES),
  };
}

export function rotateLogFileIfNeeded(logPath, options = {}) {
  const normalizedLogPath = normalizeString(logPath);
  if (!normalizedLogPath) {
    return { rotated: false, reason: "missing_log_path" };
  }

  const { maxBytes, maxFiles } = normalizeRotatingLogOptions(options);
  let currentSize = 0;
  try {
    currentSize = fs.statSync(normalizedLogPath).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { rotated: false, reason: "missing_file", maxBytes, maxFiles };
    }
    throw error;
  }

  if (currentSize < maxBytes) {
    return { rotated: false, reason: "under_limit", size: currentSize, maxBytes, maxFiles };
  }

  fs.mkdirSync(path.dirname(normalizedLogPath), { recursive: true });
  const backupCount = Math.max(0, maxFiles - 1);
  if (backupCount === 0) {
    fs.rmSync(normalizedLogPath, { force: true });
    return { rotated: true, reason: "removed_active", size: currentSize, maxBytes, maxFiles };
  }

  fs.rmSync(`${normalizedLogPath}.${backupCount}`, { force: true });
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    const from = `${normalizedLogPath}.${index}`;
    const to = `${normalizedLogPath}.${index + 1}`;
    if (fs.existsSync(from)) {
      fs.renameSync(from, to);
    }
  }
  fs.renameSync(normalizedLogPath, `${normalizedLogPath}.1`);
  return { rotated: true, reason: "rotated", size: currentSize, maxBytes, maxFiles };
}

export function appendRotatingLogLine(logPath, line = "", options = {}) {
  const normalizedLogPath = normalizeString(logPath);
  if (!normalizedLogPath) {
    return { written: false, reason: "missing_log_path" };
  }
  fs.mkdirSync(path.dirname(normalizedLogPath), { recursive: true });
  const rotation = rotateLogFileIfNeeded(normalizedLogPath, options);
  fs.appendFileSync(normalizedLogPath, `${String(line)}\n`, "utf-8");
  return { written: true, rotation };
}

function normalizeLogChunk(chunk, encoding = "utf8") {
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString(typeof encoding === "string" ? encoding : "utf8");
  }
  return String(chunk ?? "");
}

export function formatConsoleLogLine(parts = []) {
  return parts.map((part) => (typeof part === "string" ? part : util.inspect(part))).join(" ");
}

export function installRotatingConsoleLog({
  logPath,
  maxBytes = DEFAULT_ROTATING_LOG_MAX_BYTES,
  maxFiles = DEFAULT_ROTATING_LOG_MAX_FILES,
  tee = true,
  now = () => new Date(),
  onError = null,
  captureConsoleError = true,
  captureStderr = true,
} = {}) {
  const normalizedLogPath = normalizeString(logPath);
  if (!normalizedLogPath) {
    return () => {};
  }

  const options = normalizeRotatingLogOptions({ maxBytes, maxFiles });
  const originalLog = console.log;
  const originalError = console.error;
  const originalStderrWrite = process.stderr.write;
  let warned = false;
  const writeLogLine = (line) => {
    try {
      appendRotatingLogLine(
        normalizedLogPath,
        `${now().toISOString()} ${line}`,
        options,
      );
    } catch (error) {
      if (!warned) {
        warned = true;
        if (typeof onError === "function") {
          onError(error);
        }
      }
    }
  };

  console.log = (...parts) => {
    if (tee) {
      originalLog(...parts);
    }
    writeLogLine(formatConsoleLogLine(parts));
  };

  if (captureStderr) {
    process.stderr.write = function rotatingStderrWrite(chunk, encoding, callback) {
      const text = normalizeLogChunk(chunk, encoding).replace(/\s+$/u, "");
      if (text) {
        writeLogLine(`[stderr] ${text}`);
      }
      if (!tee) {
        if (typeof encoding === "function") {
          encoding();
        } else if (typeof callback === "function") {
          callback();
        }
        return true;
      }
      return originalStderrWrite.apply(process.stderr, arguments);
    };
  }

  if (captureConsoleError) {
    console.error = (...parts) => {
      if (tee) {
        originalError(...parts);
      }
      if (!captureStderr || !tee) {
        writeLogLine(`[stderr] ${formatConsoleLogLine(parts)}`);
      }
    };
  }

  return () => {
    console.log = originalLog;
    console.error = originalError;
    process.stderr.write = originalStderrWrite;
  };
}
