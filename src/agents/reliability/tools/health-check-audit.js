// health-check-audit — flag services without health / readiness endpoints (#A18).
//
// Any service behind a load balancer or deployed to k8s needs a health
// endpoint so the platform can remove unhealthy instances from rotation.
// We flag route-declaring files that don't expose a /health or /ready
// endpoint.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
]);

const ROUTE_DECLARATION = /\b(?:app|router|server|fastify|hono)\.(get|post|put|patch|delete)\s*\(|@(?:app|router|api_router)\.(?:get|post|put|patch|delete)\s*\(|func\s+\w+\(\s*w\s+http\.ResponseWriter/;
const HEALTH_SIGNALS = [
  /\/health(z)?\b/i,
  /\/ready(z)?\b/i,
  /\/live(ness)?\b/i,
  /\/_status\b/,
  /healthCheck\s*:/,
];

export async function runHealthCheckAudit({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  const perService = new Map(); // dirKey -> { hasRoutes, hasHealth }

  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const dirKey = toPosix(path.dirname(relativePath)) || ".";
    const existing = perService.get(dirKey) || { hasRoutes: false, hasHealth: false, sampleFile: "" };
    if (ROUTE_DECLARATION.test(content)) {
      existing.hasRoutes = true;
      if (!existing.sampleFile) {
        existing.sampleFile = toPosix(relativePath);
      }
    }
    if (HEALTH_SIGNALS.some((p) => p.test(content))) {
      existing.hasHealth = true;
    }
    perService.set(dirKey, existing);
  }

  // Roll up per "service-ish" directory: if a route-declaring directory has
  // no health endpoint anywhere under it, flag it.
  for (const [dirKey, info] of perService.entries()) {
    if (!info.hasRoutes || info.hasHealth) {
      continue;
    }
    // Check if a sibling dir under the same service root has a health endpoint.
    const parent = toPosix(path.posix.dirname(dirKey)) || ".";
    const siblingHasHealth = Array.from(perService.entries()).some(
      ([k, v]) => v.hasHealth && (toPosix(path.posix.dirname(k)) === parent || k === parent)
    );
    if (siblingHasHealth) {
      continue;
    }
    findings.push(
      createFinding({
        tool: "health-check-audit",
        kind: "reliability.no-health-endpoint",
        severity: "P2",
        file: info.sampleFile,
        line: 0,
        evidence: `Routes declared in ${dirKey}/ but no /health /ready /live endpoint detected`,
        rootCause:
          "Load balancers and orchestrators rely on health checks to route around failing instances. No health endpoint means failures propagate as user-facing errors.",
        recommendedFix:
          "Add a `/healthz` endpoint that returns HTTP 200 when dependencies (DB, cache, queue) respond within SLO; otherwise return 503.",
        confidence: 0.55,
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
