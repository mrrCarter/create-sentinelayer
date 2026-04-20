// graceful-degradation-check — flag call sites that fail hard when a
// non-critical dependency errors (#A18).
//
// Heuristic: find files that call external deps but contain no try/catch
// around them and no "fallback" / "default" / "cache" signal. Those files
// propagate any dependency failure up to the user. A P2 advisory — it's
// common and not always wrong — but worth a human look.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
]);

const OUTBOUND_PATTERNS = [
  /\bfetch\s*\(/,
  /\baxios(?:\.[a-z]+)?\s*\(/,
  /\bgot(?:\.[a-z]+)?\s*\(/,
  /\brequests\.(?:get|post|put|patch|delete|request)\s*\(/,
  /\bhttpx\.(?:get|post|put|patch|delete|request)\s*\(/,
];

const DEGRADATION_SIGNALS = [
  /try\s*\{[\s\S]{0,600}?catch\s*\(/,
  /\?\?\s*(?:cache|default|fallback)/i,
  /try\s*:[\s\S]{0,600}?except\b/,
  /\bif\s+cached/i,
  /stale[-_]while[-_]revalidate/i,
  /feature[_-]flag/,
  /circuit[_-]?breaker/i,
];

export async function runGracefulDegradationCheck({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  const reportedFiles = new Set();
  for await (const { fullPath, relativePath } of iterator) {
    const rel = toPosix(relativePath);
    if (reportedFiles.has(rel)) {
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const hasOutbound = OUTBOUND_PATTERNS.some((p) => p.test(content));
    if (!hasOutbound) {
      continue;
    }
    const hasDegradation = DEGRADATION_SIGNALS.some((p) => p.test(content));
    if (hasDegradation) {
      continue;
    }

    const firstMatch =
      findLineMatches(content, OUTBOUND_PATTERNS[0])[0] ||
      findLineMatches(content, OUTBOUND_PATTERNS[1])[0] ||
      findLineMatches(content, OUTBOUND_PATTERNS[2])[0] ||
      findLineMatches(content, OUTBOUND_PATTERNS[3])[0] ||
      findLineMatches(content, OUTBOUND_PATTERNS[4])[0];
    if (!firstMatch) {
      continue;
    }
    reportedFiles.add(rel);
    findings.push(
      createFinding({
        tool: "graceful-degradation-check",
        kind: "reliability.no-graceful-degradation",
        severity: "P2",
        file: rel,
        line: firstMatch.line,
        evidence: getLineContent(content, firstMatch.line),
        rootCause:
          "External call has no try/catch, cached fallback, feature flag, or circuit breaker in scope — failure in the dependency bubbles straight to the caller.",
        recommendedFix:
          "Wrap with a fallback: cached value, default response, or fail-silent for non-critical calls. Use a feature flag to cut over to degraded mode during incidents.",
        confidence: 0.45,
      })
    );
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
