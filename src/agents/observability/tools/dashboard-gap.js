// dashboard-gap — check that a dashboard config exists somewhere (#A20).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const MANIFEST_SIGNATURES = [
  /(^|\/)dashboards?\//,
  /(^|\/)grafana\//,
  /(^|\/)datadog\//,
  /(^|\/)observability\//,
];
const DASHBOARD_FILES = /\.json$|\.yaml$|\.yml$/i;

export async function runDashboardGap({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  let found = false;
  for await (const { relativePath } of walkRepoFiles({ rootPath: resolvedRoot })) {
    const rel = toPosix(relativePath);
    if (MANIFEST_SIGNATURES.some((p) => p.test(rel)) && DASHBOARD_FILES.test(rel)) {
      found = true;
      break;
    }
  }
  if (found) {
    return [];
  }
  return [
    createFinding({
      tool: "dashboard-gap",
      kind: "observability.no-dashboard",
      severity: "P3",
      file: "",
      line: 0,
      evidence: "No dashboards/, grafana/, datadog/, or observability/ directory with JSON / YAML configs",
      rootCause: "No dashboard config checked into the repo. Ad-hoc dashboards created in the UI are invisible to code review and drift over time.",
      recommendedFix: "Check a machine-readable dashboard source (Grafana JSON, Datadog Terraform, OpenMetrics) into the repo. Generate the deployed dashboard from source to keep them in sync.",
      confidence: 0.55,
    }),
  ];
}
