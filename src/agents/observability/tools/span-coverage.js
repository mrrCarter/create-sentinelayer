// span-coverage — flag route handlers without a tracing span (#A20).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go"]);

const HANDLER_PATTERNS = [
  /\b(?:app|router|server|fastify|hono)\.(get|post|put|patch|delete)\s*\(/,
  /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/m,
  /@(?:app|router|api_router)\.(?:get|post|put|patch|delete)\s*\(/,
];

const SPAN_SIGNALS = [
  /tracer\.startSpan|tracer\.startActiveSpan|otel\.|opentelemetry|@tracing|withSpan|withActiveSpan/i,
  /sentry\.(?:startTransaction|startSpan)/i,
  /datadog|dd-trace|ddtrace/i,
  /Sentry\.startTransaction/,
];

export async function runSpanCoverage({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const hasHandler = HANDLER_PATTERNS.some((p) => p.test(content));
    if (!hasHandler) {
      continue;
    }
    const hasSpan = SPAN_SIGNALS.some((p) => p.test(content));
    if (hasSpan) {
      continue;
    }
    const match = findLineMatches(content, HANDLER_PATTERNS[0])[0] ||
      findLineMatches(content, HANDLER_PATTERNS[1])[0] ||
      findLineMatches(content, HANDLER_PATTERNS[2])[0];
    findings.push(
      createFinding({
        tool: "span-coverage",
        kind: "observability.no-span",
        severity: "P2",
        file: toPosix(relativePath),
        line: match?.line || 1,
        evidence: getLineContent(content, match?.line || 1),
        rootCause: "Route handler declared without any tracing-span signal (OpenTelemetry, Sentry, Datadog). Request latency / error breakdowns will be opaque.",
        recommendedFix: "Wrap the handler body in tracer.startActiveSpan('<name>', …) or use framework middleware that auto-instruments handlers.",
        confidence: 0.55,
      })
    );
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) continue;
    const fullPath = path.isAbsolute(trimmed) ? trimmed : path.join(resolvedRoot, trimmed);
    const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}
