// retry-audit — flag retry loops without exponential backoff + jitter (#A14).
//
// Retries are a footgun: a linear / fixed-interval retry against a failing
// downstream is a synchronized flood, which is exactly when you want jitter
// and exponential backoff. We look for loops that include `setTimeout(...)`
// or `sleep(...)` with constant delays as a heuristic — the LLM review
// layer confirms.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, toPosix, walkRepoFiles } from "./base.js";

const JS_TS_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);
const PY_EXTENSIONS = new Set([".py"]);

// "for-loop with constant sleep" pattern — a classic bad-retry shape.
const BAD_RETRY_PATTERNS = [
  // for (let i = 0; i < 5; i++) { ...; await sleep(1000); } — constant 1000 ms
  {
    pattern: /for\s*\([^)]*;[^)]*<[^)]*\)\s*\{[\s\S]{0,500}?(?:setTimeout|sleep|delay|wait)\s*\([^)]*\b\d{2,}\b[^)]*\)/,
    kind: "backend.retry-constant-delay",
    severity: "P2",
    rootCause:
      "A for-loop retry with a constant delay creates synchronized load on the downstream when it recovers.",
    recommendedFix:
      "Replace with exponential backoff + jitter. Libraries: p-retry / async-retry on Node, tenacity on Python.",
    confidence: 0.6,
  },
  {
    pattern: /while\s*\([^)]*(?:retry|attempt)[^)]*\)\s*\{[\s\S]{0,500}?(?:setTimeout|sleep|delay|wait)\s*\([^)]*\b\d{2,}\b[^)]*\)/,
    kind: "backend.retry-constant-delay",
    severity: "P2",
    rootCause:
      "A while-retry loop with a constant delay thunders herd once the downstream recovers.",
    recommendedFix:
      "Add exponential backoff and jitter. A simple formula: delay = Math.min(maxDelay, baseDelay * 2**attempt * (0.5 + Math.random())).",
    confidence: 0.55,
  },
  {
    pattern: /for\s+\w+\s+in\s+range\s*\([^)]*\)\s*:\s*\n[\s\S]{0,400}?time\.sleep\s*\(\s*\d+\s*\)/,
    kind: "backend.retry-constant-delay",
    severity: "P2",
    rootCause:
      "Python retry loop uses time.sleep with a constant — synchronized retry storm risk.",
    recommendedFix:
      "Switch to tenacity.retry with stop_after_attempt + wait_exponential_jitter.",
    confidence: 0.55,
  },
];

// "no jitter" signal: we look for files that DO have retry logic (mentioned
// keywords) but don't mention jitter / random.
function hasJitter(content) {
  return /jitter|Math\.random|random\.(?:random|uniform)|secrets\.randbelow/.test(
    content
  );
}

function hasRetryLibraryHint(content) {
  return /p-retry|async-retry|retry\.operation|tenacity\.retry|@retry|retry_strategy|Polly/.test(
    content
  );
}

export async function runRetryAudit({ rootPath, files = null } = {}) {
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

    if (hasRetryLibraryHint(content)) {
      // Retry library is in use — assume it handles backoff correctly.
      continue;
    }

    for (const rule of BAD_RETRY_PATTERNS) {
      const matches = findLineMatches(content, rule.pattern);
      if (matches.length === 0) {
        continue;
      }
      findings.push(
        createFinding({
          tool: "retry-audit",
          kind: rule.kind,
          severity: rule.severity,
          file: toPosix(relativePath),
          line: matches[0].line,
          evidence: (content.split(/\r?\n/)[matches[0].line - 1] || "").trim(),
          rootCause: rule.rootCause,
          recommendedFix: rule.recommendedFix,
          confidence: hasJitter(content) ? Math.max(0.3, rule.confidence - 0.2) : rule.confidence,
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
