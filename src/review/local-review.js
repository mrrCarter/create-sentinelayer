import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";
import { resolveCodebaseIngest } from "../ingest/engine.js";
import { runSpecBindingChecks } from "./spec-binding.js";

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
const MAX_FINDINGS = 250;
const STATIC_CHECK_TIMEOUT_MS = 120_000;

const SOURCE_CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".sql",
]);

const SEVERITY_ORDER = new Map([
  ["P0", 0],
  ["P1", 1],
  ["P2", 2],
  ["P3", 3],
]);

const TEST_OR_FIXTURE_PATH_PATTERN = /(?:^|[\\/])(?:test|tests|__tests__|fixtures?)(?:[\\/]|$)/i;
const LOCAL_REVIEW_SOURCE_PATH_PATTERN = /(?:^|[\\/])src[\\/]review[\\/]local-review\.js$/i;
const WORK_ITEM_MARKER_EXCLUDE_PATH_PATTERN = new RegExp(
  `${TEST_OR_FIXTURE_PATH_PATTERN.source}|${LOCAL_REVIEW_SOURCE_PATH_PATTERN.source}`,
  "i"
);

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
    excludePathPattern: TEST_OR_FIXTURE_PATH_PATTERN,
  },
  {
    severity: "P2",
    message: "Work-item marker found.",
    regex: /\b(?:\x54\x4f\x44\x4f|\x46\x49\x58\x4d\x45|\x48\x41\x43\x4b)\b/,
    excludePathPattern: WORK_ITEM_MARKER_EXCLUDE_PATH_PATTERN,
  },
]);

const DETERMINISTIC_REVIEW_RULES = Object.freeze([
  {
    id: "SL-SEC-001",
    severity: "P1",
    message: "Possible AWS access key detected.",
    suggestedFix: "Remove committed credentials and rotate the key.",
    regex: /AKIA[0-9A-Z]{16}/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-002",
    severity: "P1",
    message: "Possible private key material detected.",
    suggestedFix: "Delete committed key material and rotate any dependent certs.",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: "SL-SEC-003",
    severity: "P1",
    message: "Possible GitHub token detected.",
    suggestedFix: "Revoke and rotate token; source from secure runtime config.",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-004",
    severity: "P1",
    message: "Possible provider API key detected.",
    suggestedFix: "Rotate API keys and move to managed secret storage.",
    regex: /\b(sk-[A-Za-z0-9]{20,})\b/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-005",
    severity: "P2",
    message: "Possible hardcoded credential literal.",
    suggestedFix: "Replace literal with environment/secret-manager lookup.",
    regex: /(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['\"][^'\"]{12,}['\"]/i,
    sourceOnly: true,
    excludePathPattern: TEST_OR_FIXTURE_PATH_PATTERN,
  },
  {
    id: "SL-SEC-006",
    severity: "P2",
    message: "Possible hardcoded bearer token.",
    suggestedFix: "Remove token literals and rotate exposed credentials.",
    regex: /Bearer\s+[A-Za-z0-9._\-]{20,}/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-007",
    severity: "P2",
    message: "Possible embedded JWT detected.",
    suggestedFix: "Do not store JWTs in source code.",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-008",
    severity: "P2",
    message: "Potential database connection string with inline credentials.",
    suggestedFix: "Externalize DSN and rotate embedded credentials.",
    regex: /(postgres|mysql|mariadb|sqlserver):\/\/[^\s:@]+:[^\s@]+@/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-009",
    severity: "P2",
    message: "Potential MongoDB URI with inline credentials.",
    suggestedFix: "Use secret-managed URI and avoid inline username/password.",
    regex: /mongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s@]+@/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-010",
    severity: "P2",
    message: "Potential Redis URI with inline credentials.",
    suggestedFix: "Move Redis credentials to secret manager.",
    regex: /redis(?:\+tls)?:\/\/[^\s:@]+:[^\s@]+@/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-011",
    severity: "P1",
    message: "Possible Slack webhook URL detected.",
    suggestedFix: "Rotate webhook and store it outside source control.",
    regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-012",
    severity: "P1",
    message: "Possible Stripe live secret key detected.",
    suggestedFix: "Rotate Stripe key and use secure runtime injection.",
    regex: /\bsk_live_[A-Za-z0-9]{16,}\b/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-013",
    severity: "P2",
    message: "Plain HTTP endpoint literal found.",
    suggestedFix: "Prefer HTTPS endpoints in production paths.",
    regex: /\bhttp:\/\/[^\s'"]+/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-014",
    severity: "P2",
    message: "Work-item marker detected (TODO/FIXME/HACK).",
    suggestedFix: "Resolve or scope pending work before release.",
    regex: /\b(?:TODO|FIXME|HACK)\b/,
    sourceOnly: true,
    excludePathPattern: WORK_ITEM_MARKER_EXCLUDE_PATH_PATTERN,
  },
  {
    id: "SL-SEC-015",
    severity: "P1",
    message: "Dynamic code execution primitive detected (`eval`).",
    suggestedFix: "Replace eval with explicit parser or safe handlers.",
    regex: /\beval\s*\(/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-016",
    severity: "P2",
    message: "Template-literal shell execution detected.",
    suggestedFix: "Avoid shell interpolation with untrusted inputs.",
    regex: /exec(?:Sync)?\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`\s*\)/,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-017",
    severity: "P2",
    message: "Possible SQL string concatenation detected.",
    suggestedFix: "Use parameterized queries and prepared statements.",
    regex: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;\n]{0,140}\+/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-018",
    severity: "P1",
    message: "Potential wildcard CORS policy detected.",
    suggestedFix: "Replace wildcard CORS with explicit allowlist.",
    regex: /Access-Control-Allow-Origin\s*[:=]\s*['"]\*['"]/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-019",
    severity: "P1",
    message: "TLS certificate verification appears disabled.",
    suggestedFix: "Remove insecure TLS bypass and use valid certificates.",
    regex: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-020",
    severity: "P2",
    message: "Potentially sensitive value logged directly.",
    suggestedFix: "Redact secrets/tokens before logging.",
    regex: /console\.(?:log|debug|info)\([^)]*(token|secret|password|api[_-]?key)/i,
    sourceOnly: true,
  },
  {
    id: "SL-SEC-021",
    severity: "P2",
    message: "Tracked environment file may contain secrets.",
    suggestedFix: "Commit only sanitized `.env.example` files.",
    kind: "file",
    filePattern: /(^|\/)\.env(\.[^/]+)?$/i,
    excludePathPattern: /\.example$/i,
  },
  {
    id: "SL-SEC-022",
    severity: "P2",
    message: "Hardcoded localhost callback URL detected.",
    suggestedFix: "Externalize callback URLs to environment config.",
    regex: /https?:\/\/localhost:\d{2,5}\//i,
    sourceOnly: true,
  },
]);

function formatTimestampForFile() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeMode(mode, { allowedModes = ["full", "diff", "staged"] } = {}) {
  const normalized = String(mode || "full").trim().toLowerCase();
  if (!allowedModes.includes(normalized)) {
    throw new Error(`mode must be one of: ${allowedModes.join(", ")}.`);
  }
  return normalized;
}

function isSourceLikeFile(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return SOURCE_CODE_EXTENSIONS.has(extension);
}

function severityRank(value) {
  return SEVERITY_ORDER.has(value) ? SEVERITY_ORDER.get(value) : 99;
}

function regexMatches(regex, input) {
  const flags = regex.flags.replace(/g/g, "");
  return new RegExp(regex.source, flags).test(input);
}

function sanitizeLineForExcerpt(line) {
  return String(line || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function createFinding({
  severity,
  file,
  line,
  message,
  excerpt,
  ruleId,
  suggestedFix,
  layer,
}) {
  return {
    severity,
    file,
    line,
    message,
    excerpt,
    ruleId,
    suggestedFix,
    layer,
  };
}

function tryPushFinding(findings, finding, maxFindings) {
  if (findings.length >= maxFindings) {
    return false;
  }
  findings.push(finding);
  return true;
}

function ruleAppliesToPath(rule, relativePath) {
  if (rule.filePattern && !rule.filePattern.test(relativePath)) {
    return false;
  }
  if (rule.excludePathPattern && rule.excludePathPattern.test(relativePath)) {
    return false;
  }
  if (Array.isArray(rule.allowedExtensions) && rule.allowedExtensions.length > 0) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!rule.allowedExtensions.includes(extension)) {
      return false;
    }
  }
  if (rule.sourceOnly && !isSourceLikeFile(relativePath)) {
    return false;
  }
  return true;
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

async function collectStagedScanFiles(rootPath) {
  const revParse = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: rootPath,
    encoding: "utf-8",
  });
  if (revParse.status !== 0 || !String(revParse.stdout || "").trim().toLowerCase().includes("true")) {
    throw new Error("Staged review mode requires a git repository.");
  }

  const changedRelativePaths = runGitList(rootPath, [
    "diff",
    "--name-only",
    "--cached",
    "--diff-filter=ACMRTUXB",
  ]);

  const files = new Set();
  for (const relativePath of changedRelativePaths) {
    const absolutePath = path.resolve(rootPath, relativePath);
    await includeFileIfScannable(rootPath, absolutePath, files);
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

async function collectModeFilePaths(rootPath, mode) {
  if (mode === "diff") {
    return collectDiffScanFiles(rootPath);
  }
  if (mode === "staged") {
    return collectStagedScanFiles(rootPath);
  }
  return collectAllScanFiles(rootPath);
}

async function scanRulesForFiles({ rootPath, filePaths, rules, maxFindings = MAX_FINDINGS, layer = "structural" } = {}) {
  const findings = [];

  for (const filePath of filePaths) {
    if (findings.length >= maxFindings) {
      break;
    }

    const relativePath = toPosixPath(path.relative(rootPath, filePath));
    const activeRules = rules.filter((rule) => ruleAppliesToPath(rule, relativePath));
    if (activeRules.length === 0) {
      continue;
    }

    const fileRules = activeRules.filter((rule) => String(rule.kind || "line") === "file");
    for (const rule of fileRules) {
      const pushed = tryPushFinding(
        findings,
        createFinding({
          severity: rule.severity,
          file: relativePath,
          line: 1,
          message: rule.message,
          excerpt: "File-level policy match",
          ruleId: rule.id || "SL-RULE",
          suggestedFix: rule.suggestedFix || "Review and remediate this finding.",
          layer,
        }),
        maxFindings
      );
      if (!pushed) {
        break;
      }
    }
    if (findings.length >= maxFindings) {
      break;
    }

    let text = "";
    try {
      text = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/g);
    const lineRules = activeRules.filter((rule) => String(rule.kind || "line") !== "file");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (findings.length >= maxFindings) {
        break;
      }
      const line = lines[lineIndex];
      if (!line) {
        continue;
      }
      if (line.includes("<your-token>") || line.includes("example")) {
        continue;
      }
      for (const rule of lineRules) {
        if (!regexMatches(rule.regex, line)) {
          continue;
        }
        const pushed = tryPushFinding(
          findings,
          createFinding({
            severity: rule.severity,
            file: relativePath,
            line: lineIndex + 1,
            message: rule.message,
            excerpt: sanitizeLineForExcerpt(line),
            ruleId: rule.id || "SL-RULE",
            suggestedFix: rule.suggestedFix || "Review and remediate this finding.",
            layer,
          }),
          maxFindings
        );
        if (!pushed) {
          break;
        }
      }
    }
  }

  return findings;
}

async function scanFileSet(rootPath, filePaths) {
  const findings = await scanRulesForFiles({
    rootPath,
    filePaths,
    rules: REVIEW_RULES,
    maxFindings: MAX_FINDINGS,
    layer: "scan",
  });

  const p1 = findings.filter((item) => item.severity === "P1").length;
  const p2 = findings.filter((item) => item.severity === "P2").length;

  return {
    scannedFiles: filePaths.length,
    findings,
    p1,
    p2,
  };
}

function resolveLineNumberFromIndex(text, index) {
  if (!Number.isFinite(index) || index < 0) {
    return 1;
  }
  const prior = String(text || "").slice(0, index);
  return prior.split(/\r?\n/g).length;
}

async function runPatternChecks({ rootPath, filePaths, maxFindings = MAX_FINDINGS } = {}) {
  const findings = [];

  for (const filePath of filePaths) {
    if (findings.length >= maxFindings) {
      break;
    }

    const relativePath = toPosixPath(path.relative(rootPath, filePath));
    if (!isSourceLikeFile(relativePath)) {
      continue;
    }

    let text = "";
    try {
      text = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/g);
    const extension = path.extname(relativePath).toLowerCase();

    if ((extension === ".tsx" || extension === ".jsx") && lines.length >= 700) {
      tryPushFinding(
        findings,
        createFinding({
          severity: "P2",
          file: relativePath,
          line: 1,
          message: "Large UI component detected (possible god component).",
          excerpt: `${lines.length} lines`,
          ruleId: "SL-PAT-001",
          suggestedFix: "Split component into smaller focused units with explicit ownership.",
          layer: "pattern",
        }),
        maxFindings
      );
    }

    for (let index = 0; index < lines.length; index += 1) {
      if (findings.length >= maxFindings) {
        break;
      }
      const line = lines[index];
      if (!line) {
        continue;
      }

      if (/dangerouslySetInnerHTML/.test(line) || /innerHTML\s*=/.test(line)) {
        tryPushFinding(
          findings,
          createFinding({
            severity: "P1",
            file: relativePath,
            line: index + 1,
            message: "Direct HTML sink detected; validate/sanitize untrusted content.",
            excerpt: sanitizeLineForExcerpt(line),
            ruleId: "SL-PAT-002",
            suggestedFix: "Apply strict sanitization and avoid raw HTML sinks.",
            layer: "pattern",
          }),
          maxFindings
        );
      }

      if (/useEffect\s*\(/.test(line)) {
        const window = lines.slice(index, Math.min(lines.length, index + 14)).join("\n");
        if ((/addEventListener|setInterval|fetch\(/.test(window) || /subscribe\(/.test(window)) && !/return\s*\(\s*\)\s*=>/.test(window)) {
          tryPushFinding(
            findings,
            createFinding({
              severity: "P2",
              file: relativePath,
              line: index + 1,
              message: "Possible useEffect side-effect without cleanup.",
              excerpt: sanitizeLineForExcerpt(line),
              ruleId: "SL-PAT-003",
              suggestedFix: "Add cleanup in useEffect return and verify dependency intent.",
              layer: "pattern",
            }),
            maxFindings
          );
        }
      }

      if (/(for|while)\s*\([^)]*\)/.test(line)) {
        const window = lines.slice(index, Math.min(lines.length, index + 10)).join("\n");
        if (/findMany\(|query\(|SELECT\b|fetch\(/i.test(window)) {
          tryPushFinding(
            findings,
            createFinding({
              severity: "P2",
              file: relativePath,
              line: index + 1,
              message: "Possible N+1 or repeated remote/database call in loop.",
              excerpt: sanitizeLineForExcerpt(line),
              ruleId: "SL-PAT-004",
              suggestedFix: "Batch queries/calls and prefetch outside iterative loops.",
              layer: "pattern",
            }),
            maxFindings
          );
        }
      }
    }

    const sqlConcat = /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n]{0,160}\+/i.exec(text);
    if (sqlConcat && findings.length < maxFindings) {
      const lineNumber = resolveLineNumberFromIndex(text, sqlConcat.index);
      tryPushFinding(
        findings,
        createFinding({
          severity: "P2",
          file: relativePath,
          line: lineNumber,
          message: "Potential SQL string interpolation detected.",
          excerpt: sanitizeLineForExcerpt(sqlConcat[0]),
          ruleId: "SL-PAT-005",
          suggestedFix: "Use parameterized query placeholders instead of string concatenation.",
          layer: "pattern",
        }),
        maxFindings
      );
    }
  }

  return findings;
}

function buildStaticChecks(ingest = {}) {
  const detectedManifests = Array.isArray(ingest.manifests?.detected) ? ingest.manifests.detected : [];
  if (!detectedManifests.includes("package.json")) {
    return [];
  }

  return [
    {
      id: "npm-lint",
      label: "npm run lint --if-present",
      command: "npm",
      args: ["run", "lint", "--if-present"],
      fileHint: "package.json",
    },
    {
      id: "npm-typecheck",
      label: "npm run typecheck --if-present",
      command: "npm",
      args: ["run", "typecheck", "--if-present"],
      fileHint: "package.json",
    },
    {
      id: "npm-format-check",
      label: "npm run format:check --if-present",
      command: "npm",
      args: ["run", "format:check", "--if-present"],
      fileHint: "package.json",
    },
    {
      id: "npm-test",
      label: "npm test --if-present",
      command: "npm",
      args: ["test", "--if-present"],
      fileHint: "package.json",
    },
  ];
}

async function executeStaticCheck({ check, targetPath, runDir } = {}) {
  const checksDir = path.join(runDir, "checks");
  await fsp.mkdir(checksDir, { recursive: true });

  const startedAt = Date.now();
  const result = spawnSync(check.command, check.args, {
    cwd: targetPath,
    encoding: "utf-8",
    timeout: STATIC_CHECK_TIMEOUT_MS,
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
    },
  });

  const durationMs = Date.now() - startedAt;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const stdoutPath = path.join(checksDir, `${check.id}.stdout.log`);
  const stderrPath = path.join(checksDir, `${check.id}.stderr.log`);
  await fsp.writeFile(stdoutPath, stdout, "utf-8");
  await fsp.writeFile(stderrPath, stderr, "utf-8");

  if (result.error && result.error.code === "ENOENT") {
    return {
      id: check.id,
      label: check.label,
      command: `${check.command} ${check.args.join(" ")}`,
      status: "skipped",
      reason: `${check.command} not found in PATH`,
      exitCode: null,
      durationMs,
      stdoutPath,
      stderrPath,
      fileHint: check.fileHint,
    };
  }

  if (result.error && result.error.code === "ETIMEDOUT") {
    return {
      id: check.id,
      label: check.label,
      command: `${check.command} ${check.args.join(" ")}`,
      status: "timeout",
      reason: `Timed out after ${STATIC_CHECK_TIMEOUT_MS}ms`,
      exitCode: null,
      durationMs,
      stdoutPath,
      stderrPath,
      fileHint: check.fileHint,
    };
  }

  if (result.error) {
    return {
      id: check.id,
      label: check.label,
      command: `${check.command} ${check.args.join(" ")}`,
      status: "error",
      reason: result.error.message,
      exitCode: result.status,
      durationMs,
      stdoutPath,
      stderrPath,
      fileHint: check.fileHint,
    };
  }

  return {
    id: check.id,
    label: check.label,
    command: `${check.command} ${check.args.join(" ")}`,
    status: result.status === 0 ? "pass" : "fail",
    reason: result.status === 0 ? "ok" : "Command returned non-zero exit code",
    exitCode: result.status,
    durationMs,
    stdoutPath,
    stderrPath,
    fileHint: check.fileHint,
  };
}

async function runStaticAnalysisLayer({ targetPath, ingest, runDir, maxFindings = MAX_FINDINGS } = {}) {
  const checks = buildStaticChecks(ingest);
  const results = [];
  const findings = [];

  for (const check of checks) {
    const result = await executeStaticCheck({
      check,
      targetPath,
      runDir,
    });
    results.push(result);

    if (findings.length >= maxFindings) {
      continue;
    }

    if (result.status === "fail" || result.status === "timeout" || result.status === "error") {
      findings.push(
        createFinding({
          severity: "P2",
          file: result.fileHint || "package.json",
          line: 1,
          message: `Static analysis check failed: ${result.label}`,
          excerpt: `${result.status}${result.exitCode === null ? "" : ` (exit ${result.exitCode})`}`,
          ruleId: `SL-STA-${check.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`,
          suggestedFix: "Review check logs and remediate lint/typecheck/test failures.",
          layer: "static_analysis",
        })
      );
    }
  }

  return {
    checks: results,
    findings,
  };
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runReadinessChecks({ targetPath, maxFindings = MAX_FINDINGS } = {}) {
  const findings = [];

  const hasOmarWorkflow = await fileExists(path.join(targetPath, ".github", "workflows", "omar-gate.yml"));
  if (!hasOmarWorkflow && findings.length < maxFindings) {
    findings.push(
      createFinding({
        severity: "P2",
        file: ".github/workflows/omar-gate.yml",
        line: 1,
        message: "Omar Gate workflow is missing.",
        excerpt: "Required workflow not found",
        ruleId: "SL-READINESS-001",
        suggestedFix: "Initialize or restore `.github/workflows/omar-gate.yml`.",
        layer: "readiness",
      })
    );
  }

  const hasSpec =
    (await fileExists(path.join(targetPath, "SPEC.md"))) ||
    (await fileExists(path.join(targetPath, "docs", "spec.md")));
  if (!hasSpec && findings.length < maxFindings) {
    findings.push(
      createFinding({
        severity: "P2",
        file: "SPEC.md",
        line: 1,
        message: "Spec document is missing.",
        excerpt: "Expected SPEC.md or docs/spec.md",
        ruleId: "SL-READINESS-002",
        suggestedFix: "Generate and commit a current spec before final review runs.",
        layer: "readiness",
      })
    );
  }

  return findings;
}

function sortFindings(findings = []) {
  return [...findings].sort((left, right) => {
    const severityDelta = severityRank(left.severity) - severityRank(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    const fileDelta = String(left.file || "").localeCompare(String(right.file || ""));
    if (fileDelta !== 0) {
      return fileDelta;
    }
    const lineDelta = Number(left.line || 0) - Number(right.line || 0);
    if (lineDelta !== 0) {
      return lineDelta;
    }
    return String(left.ruleId || "").localeCompare(String(right.ruleId || ""));
  });
}

function summarizeSeverity(findings = []) {
  return findings.reduce(
    (accumulator, finding) => {
      const severity = String(finding.severity || "P3").toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(accumulator, severity)) {
        accumulator[severity] = 0;
      }
      accumulator[severity] += 1;
      return accumulator;
    },
    {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
    }
  );
}

function formatStaticCheckMarkdown(checks = []) {
  if (!checks.length) {
    return "- none";
  }
  return checks
    .map(
      (check) =>
        `- ${check.id}: ${check.status} (${check.durationMs}ms) :: ${check.command}${check.reason ? ` :: ${check.reason}` : ""}`
    )
    .join("\n");
}

function formatDeterministicFindingsMarkdown(findings = []) {
  if (!findings.length) {
    return "- none";
  }
  return findings
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] (${finding.ruleId}) ${finding.file}:${finding.line} - ${finding.message}\n` +
        `   suggested_fix: ${finding.suggestedFix}\n` +
        `   excerpt: ${finding.excerpt}`
    )
    .join("\n");
}

function buildDeterministicReviewMarkdown(result) {
  const frameworks = result.layers.ingest.frameworks.length
    ? result.layers.ingest.frameworks.join(", ")
    : "none";
  const riskSurfaces = result.layers.ingest.riskSurfaces.length
    ? result.layers.ingest.riskSurfaces.map((item) => item.surface).join(", ")
    : "none";
  const scopedPreview = result.scope.scannedRelativeFiles.slice(0, 80);
  const omitted = Math.max(0, result.scope.scannedRelativeFiles.length - scopedPreview.length);

  return `# REVIEW_DETERMINISTIC

Generated: ${result.generatedAt}
Run ID: ${result.runId}
Target: ${result.targetPath}
Mode: ${result.mode}

Summary:
- Files scoped: ${result.scope.scannedFiles}
- Findings: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}
- Blocking: ${result.summary.blocking ? "yes" : "no"}

Layer 1 - Codebase ingest:
- Files scanned: ${result.layers.ingest.summary.filesScanned}
- Total LOC: ${result.layers.ingest.summary.totalLoc}
- Frameworks: ${frameworks}
- Risk surfaces: ${riskSurfaces}
- Refresh: ${result.layers.ingest.refresh?.refreshed ? "yes" : "no"}
- Stale: ${result.layers.ingest.refresh?.stale ? "yes" : "no"}
- Refresh reasons: ${(result.layers.ingest.refresh?.reasons || []).join(", ") || "none"}

Layer 2 - Structural analysis:
- Rules evaluated: ${result.layers.structural.ruleCount}
- Findings: ${result.layers.structural.findingCount}

Layer 3 - Static analysis orchestration:
${formatStaticCheckMarkdown(result.layers.staticAnalysis.checks)}

Layer 4 - Spec binding checks:
- Enabled: ${result.layers.specBinding.enabled ? "yes" : "no"}
- Spec path: ${result.layers.specBinding.specPath || "none"}
- Spec hash: ${result.layers.specBinding.specHashSha256 || "none"}
- Spec endpoints: ${result.layers.specBinding.endpointCount}
- Acceptance criteria: ${result.layers.specBinding.acceptanceCriteriaCount}
- Findings: ${result.layers.specBinding.findingCount}

Layer 5 - Pattern checks:
- Findings: ${result.layers.pattern.findingCount}

Readiness checks:
- Findings: ${result.layers.readiness.findingCount}

Scoped files:
${scopedPreview.length > 0 ? scopedPreview.map((item) => `- ${item}`).join("\n") : "- none"}
${omitted > 0 ? `- ... ${omitted} more files omitted` : ""}

Findings:
${formatDeterministicFindingsMarkdown(result.findings)}
`;
}

async function writeDeterministicReviewArtifacts({ result, runDir } = {}) {
  const markdownPath = path.join(runDir, "REVIEW_DETERMINISTIC.md");
  const jsonPath = path.join(runDir, "REVIEW_DETERMINISTIC.json");

  await fsp.writeFile(markdownPath, `${buildDeterministicReviewMarkdown(result).trim()}\n`, "utf-8");
  await fsp.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");

  return {
    markdownPath,
    jsonPath,
  };
}

export async function runDeterministicReviewPipeline({
  targetPath,
  mode = "full",
  outputDir = "",
  specFile = "",
  refreshIngest = false,
} = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedMode = normalizeMode(mode, {
    allowedModes: ["full", "diff", "staged"],
  });

  const outputRoot = await resolveOutputRoot({
    cwd: normalizedTargetPath,
    outputDirOverride: outputDir,
  });
  const runId = `review-${formatTimestampForFile()}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(outputRoot, "reviews", runId);
  await fsp.mkdir(runDir, { recursive: true });

  const ingestResolution = await resolveCodebaseIngest({
    rootPath: normalizedTargetPath,
    outputDir,
    refresh: Boolean(refreshIngest),
  });
  const ingest = ingestResolution.ingest;
  const scopedFiles = await collectModeFilePaths(normalizedTargetPath, normalizedMode);

  const structuralFindings = await scanRulesForFiles({
    rootPath: normalizedTargetPath,
    filePaths: scopedFiles,
    rules: DETERMINISTIC_REVIEW_RULES,
    maxFindings: MAX_FINDINGS,
    layer: "structural",
  });

  let remainingBudget = Math.max(0, MAX_FINDINGS - structuralFindings.length);
  const patternFindings = await runPatternChecks({
    rootPath: normalizedTargetPath,
    filePaths: scopedFiles,
    maxFindings: remainingBudget,
  });

  remainingBudget = Math.max(0, remainingBudget - patternFindings.length);
  const readinessFindings = await runReadinessChecks({
    targetPath: normalizedTargetPath,
    maxFindings: remainingBudget,
  });

  remainingBudget = Math.max(0, remainingBudget - readinessFindings.length);
  const specBinding = await runSpecBindingChecks({
    targetPath: normalizedTargetPath,
    mode: normalizedMode,
    scopedFilePaths: scopedFiles,
    maxFindings: remainingBudget,
    specFile,
  });

  remainingBudget = Math.max(0, remainingBudget - specBinding.findings.length);
  const staticAnalysis = await runStaticAnalysisLayer({
    targetPath: normalizedTargetPath,
    ingest,
    runDir,
    maxFindings: remainingBudget,
  });

  const findings = sortFindings([
    ...structuralFindings,
    ...patternFindings,
    ...readinessFindings,
    ...specBinding.findings,
    ...staticAnalysis.findings,
  ]);
  const severity = summarizeSeverity(findings);

  const result = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    runId,
    targetPath: normalizedTargetPath,
    mode: normalizedMode,
    scope: {
      scannedFiles: scopedFiles.length,
      scannedRelativeFiles: scopedFiles.map((filePath) => toPosixPath(path.relative(normalizedTargetPath, filePath))),
    },
    layers: {
      ingest: {
        summary: ingest.summary,
        frameworks: Array.isArray(ingest.frameworks) ? ingest.frameworks : [],
        entryPoints: Array.isArray(ingest.entryPoints) ? ingest.entryPoints : [],
        manifests: Array.isArray(ingest.manifests?.detected) ? ingest.manifests.detected : [],
        riskSurfaces: Array.isArray(ingest.riskSurfaces) ? ingest.riskSurfaces : [],
        refresh: {
          outputPath: ingestResolution.outputPath,
          refreshed: ingestResolution.refreshed,
          stale: ingestResolution.stale,
          reasons: ingestResolution.reasons,
          refreshedBecause: ingestResolution.refreshedBecause,
          lastCommitAt: ingestResolution.lastCommitAt,
          contentHash: ingestResolution.fingerprint?.contentHash || "",
        },
      },
      structural: {
        ruleCount: DETERMINISTIC_REVIEW_RULES.length,
        findingCount: structuralFindings.length,
      },
      staticAnalysis: {
        checkCount: staticAnalysis.checks.length,
        checks: staticAnalysis.checks,
        findingCount: staticAnalysis.findings.length,
      },
      specBinding: {
        enabled: Boolean(specBinding.metadata.enabled),
        specPath: specBinding.metadata.specPath
          ? toPosixPath(path.relative(normalizedTargetPath, specBinding.metadata.specPath))
          : "",
        specHashSha256: specBinding.metadata.specHashSha256 || "",
        endpointCount: specBinding.metadata.endpointCount || 0,
        acceptanceCriteriaCount: specBinding.metadata.acceptanceCriteriaCount || 0,
        endpointsPreview: Array.isArray(specBinding.metadata.endpointsPreview)
          ? specBinding.metadata.endpointsPreview
          : [],
        findingCount: specBinding.findings.length,
      },
      pattern: {
        findingCount: patternFindings.length,
      },
      readiness: {
        findingCount: readinessFindings.length,
      },
    },
    findings,
    summary: {
      P0: severity.P0,
      P1: severity.P1,
      P2: severity.P2,
      P3: severity.P3,
      blocking: severity.P0 > 0 || severity.P1 > 0,
    },
  };

  const artifacts = await writeDeterministicReviewArtifacts({
    result,
    runDir,
  });

  return {
    ...result,
    artifacts: {
      runDirectory: runDir,
      ...artifacts,
    },
  };
}

export async function runLocalReviewScan({ targetPath, mode = "full", specFile = "" } = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedMode = normalizeMode(mode, {
    allowedModes: ["full", "diff", "staged"],
  });

  const filePaths = await collectModeFilePaths(normalizedTargetPath, normalizedMode);

  const scan = await scanFileSet(normalizedTargetPath, filePaths);
  const remainingBudget = Math.max(0, MAX_FINDINGS - scan.findings.length);
  const specBinding = await runSpecBindingChecks({
    targetPath: normalizedTargetPath,
    mode: normalizedMode,
    scopedFilePaths: filePaths,
    maxFindings: remainingBudget,
    specFile,
  });
  const findings = sortFindings([...scan.findings, ...specBinding.findings]);
  const p1 = findings.filter((item) => item.severity === "P1").length;
  const p2 = findings.filter((item) => item.severity === "P2").length;

  return {
    targetPath: normalizedTargetPath,
    mode: normalizedMode,
    scannedRelativeFiles: filePaths.map((filePath) =>
      toPosixPath(path.relative(normalizedTargetPath, filePath))
    ),
    scannedFiles: filePaths.length,
    findings,
    p1,
    p2,
    specBinding: specBinding.metadata,
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
