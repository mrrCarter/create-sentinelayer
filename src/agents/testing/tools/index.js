// Priya (testing persona) domain-tool registry (#A15).

import { runCoverageGap } from "./coverage-gap.js";
import { runFlakeDetect } from "./flake-detect.js";
import { runMutationTest } from "./mutation-test.js";
import { runSnapshotDiff } from "./snapshot-diff.js";

export const TESTING_TOOLS = Object.freeze({
  "coverage-gap": {
    id: "coverage-gap",
    description:
      "Walk the repo and flag source files that have no matching test file under standard naming conventions (*.test.*, *.spec.*, test_*.py, __tests__/…).",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runCoverageGap,
  },
  "flake-detect": {
    id: "flake-detect",
    description:
      "Scan test files for flakiness smells: fixed-duration sleeps, wall-clock assertions, live network calls (fetch / axios / requests), unseeded randomness.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runFlakeDetect,
  },
  "snapshot-diff": {
    id: "snapshot-diff",
    description:
      "Walk *.snap / *.ambr files and flag stale (> 90 days untouched) or oversized (> 64 KiB) snapshots.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        staleDays: { type: "number" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runSnapshotDiff,
  },
  "mutation-test": {
    id: "mutation-test",
    description:
      "Configuration-check pass: verify Stryker / mutmut is wired up and the latest mutation report is fresh (< 30 days).",
    schema: {
      type: "object",
      properties: { rootPath: { type: "string" } },
    },
    handler: runMutationTest,
  },
});

export const TESTING_TOOL_IDS = Object.freeze(Object.keys(TESTING_TOOLS));

export async function dispatchTestingTool(toolId, args = {}) {
  const tool = TESTING_TOOLS[toolId];
  if (!tool) {
    throw new Error(`Unknown testing tool: ${toolId}`);
  }
  return tool.handler(args);
}

export async function runAllTestingTools({ rootPath, files = null } = {}) {
  const findings = [];
  for (const toolId of TESTING_TOOL_IDS) {
    const out = await dispatchTestingTool(toolId, { rootPath, files });
    findings.push(...out);
  }
  return findings;
}

export {
  runCoverageGap,
  runFlakeDetect,
  runMutationTest,
  runSnapshotDiff,
};
