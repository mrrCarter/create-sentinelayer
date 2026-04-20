// api-diff — flag API endpoints without corresponding doc coverage (#A23).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"]);
const DOC_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);

const ROUTE_REGEX = /\b(?:app|router|server|fastify|hono)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const NEXT_REGEX = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/gm;

async function collectEndpoints(rootPath) {
  const endpoints = new Set();
  for await (const { fullPath, relativePath } of walkRepoFiles({
    rootPath,
    extensions: CODE_EXTENSIONS,
  })) {
    const rel = toPosix(relativePath);
    if (/(^|\/)(tests?|__tests__|specs?)\//.test(rel)) continue;
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    let m;
    while ((m = ROUTE_REGEX.exec(content)) !== null) {
      endpoints.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
    ROUTE_REGEX.lastIndex = 0;
    if (/\/api\//.test(rel)) {
      while ((m = NEXT_REGEX.exec(content)) !== null) {
        const route = rel.replace(/^.*\/api\//, "/api/").replace(/\/route\.(ts|js)x?$/, "");
        endpoints.add(`${m[1]} ${route}`);
      }
      NEXT_REGEX.lastIndex = 0;
    }
  }
  return endpoints;
}

async function collectDocumentedEndpoints(rootPath) {
  const documented = new Set();
  for await (const { fullPath, relativePath } of walkRepoFiles({
    rootPath,
    extensions: DOC_EXTENSIONS,
  })) {
    const rel = toPosix(relativePath);
    if (!/(^|\/)(docs?|api|spec)\//i.test(rel) && !/API\.md$/.test(rel) && !/openapi|swagger/i.test(rel)) {
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const regex = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'"]*)/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
      documented.add(`${m[1]} ${m[2]}`);
    }
  }
  return documented;
}

export async function runApiDiff({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const endpoints = await collectEndpoints(resolvedRoot);
  const documented = await collectDocumentedEndpoints(resolvedRoot);
  const findings = [];
  for (const endpoint of endpoints) {
    if (documented.has(endpoint)) continue;
    findings.push(
      createFinding({
        tool: "api-diff",
        kind: "documentation.undocumented-endpoint",
        severity: "P3",
        file: "",
        line: 0,
        evidence: `${endpoint} — no matching entry found in docs/, openapi*, swagger*, API.md`,
        rootCause: "Endpoints that ship without docs can't be discovered by downstream clients and bit-rot silently.",
        recommendedFix: "Add the endpoint to openapi.yaml / API.md / docs/api.md with request + response shape and auth requirements.",
        confidence: 0.45,
      })
    );
  }
  return findings;
}
