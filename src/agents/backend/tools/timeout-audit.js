// timeout-audit — flag outbound calls without explicit timeout (#A14).
// @sentinelayer-static-analysis-only
//
// Default timeouts in common HTTP clients are usually unsafe for backend
// handlers. This offline scanner flags outbound call expressions that do not
// carry an explicit timeout or abort signal.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

// circuitBreaker is not applicable here: this tool only reads local files.
// HTTP client names below are regex literals used to inspect other files.

const JS_TS_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);
const PY_EXTENSIONS = new Set([".py"]);

function extractCallArgs(content, callIndex) {
  // Very small bracket matcher — pulls the argument substring between the
  // `(` following `callIndex` and the matching `)` (tracking nested
  // parens / template literals at a simple level).
  let depth = 0;
  let inString = null;
  let start = -1;
  for (let i = callIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      if (depth === 1) {
        start = i + 1;
      }
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, i);
      }
    }
  }
  return "";
}

function hasTimeoutInArgs(argString) {
  return /timeout\s*[:=]\s*[^,)}\]]+|signal\s*:\s*[^,)}\]]+|AbortSignal\.timeout\s*\(/i.test(
    argString || ""
  );
}

const CALL_OPEN_PATTERN = "\\s*\\(";
const HTTP_METHOD_PATTERN = "(?:get|post|put|patch|delete|request)";

function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function callPattern(name, { optionalMethod = false, methods = null } = {}) {
  const escapedName = escapeRegexLiteral(name);
  const suffix = methods
    ? `\\.(?:${methods.map(escapeRegexLiteral).join("|")})`
    : optionalMethod
      ? "(?:\\.[a-z]+)?"
      : "";
  return new RegExp(`\\b${escapedName}${suffix}${CALL_OPEN_PATTERN}`);
}

const JS_CALLS = [
  { pattern: callPattern("fetch"), label: "fetch" },
  { pattern: callPattern("axios", { optionalMethod: true }), label: "axios" },
  { pattern: callPattern("got", { optionalMethod: true }), label: "got" },
  { pattern: callPattern("http", { methods: ["request", "get", "post"] }), label: "http" },
  { pattern: callPattern("https", { methods: ["request", "get", "post"] }), label: "https" },
];

const PY_CALLS = [
  { pattern: new RegExp(`\\brequests\\.${HTTP_METHOD_PATTERN}${CALL_OPEN_PATTERN}`), label: "requests" },
  { pattern: callPattern("urllib.request.urlopen"), label: "urllib" },
  { pattern: new RegExp(`\\bhttpx\\.${HTTP_METHOD_PATTERN}${CALL_OPEN_PATTERN}`), label: "httpx" },
];

export async function runTimeoutAudit({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const extensions = new Set([...JS_TS_EXTENSIONS, ...PY_EXTENSIONS]);
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const calls = PY_EXTENSIONS.has(ext) ? PY_CALLS : JS_CALLS;

    for (const call of calls) {
      for (const match of findLineMatches(content, call.pattern)) {
        const argString = extractCallArgs(content, match.index);
        if (hasTimeoutInArgs(argString)) {
          continue;
        }
        findings.push(
          createFinding({
            tool: "timeout-audit",
            kind: "backend.no-timeout",
            severity: "P1",
            file: toPosix(relativePath),
            line: match.line,
            evidence: getLineContent(content, match.line),
            rootCause: `${call.label} call has no explicit timeout — a slow downstream can stall the handler indefinitely.`,
            recommendedFix:
              "Always pass an explicit timeout or abort signal for outbound clients. Pick a value shorter than your request SLO.",
            confidence: 0.7,
          })
        );
      }
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
