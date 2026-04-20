// timeout-audit — flag outbound calls without explicit timeout (#A14).
//
// Default timeouts in every major HTTP client are too long:
//   - Node fetch: no timeout by default — a hung downstream ties up a
//     handler indefinitely
//   - axios: no timeout by default
//   - requests: no connect/read timeout by default
//   - urllib: no timeout
// We flag outbound calls that don't carry an explicit `timeout` / `signal` /
// AbortSignal within the call arguments.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

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

const JS_CALLS = [
  { pattern: /\bfetch\s*\(/, label: "fetch" },
  { pattern: /\baxios(?:\.[a-z]+)?\s*\(/, label: "axios" },
  { pattern: /\bgot(?:\.[a-z]+)?\s*\(/, label: "got" },
  { pattern: /\bhttp\.(?:request|get|post)\s*\(/, label: "http" },
  { pattern: /\bhttps\.(?:request|get|post)\s*\(/, label: "https" },
];

const PY_CALLS = [
  { pattern: /\brequests\.(?:get|post|put|patch|delete|request)\s*\(/, label: "requests" },
  { pattern: /\burllib\.request\.urlopen\s*\(/, label: "urllib" },
  { pattern: /\bhttpx\.(?:get|post|put|patch|delete|request)\s*\(/, label: "httpx" },
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
              "Always pass an explicit timeout: AbortSignal.timeout(ms) for fetch, { timeout } for axios / got / requests / httpx. Pick a value that's shorter than your request SLO.",
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
