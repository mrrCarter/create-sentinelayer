// coupling-analysis — flag high fan-out / fan-in modules (#A16).
//
// Fan-out: how many distinct modules does THIS file import? Very high
// fan-out suggests an anti-pattern — the file knows too much about the
// rest of the system.
//
// Fan-in: how many modules import THIS file? Very high fan-in marks a
// "god module" that many sites depend on; risk is concentrated here.

import path from "node:path";

import { createFinding } from "./base.js";
import { buildDependencyGraph } from "./dep-graph.js";

const FAN_OUT_THRESHOLD = 20;
const FAN_IN_THRESHOLD = 15;

export async function runCouplingAnalysis({ rootPath, files = null, graph = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const dependencyGraph =
    graph && typeof graph === "object"
      ? graph
      : await buildDependencyGraph({ rootPath: resolvedRoot, files });

  const fanOut = {};
  const fanIn = {};
  for (const [file, edges] of Object.entries(dependencyGraph)) {
    fanOut[file] = edges.length;
    for (const edge of edges) {
      if (edge.startsWith("npm:") || edge.startsWith("/")) {
        continue;
      }
      fanIn[edge] = (fanIn[edge] || 0) + 1;
    }
  }

  const findings = [];
  for (const [file, count] of Object.entries(fanOut)) {
    if (count < FAN_OUT_THRESHOLD) {
      continue;
    }
    findings.push(
      createFinding({
        tool: "coupling-analysis",
        kind: "code-quality.high-fan-out",
        severity: count >= FAN_OUT_THRESHOLD * 2 ? "P1" : "P2",
        file,
        line: 0,
        evidence: `fan-out = ${count} (threshold ${FAN_OUT_THRESHOLD})`,
        rootCause:
          "High fan-out: this module imports from many other modules, which is a sign it's doing too much and is brittle to downstream changes.",
        recommendedFix:
          "Split by responsibility. A Facade / Mediator can reduce the breadth of imports if the file is legitimately a coordinator.",
        confidence: 0.7,
      })
    );
  }
  for (const [file, count] of Object.entries(fanIn)) {
    if (count < FAN_IN_THRESHOLD) {
      continue;
    }
    findings.push(
      createFinding({
        tool: "coupling-analysis",
        kind: "code-quality.high-fan-in",
        severity: count >= FAN_IN_THRESHOLD * 2 ? "P1" : "P2",
        file,
        line: 0,
        evidence: `fan-in = ${count} (threshold ${FAN_IN_THRESHOLD})`,
        rootCause:
          "High fan-in: many modules depend on this file, so any behavior change risks a broad blast radius.",
        recommendedFix:
          "Stabilize the surface (consider making this module an interface / contract) and move implementation details behind it.",
        confidence: 0.65,
      })
    );
  }
  return findings;
}

export { FAN_IN_THRESHOLD, FAN_OUT_THRESHOLD };
