// blocking-io-audit - flag synchronous I/O on request/runtime paths (#A16).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, iterateFiles, toPosix } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
]);

const BLOCKING_IO_RULES = Object.freeze([
  {
    kind: "performance.blocking-sync-fs",
    pattern:
      /\b(?:fs\.)?(?:readFileSync|writeFileSync|appendFileSync|readdirSync|statSync|existsSync)\s*\(/,
    severity: "P2",
    rootCause:
      "Synchronous filesystem call blocks the event loop or request worker while disk I/O completes.",
    recommendedFix:
      "Use async filesystem APIs and move startup-only reads outside hot request paths.",
    confidence: 0.74,
  },
  {
    kind: "performance.blocking-child-process",
    pattern: /\b(?:execSync|spawnSync|execFileSync)\s*\(/,
    severity: "P1",
    rootCause:
      "Synchronous child process execution blocks the runtime and can stall all concurrent requests.",
    recommendedFix:
      "Use async process APIs, queue the work, or precompute the artifact before serving traffic.",
    confidence: 0.82,
  },
  {
    kind: "performance.blocking-sleep",
    pattern: /\b(?:sleepSync|Atomics\.wait|time\.sleep)\s*\(/,
    severity: "P2",
    rootCause:
      "Blocking sleep pauses the worker instead of yielding, which turns transient waits into throughput loss.",
    recommendedFix:
      "Use async timers, scheduled jobs, or backoff that yields to the runtime event loop.",
    confidence: 0.7,
  },
]);

export async function runBlockingIoAudit({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  for await (const { fullPath, relativePath } of iterateFiles(resolvedRoot, files, CODE_EXTENSIONS)) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const rule of BLOCKING_IO_RULES) {
      for (const match of findLineMatches(content, rule.pattern)) {
        findings.push(
          createFinding({
            tool: "blocking-io-audit",
            kind: rule.kind,
            severity: rule.severity,
            file: toPosix(relativePath),
            line: match.line,
            evidence: getLineContent(content, match.line),
            rootCause: rule.rootCause,
            recommendedFix: rule.recommendedFix,
            confidence: rule.confidence,
          })
        );
      }
    }
  }
  return findings;
}

export { BLOCKING_IO_RULES };
