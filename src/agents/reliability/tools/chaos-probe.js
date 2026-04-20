// chaos-probe — verify that chaos testing / fault injection exists (#A18).
//
// Production-grade services should exercise failure paths, not just happy
// paths. We look for signals that chaos-style tests are wired up:
// - JS: chaos-monkey-js, gremlin, LitmusChaos configs
// - Python: chaostoolkit config or chaos_engineering markers
// - General: test files with `inject_failure` / `kill_dependency` /
//   `simulate_outage` shapes
// Absence on a repo that has more than a handful of outbound deps → P3 advisory.

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
  ".yaml",
  ".yml",
]);

const CHAOS_SIGNALS = [
  /chaos[-_]?monkey/i,
  /litmus(chaos)?/i,
  /gremlin\.(?:io|engine)/i,
  /chaostoolkit|chaos_toolkit/i,
  /@fault_injection|fault_injection\(/,
  /simulate[_-]outage|inject[_-]failure|kill[_-]dependency/i,
  /(^|\/)chaos\/[^/]+\.(yml|yaml|json)$/,
];

const OUTBOUND_SIGNALS = [
  /\bfetch\s*\(/,
  /\baxios(?:\.[a-z]+)?\s*\(/,
  /\brequests\.(?:get|post|put|patch|delete|request)\s*\(/,
  /\bhttpx\.(?:get|post|put|patch|delete|request)\s*\(/,
];

export async function runChaosProbe({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  let foundChaos = false;
  const outboundFiles = new Set();
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    if (CHAOS_SIGNALS.some((p) => p.test(content) || p.test(toPosix(relativePath)))) {
      foundChaos = true;
      // Don't break — continue tallying outbound files so we still produce
      // an accurate summary if requested elsewhere.
    }
    if (OUTBOUND_SIGNALS.some((p) => p.test(content))) {
      outboundFiles.add(toPosix(relativePath));
    }
  }

  const findings = [];
  // Only advise when the repo actually talks to anything outside — a pure
  // library without outbound deps doesn't need chaos.
  if (!foundChaos && outboundFiles.size >= 3) {
    findings.push(
      createFinding({
        tool: "chaos-probe",
        kind: "reliability.no-chaos-testing",
        severity: "P3",
        file: "",
        line: 0,
        evidence: `${outboundFiles.size} file(s) make outbound HTTP calls, no chaos-testing signals found`,
        rootCause:
          "Services with multiple external dependencies can fail in novel ways that happy-path tests miss. Absent fault injection / chaos testing means those modes will first surface in production.",
        recommendedFix:
          "Wire up chaostoolkit (Python) or chaos-monkey-js (Node) with scenarios for each critical dependency (DB, payment processor, auth provider). Run weekly in staging.",
        confidence: 0.45,
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
