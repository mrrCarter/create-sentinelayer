// cycle-detect — find import cycles in the module graph (#A16).
//
// Reuses findCycles() from src/coord/tarjan.js so we don't ship a second
// SCC implementation. Returns one Finding per cycle so the orchestrator
// can rank and prioritize; the cycle's component list is embedded in the
// finding's evidence + rootCause for review.

import path from "node:path";

import { findCycles } from "../../../coord/tarjan.js";

import { createFinding } from "./base.js";
import { buildDependencyGraph } from "./dep-graph.js";

export async function runCycleDetect({ rootPath, files = null, graph = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const dependencyGraph =
    graph && typeof graph === "object"
      ? graph
      : await buildDependencyGraph({ rootPath: resolvedRoot, files });

  // Strip npm:* nodes from the graph — they're sinks, not cycle participants.
  const localGraph = {};
  for (const [file, edges] of Object.entries(dependencyGraph)) {
    localGraph[file] = edges.filter((edge) => !edge.startsWith("npm:") && !edge.startsWith("/"));
  }

  const cycles = findCycles(localGraph);
  const findings = [];
  for (const cycle of cycles) {
    const primary = cycle.slice().sort()[0];
    findings.push(
      createFinding({
        tool: "cycle-detect",
        kind: "code-quality.import-cycle",
        severity: cycle.length > 3 ? "P1" : "P2",
        file: primary,
        line: 0,
        evidence: `Cycle of ${cycle.length} modules: ${cycle.join(" → ")}`,
        rootCause:
          "Import cycle forces the module loader to resolve modules out of order — causes TDZ errors, half-initialized exports, and refactor-proof coupling.",
        recommendedFix:
          "Break the cycle by extracting shared types / interfaces into a new module that both sides can depend on, or move the behavior that creates the back-edge into a callback injected at call time.",
        confidence: 0.85,
      })
    );
  }
  return findings;
}
