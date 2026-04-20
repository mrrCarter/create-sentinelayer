// alert-audit — check that alert definitions exist (#A20).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const ALERT_SIGNATURES = [
  /(^|\/)alerts?\/[^/]+\.(ya?ml|json|tf)$/i,
  /(^|\/)prometheus\/rules?\//i,
  /(^|\/)alertmanager\//i,
  /(^|\/)monitors?\/[^/]+\.(ya?ml|json|tf)$/i,
];

export async function runAlertAudit({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  let found = false;
  for await (const { relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (ALERT_SIGNATURES.some((p) => p.test(rel))) {
      found = true;
      break;
    }
  }
  if (found) return [];
  return [
    createFinding({
      tool: "alert-audit",
      kind: "observability.no-alerts",
      severity: "P2",
      file: "",
      line: 0,
      evidence: "No alert definitions found under alerts/, monitors/, prometheus/rules/, or alertmanager/",
      rootCause: "Without declarative alert definitions we can't tell what production failures the team is actually notified of.",
      recommendedFix: "Define alerts in code (Prometheus rules, Datadog Terraform monitors, SLO burn-rate alerts). Require every critical endpoint to have an error-rate + latency alert.",
      confidence: 0.6,
    }),
  ];
}
