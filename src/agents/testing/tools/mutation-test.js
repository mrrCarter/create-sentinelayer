// mutation-test — check for mutation-testing configuration (#A15).
//
// Priya wants mutation testing (Stryker / pitest / mutmut) as the ceiling
// signal: do the tests actually assert anything, or is coverage a green
// but empty number? True mutation runs are expensive — this tool ships as
// a configuration check first (is Stryker wired up? is there an up-to-date
// report?). The LLM / operator can dispatch a real run from the resulting
// advisory.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix } from "./base.js";

const CONFIG_CANDIDATES = [
  "stryker.conf.js",
  "stryker.conf.cjs",
  "stryker.conf.mjs",
  "stryker.config.json",
  ".stryker-tmp",
  "setup.cfg", // Python mutmut section
  "mutmut_config.py",
  "pyproject.toml", // check for [tool.mutmut]
];

const REPORT_CANDIDATES = [
  "reports/mutation/mutation.html",
  "reports/mutation/mutation.json",
  "mutmut_results.json",
];

const REPORT_FRESH_DAYS = 30;

async function fileExists(fullPath) {
  try {
    const stat = await fsp.stat(fullPath);
    return { exists: true, mtimeMs: Number(stat.mtimeMs || 0) };
  } catch {
    return { exists: false };
  }
}

async function readTextIfExists(fullPath) {
  try {
    return await fsp.readFile(fullPath, "utf-8");
  } catch {
    return "";
  }
}

export async function runMutationTest({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const findings = [];

  // Config presence check
  let configFound = false;
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = path.join(resolvedRoot, candidate);
    const result = await fileExists(fullPath);
    if (result.exists) {
      if (candidate === "pyproject.toml" || candidate === "setup.cfg") {
        const text = await readTextIfExists(fullPath);
        if (!/\[tool\.mutmut\]|\[mutmut\]/.test(text)) {
          continue;
        }
      }
      configFound = true;
      break;
    }
  }

  if (!configFound) {
    findings.push(
      createFinding({
        tool: "mutation-test",
        kind: "testing.no-mutation-config",
        severity: "P3",
        file: toPosix("pyproject.toml"),
        line: 0,
        evidence: "No Stryker / mutmut / pitest configuration file found.",
        rootCause:
          "Without mutation testing, the test suite's assertions could be vacuous — 90% line coverage means nothing if the tests don't fail when the code changes.",
        recommendedFix:
          "Wire up @stryker-mutator/core (JS/TS) or mutmut (Python). Start with a single critical module and let the score guide new tests.",
        confidence: 0.5,
      })
    );
    return findings;
  }

  // Report freshness check
  let reportFound = false;
  let latestReport = 0;
  for (const candidate of REPORT_CANDIDATES) {
    const fullPath = path.join(resolvedRoot, candidate);
    const result = await fileExists(fullPath);
    if (result.exists) {
      reportFound = true;
      latestReport = Math.max(latestReport, result.mtimeMs);
    }
  }
  if (!reportFound) {
    findings.push(
      createFinding({
        tool: "mutation-test",
        kind: "testing.no-mutation-report",
        severity: "P3",
        file: toPosix("reports/mutation/"),
        line: 0,
        evidence: "Stryker / mutmut config present but no mutation report on disk.",
        rootCause:
          "Config without a report suggests mutation testing is configured but not actually run.",
        recommendedFix:
          "Wire a mutation run into CI on a cadence (weekly is reasonable) so drift in assertion quality is visible.",
        confidence: 0.55,
      })
    );
    return findings;
  }

  const ageDays = Math.floor((Date.now() - latestReport) / (24 * 60 * 60 * 1000));
  if (ageDays > REPORT_FRESH_DAYS) {
    findings.push(
      createFinding({
        tool: "mutation-test",
        kind: "testing.mutation-report-stale",
        severity: "P3",
        file: toPosix("reports/mutation/"),
        line: 0,
        evidence: `Latest mutation report is ${ageDays} days old (threshold ${REPORT_FRESH_DAYS})`,
        rootCause:
          "Stale mutation reports mean we're not actually watching assertion quality — drift goes undetected until it matters.",
        recommendedFix:
          "Schedule a recurring mutation job (weekly) and file an issue auto-generated from the diff vs. the prior run.",
        confidence: 0.55,
      })
    );
  }

  return findings;
}

export { CONFIG_CANDIDATES, REPORT_CANDIDATES, REPORT_FRESH_DAYS };
