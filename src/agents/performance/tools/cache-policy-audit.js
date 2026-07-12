// cache-policy-audit - flag expensive handler work with no cache signal (#A16).

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

const HANDLER_PATH_PATTERN =
  /(?:^|\/)(?:api|app|routes|controllers|handlers|server|pages)(?:\/|$)/i;
const EXPENSIVE_CALL_PATTERN =
  /\b(?:fetch|axios(?:\.[a-z]+)?|got(?:\.[a-z]+)?|requests\.(?:get|post)|httpx\.(?:get|post)|db\.\w+|prisma\.\w+|repository\.\w+|query|execute)\s*\(/i;
const CACHE_SIGNAL_PATTERN =
  /\b(?:cache|cached|memoize|ttl|revalidate|stale-while-revalidate|Cache-Control|ETag|If-None-Match|max-age)\b/i;

export async function runCachePolicyAudit({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];
  for await (const { fullPath, relativePath } of iterateFiles(resolvedRoot, files, CODE_EXTENSIONS)) {
    const normalizedPath = toPosix(relativePath);
    if (!HANDLER_PATH_PATTERN.test(normalizedPath)) {
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    if (!EXPENSIVE_CALL_PATTERN.test(content) || CACHE_SIGNAL_PATTERN.test(content)) {
      continue;
    }
    const match = findLineMatches(content, EXPENSIVE_CALL_PATTERN)[0];
    const line = match?.line || 1;
    findings.push(
      createFinding({
        tool: "cache-policy-audit",
        kind: "performance.missing-cache-policy",
        severity: "P2",
        file: normalizedPath,
        line,
        evidence: getLineContent(content, line),
        rootCause:
          "Request handler performs remote/database work without an explicit cache, TTL, revalidation, or HTTP cache-control signal.",
        recommendedFix:
          "Add an explicit cache policy: bounded TTL, request coalescing, stale-while-revalidate, ETag, or documented no-store rationale.",
        confidence: 0.58,
      })
    );
  }
  return findings;
}

export {
  CACHE_SIGNAL_PATTERN,
  EXPENSIVE_CALL_PATTERN,
  HANDLER_PATH_PATTERN,
};
