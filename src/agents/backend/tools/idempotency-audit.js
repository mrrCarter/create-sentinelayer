// idempotency-audit — flag mutation endpoints without idempotency plumbing (#A14).
//
// Backend-runtime review: every POST / PUT / PATCH that can be retried by a
// client (or a queue / webhook) should carry an idempotency key, and the
// server should dedupe on it. We scan for handler declarations and look for
// signals that idempotency is being honored — presence of
// `idempotency_key`, `Idempotency-Key`, or a deduplication table lookup —
// anywhere in the file.

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

const MUTATION_PATTERNS = [
  // JS / TS routers: Express, Fastify, Koa, Hono
  /\b(?:app|router|server|route)\.(post|put|patch)\s*\(/,
  /\bfastify\.(post|put|patch)\s*\(/,
  /\bhono\.(post|put|patch)\s*\(/,
  // Next.js app-router handlers
  /^export\s+async\s+function\s+(POST|PUT|PATCH)\s*\(/m,
  // Python: FastAPI / Flask
  /@(?:app|router|blueprint)\.(post|put|patch)\s*\(/,
];

const IDEMPOTENCY_SIGNALS = [
  /idempotency[_-]?key/i,
  /Idempotency-Key/,
  /dedupe|deduplicat|already_processed/i,
];

export async function runIdempotencyAudit({ rootPath, files = null } = {}) {
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
    const hasSignal = IDEMPOTENCY_SIGNALS.some((pattern) => pattern.test(content));
    if (hasSignal) {
      continue;
    }

    const allMatches = [];
    for (const pattern of MUTATION_PATTERNS) {
      allMatches.push(...findLineMatches(content, pattern));
    }
    if (allMatches.length === 0) {
      continue;
    }
    allMatches.sort((a, b) => a.line - b.line);
    const first = allMatches[0];
    findings.push(
      createFinding({
        tool: "idempotency-audit",
        kind: "backend.no-idempotency",
        severity: "P2",
        file: toPosix(relativePath),
        line: first.line,
        evidence: getLineContent(content, first.line),
        rootCause:
          "Mutation-style route handler(s) declared in a file with no idempotency / dedupe plumbing. Retries from clients, queues, or webhooks risk double-charge / double-send.",
        recommendedFix:
          "Accept an Idempotency-Key header, persist (key, response) for a reasonable window (e.g. 24h), and return the cached response on replay.",
        confidence: 0.5,
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
