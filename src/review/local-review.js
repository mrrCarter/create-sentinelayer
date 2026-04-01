import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  ".next",
  "dist",
  "build",
  ".sentinelayer",
]);
const MAX_FILE_SIZE_BYTES = 512 * 1024;
const MAX_FINDINGS = 200;

const REVIEW_RULES = Object.freeze([
  {
    severity: "P1",
    message: "Possible AWS access key detected.",
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    severity: "P1",
    message: "Possible private key material detected.",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    severity: "P1",
    message: "Possible provider API key detected.",
    regex: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})\b/,
  },
  {
    severity: "P2",
    message: "Possible hardcoded credential literal.",
    regex: /(api[_-]?key|secret|token)\s*[:=]\s*['\"][^'\"]{20,}['\"]/i,
  },
  {
    severity: "P2",
    message: "Work-item marker found.",
    regex: /\b(?:\x54\x4f\x44\x4f|\x46\x49\x58\x4d\x45|\x48\x41\x43\x4b)\b/,
  },
]);

function formatTimestampForFile() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function isIgnoredPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (!relative || relative.startsWith("..")) {
    return true;
  }
  const parts = relative.split(/[\\/]+/g).filter(Boolean);
  return parts.some((part) => IGNORED_DIRS.has(part));
}

async function includeFileIfScannable(rootPath, filePath, outputSet) {
  if (isIgnoredPath(rootPath, filePath)) {
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      return;
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return;
    }
  } catch {
    return;
  }

  outputSet.add(path.resolve(filePath));
}

async function collectAllScanFiles(rootPath) {
  const files = new Set();
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      await includeFileIfScannable(rootPath, fullPath, files);
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

function runGitList(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function collectDiffScanFiles(rootPath) {
  const revParse = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: rootPath,
    encoding: "utf-8",
  });
  if (revParse.status !== 0 || !String(revParse.stdout || "").trim().toLowerCase().includes("true")) {
    throw new Error("Diff review mode requires a git repository.");
  }

  const changedRelativePaths = new Set([
    ...runGitList(rootPath, ["diff", "--name-only", "--diff-filter=ACMRTUXB"]),
    ...runGitList(rootPath, ["diff", "--name-only", "--cached", "--diff-filter=ACMRTUXB"]),
    ...runGitList(rootPath, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  const files = new Set();
  for (const relativePath of changedRelativePaths) {
    const absolutePath = path.resolve(rootPath, relativePath);
    await includeFileIfScannable(rootPath, absolutePath, files);
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

async function scanFileSet(rootPath, filePaths) {
  const findings = [];

  for (const filePath of filePaths) {
    let text = "";
    try {
      text = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line) {
        continue;
      }
      if (line.includes("<your-token>") || line.includes("example")) {
        continue;
      }
      for (const rule of REVIEW_RULES) {
        if (!rule.regex.test(line)) {
          continue;
        }
        findings.push({
          severity: rule.severity,
          file: path.relative(rootPath, filePath).replace(/\\/g, "/"),
          line: lineIndex + 1,
          message: rule.message,
          excerpt: line.trim().slice(0, 180),
        });
        if (findings.length >= MAX_FINDINGS) {
          break;
        }
      }
      if (findings.length >= MAX_FINDINGS) {
        break;
      }
    }
    if (findings.length >= MAX_FINDINGS) {
      break;
    }
  }

  const p1 = findings.filter((item) => item.severity === "P1").length;
  const p2 = findings.filter((item) => item.severity === "P2").length;

  return {
    scannedFiles: filePaths.length,
    findings,
    p1,
    p2,
  };
}

export async function runLocalReviewScan({ targetPath, mode = "full" } = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedMode = String(mode || "full").trim().toLowerCase();
  if (normalizedMode !== "full" && normalizedMode !== "diff") {
    throw new Error("mode must be either 'full' or 'diff'.");
  }

  const filePaths =
    normalizedMode === "diff"
      ? await collectDiffScanFiles(normalizedTargetPath)
      : await collectAllScanFiles(normalizedTargetPath);

  const scan = await scanFileSet(normalizedTargetPath, filePaths);
  return {
    targetPath: normalizedTargetPath,
    mode: normalizedMode,
    scannedRelativeFiles: filePaths.map((filePath) =>
      path.relative(normalizedTargetPath, filePath).replace(/\\/g, "/")
    ),
    ...scan,
  };
}

export function formatFindingsMarkdown(findings = []) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return "- none";
  }
  return findings
    .map((item, index) => `${index + 1}. [${item.severity}] ${item.file}:${item.line} - ${item.message}`)
    .join("\n");
}

export async function writeReviewReport({
  targetPath,
  mode,
  outputDir = "",
  reportMarkdown,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: targetPath,
    outputDirOverride: outputDir,
  });
  const reportDir = path.join(outputRoot, "reports");
  await fsp.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `review-scan-${mode}-${formatTimestampForFile()}.md`);
  await fsp.writeFile(reportPath, `${String(reportMarkdown || "").trim()}\n`, "utf-8");
  return reportPath;
}
