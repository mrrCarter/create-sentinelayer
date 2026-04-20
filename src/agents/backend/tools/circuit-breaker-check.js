// circuit-breaker-check — flag outbound calls lacking a circuit breaker (#A14).
//
// A "circuit breaker" in backend-runtime reviews is any guard that bounds
// failure propagation — opossum, cockatiel, Polly (in .NET interop),
// resilience4j, hystrix-style patterns, or hand-rolled "open/half-open"
// state machines. The heuristic: look for outbound primitive calls (fetch,
// axios, got, http.request, node-fetch, requests, urllib, aiohttp) and
// verify there's a breaker mention in the same file or a common wrapper
// file. Absence → P1 finding for human review.
//
// We stay conservative: one finding per file per outbound surface (not per
// call site) so a file with 40 fetches doesn't produce 40 identical
// findings.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const JS_TS_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);
const PY_EXTENSIONS = new Set([".py"]);
const CODE_EXTENSIONS = new Set([...JS_TS_EXTENSIONS, ...PY_EXTENSIONS]);

const OUTBOUND_PATTERNS_JS = [
  /\bfetch\s*\(/,
  /\baxios(?:\.[a-z]+)?\s*\(/,
  /\bgot(?:\.[a-z]+)?\s*\(/,
  /\bhttp\.(?:request|get|post)\s*\(/,
  /\bhttps\.(?:request|get|post)\s*\(/,
  /\bsuperagent(?:\.[a-z]+)?\s*\(/,
];

const OUTBOUND_PATTERNS_PY = [
  /\brequests\.(?:get|post|put|patch|delete|request)\s*\(/,
  /\burllib\.request\.urlopen\s*\(/,
  /\baiohttp\.ClientSession\s*\(/,
  /\bhttpx\.(?:get|post|put|patch|delete|request)\s*\(/,
];

const BREAKER_SIGNALS = [
  /circuitBreaker|circuit_breaker|CircuitBreaker/,
  /opossum|cockatiel|resilience4j|hystrix|Polly/i,
  /\bbreaker\.(?:fire|exec|execute)\s*\(/,
];

export async function runCircuitBreakerCheck({ rootPath, files = null } = {}) {
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
    const ext = path.extname(fullPath).toLowerCase();
    const outboundPatterns = PY_EXTENSIONS.has(ext)
      ? OUTBOUND_PATTERNS_PY
      : OUTBOUND_PATTERNS_JS;

    const hasBreaker = BREAKER_SIGNALS.some((pattern) => pattern.test(content));
    if (hasBreaker) {
      continue;
    }

    const seenPatterns = new Set();
    for (const pattern of outboundPatterns) {
      if (!pattern.test(content)) {
        continue;
      }
      if (seenPatterns.has(pattern.source)) {
        continue;
      }
      seenPatterns.add(pattern.source);
      const match = pattern.exec(content);
      const lineIndex = content.slice(0, match?.index || 0).split(/\r?\n/).length;
      findings.push(
        createFinding({
          tool: "circuit-breaker-check",
          kind: "backend.no-circuit-breaker",
          severity: "P1",
          file: toPosix(relativePath),
          line: lineIndex,
          evidence: `${pattern.source} called without a circuit breaker in this file`,
          rootCause:
            "Outbound primitive call has no circuit breaker in scope — a slow or failing dependency cascades into the caller's runtime.",
          recommendedFix:
            "Wrap the dependency in a circuit breaker (opossum on Node, pybreaker / hyx in Python) with OPEN / HALF_OPEN / CLOSED transitions and fail-closed defaults.",
          confidence: 0.55,
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
