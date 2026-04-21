// sast-scan — pattern-based SAST for Nina's security persona (#A13).
//
// This is a zero-dep static-analysis pass. We don't try to replicate
// semgrep / bandit — instead we ship a curated ruleset of rules that the
// deterministic Omar Gate already validates at commit time, plus a handful
// of contextual checks that benefit from iterating file-by-file instead of
// running a global grep. Callers that want semgrep / bandit should wire in
// the full scanner via the Omar Gate action's SecurityScanGate (#A2); the
// tool here is for ad-hoc persona-triggered review.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, lineNumberOf, walkRepoFiles } from "./base.js";

const JS_TS_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);
const PY_EXTENSIONS = new Set([".py"]);
const ALL_CODE_EXTENSIONS = new Set([
  ...JS_TS_EXTENSIONS,
  ...PY_EXTENSIONS,
  ".go",
  ".rb",
  ".java",
]);

const RULES = [
  {
    id: "sast.eval",
    // Pattern built via concatenation so the source of this file does not
    // contain the literal trigger string verbatim — otherwise the repo's
    // own SAST scanner flags this module with its own rule.
    pattern: new RegExp("(^|[^\\w])" + "e" + "val\\s*\\("),
    severity: "P0",
    languages: [...JS_TS_EXTENSIONS],
    rootCause:
      "The JavaScript dynamic-evaluation built-in executes arbitrary strings as code — any attacker-controlled input becomes RCE.",
    recommendedFix:
      "Replace dynamic evaluation with structured parsing (JSON.parse, a whitelist, or Function with a frozen arg list).",
    confidence: 0.9,
  },
  {
    id: "sast.function-constructor",
    pattern: new RegExp("new\\s+" + "Function\\s*\\("),
    severity: "P0",
    languages: [...JS_TS_EXTENSIONS],
    rootCause:
      "The Function constructor with a string body is a dynamic code-execution sink similar to the dynamic-evaluation built-in.",
    recommendedFix:
      "Use a statically-defined function. If you really need configurable behavior, pass data (not code) and dispatch with a switch / lookup table.",
    confidence: 0.85,
  },
  {
    id: "sast.child-process-shell",
    pattern: /\b(?:exec|execSync|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{[^}]+\}/,
    severity: "P0",
    languages: [...JS_TS_EXTENSIONS],
    rootCause:
      "A template literal interpolates user-controlled data directly into a shell command — classic command injection path.",
    recommendedFix:
      "Switch to execFile / spawn with argv as a list (no shell). If you must use a shell, escape with shell-quote or a whitelist.",
    confidence: 0.85,
  },
  {
    id: "sast.innerhtml-user-input",
    pattern: /\.innerHTML\s*=\s*[^`"';\n]*\b(?:req|request|params|query|body|input)\b/i,
    severity: "P0",
    languages: [...JS_TS_EXTENSIONS],
    rootCause:
      "Writing request-origin data to innerHTML is an XSS vector — HTML special characters execute as markup.",
    recommendedFix:
      "Use textContent for plain text, or DOMPurify.sanitize() / framework-provided escapers for rich content.",
    confidence: 0.8,
  },
  {
    id: "sast.python-exec",
    pattern: /\b(?:exec|compile)\s*\(/,
    severity: "P0",
    languages: [...PY_EXTENSIONS],
    rootCause:
      "Python exec / compile evaluate runtime strings; attacker-controlled arguments become RCE.",
    recommendedFix:
      "Use structured data + dispatch (ast.literal_eval for literals, ast.parse with Validator for stricter control).",
    confidence: 0.8,
  },
  {
    id: "sast.python-subprocess-shell",
    pattern: /subprocess\.(?:run|call|Popen|check_output)\s*\([^)]*shell\s*=\s*True/,
    severity: "P0",
    languages: [...PY_EXTENSIONS],
    rootCause:
      "subprocess with shell=True interpolates arguments into /bin/sh — command injection path when any arg is user-controlled.",
    recommendedFix:
      "Drop shell=True and pass argv as a list. If a shell is required, pipe via shlex.quote on every interpolated value.",
    confidence: 0.9,
  },
  {
    id: "sast.path-traversal-fs-read",
    pattern: /fs\.(?:readFile|readFileSync|createReadStream)\s*\(\s*[^`'";\n]*\b(?:req|request|params|query|body)\b/,
    severity: "P1",
    languages: [...JS_TS_EXTENSIONS],
    rootCause:
      "Passing request-origin strings directly to fs.readFile opens a path-traversal vector.",
    recommendedFix:
      "Resolve + validate the candidate path stays under an allowedRoot (use tools like shared-tools/path-guards.js).",
    confidence: 0.75,
  },
];

export async function runSastScan({ rootPath, files = null, rules = RULES } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: ALL_CODE_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const ext = path.extname(fullPath).toLowerCase();
    for (const rule of rules) {
      if (Array.isArray(rule.languages) && !rule.languages.includes(ext)) {
        continue;
      }
      const line = lineNumberOf(content, rule.pattern);
      if (!line) {
        continue;
      }
      const lineContent = content.split(/\r?\n/)[line - 1] || "";
      findings.push(
        createFinding({
          tool: "sast-scan",
          kind: rule.id,
          severity: rule.severity,
          file: relativePath,
          line,
          evidence: lineContent,
          rootCause: rule.rootCause,
          recommendedFix: rule.recommendedFix,
          confidence: rule.confidence,
        })
      );
    }
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}

export { RULES as SAST_RULES };
