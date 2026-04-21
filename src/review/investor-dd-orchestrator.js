/**
 * Investor-DD top-level orchestrator (#investor-dd-5 / -16 / -18).
 *
 * Wires the file router, per-persona runner, and streaming event sink
 * into a single entry point that the CLI `investor-dd` subcommand can
 * call. Produces an artifact bundle under `<outputDir>/investor-dd/`:
 *
 *   plan.json          — router output: { personaId: filesInScope[] }
 *   stream.ndjson      — full event stream from the run
 *   persona-<id>.json  — per-persona findings + coverage proof
 *   findings.json      — flat list across all personas (dedup in PR-29)
 *   summary.json       — run metadata (timings, cost, terminationReason)
 *   report.md          — human-readable summary
 *   manifest.json      — SHA-256 chain of every artifact
 *
 * The orchestrator is reproducible: given the same repo state + routing
 * rules, it produces the same artifacts and finding IDs. The LLM-driven
 * layer (PR-IDD-<TBD>) sits on top and only activates when --ai is passed.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { routeFilesToPersonas, summarizeRouting } from "./investor-dd-file-router.js";
import { runAllPersonas } from "./investor-dd-persona-runner.js";
import { createBudgetState } from "./investor-dd-file-loop.js";
import { resolveInvestorDdBudget, INVESTOR_DD_ARTIFACT_SUBDIR } from "./investor-dd-config.js";

const INVESTOR_DD_PERSONAS = Object.freeze([
  "security",
  "backend",
  "code-quality",
  "testing",
  "data-layer",
  "reliability",
  "release",
  "observability",
  "infrastructure",
  "supply-chain",
  "documentation",
  "ai-governance",
]);

/**
 * Walk the target repo and return a list of relative POSIX file paths.
 * Skips common noise directories.
 */
async function walkRepoFiles(rootPath) {
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".sentinelayer",
    ".next",
    ".turbo",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
  ]);
  const SKIP_EXT = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svg",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".mp4",
    ".webm",
    ".woff",
    ".woff2",
    ".ttf",
  ]);

  const results = [];
  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && !entry.name.startsWith(".github")) {
        if (entry.name !== ".gitignore" && entry.name !== ".env.example") continue;
      }
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(absPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        results.push(relPath);
      }
    }
  }
  await walk(rootPath, "");
  return results;
}

async function writeJson(filePath, obj) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Emit a summary markdown report. The detailed HTML/PDF variants are
 * separate PRs (PR-IDD-18 follow-ups).
 */
function buildSummaryMarkdown({ runId, summary, routing, byPersona }) {
  const lines = [];
  lines.push(`# Investor-DD Report — ${runId}`);
  lines.push("");
  lines.push(`Generated: ${summary.startedAt}`);
  lines.push(`Duration: ${summary.durationSeconds.toFixed(1)}s`);
  lines.push(`Status: ${summary.terminationReason}`);
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push("| Persona | Files routed | Files visited | Findings |");
  lines.push("|---|---:|---:|---:|");
  for (const personaId of INVESTOR_DD_PERSONAS) {
    const record = byPersona[personaId] || {};
    const routed = (routing[personaId] || []).length;
    const visited = Array.isArray(record.visited) ? record.visited.length : 0;
    const findings = Array.isArray(record.findings) ? record.findings.length : 0;
    lines.push(`| ${personaId} | ${routed} | ${visited} | ${findings} |`);
  }
  lines.push("");
  lines.push("## Findings summary");
  lines.push("");
  const allFindings = Object.values(byPersona).flatMap((r) => r.findings || []);
  const bySev = {};
  for (const f of allFindings) {
    const sev = f.severity || "UNKNOWN";
    bySev[sev] = (bySev[sev] || 0) + 1;
  }
  for (const [sev, count] of Object.entries(bySev)) {
    lines.push(`- **${sev}**: ${count}`);
  }
  lines.push("");
  lines.push(`Total: ${allFindings.length}`);
  return lines.join("\n");
}

/**
 * Run the investor-DD orchestration end to end.
 *
 * @param {object} params
 * @param {string} params.rootPath
 * @param {string} [params.outputDir]        - Defaults to `<rootPath>/.sentinelayer/runs/<runId>`.
 * @param {object} [params.budgetOptions]    - Overrides from CLI: { maxUsd, maxRuntimeMinutes, maxParallel }.
 * @param {string[]} [params.personas]       - Override persona list; defaults to all 12.
 * @param {Function} [params.onEvent]        - Extra event sink (NDJSON stream is always written).
 * @param {boolean} [params.dryRun]          - If true, skip tool execution, emit plan.json + stub report only.
 * @returns {Promise<{runId: string, artifactDir: string, summary: object}>}
 */
export async function runInvestorDd({
  rootPath,
  outputDir = "",
  budgetOptions = {},
  personas = INVESTOR_DD_PERSONAS,
  onEvent = () => {},
  dryRun = false,
} = {}) {
  if (!rootPath) throw new TypeError("runInvestorDd requires rootPath");

  const runId = `investor-dd-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const resolvedBudget = resolveInvestorDdBudget(budgetOptions);
  const artifactBase = outputDir
    ? path.resolve(outputDir, runId, INVESTOR_DD_ARTIFACT_SUBDIR)
    : path.resolve(rootPath, ".sentinelayer", "runs", runId, INVESTOR_DD_ARTIFACT_SUBDIR);
  await fsp.mkdir(artifactBase, { recursive: true });

  const streamPath = path.join(artifactBase, "stream.ndjson");
  const streamHandle = await fsp.open(streamPath, "w");

  const emit = (event) => {
    const enriched = { ...event, at: new Date().toISOString(), runId };
    streamHandle.write(`${JSON.stringify(enriched)}\n`).catch(() => {});
    try {
      onEvent(enriched);
    } catch {
      // external sinks never break the run
    }
  };

  const startTime = Date.now();
  emit({ type: "investor_dd_start", rootPath, personas });

  const files = await walkRepoFiles(rootPath);
  emit({ type: "investor_dd_files_discovered", totalFiles: files.length });

  const routing = routeFilesToPersonas({ files, personas });
  const routingSummary = summarizeRouting(routing);
  await writeJson(path.join(artifactBase, "plan.json"), {
    runId,
    rootPath,
    personas,
    routing,
    routingSummary,
    budget: resolvedBudget,
  });

  let byPersona = {};
  let findings = [];
  let terminationReason = "ok";

  if (!dryRun) {
    const budgetState = createBudgetState({
      maxUsd: resolvedBudget.maxCostUsd,
      maxRuntimeMs: resolvedBudget.maxRuntimeMinutes * 60_000,
    });
    const runResult = await runAllPersonas({
      routing,
      rootPath,
      budget: budgetState,
      onEvent: emit,
    });
    byPersona = runResult.byPersona;
    findings = runResult.findings;
    terminationReason = runResult.terminationReason;

    await writeJson(path.join(artifactBase, "findings.json"), findings);
    for (const [personaId, record] of Object.entries(byPersona)) {
      await writeJson(path.join(artifactBase, `persona-${personaId}.json`), record);
    }
  } else {
    emit({ type: "investor_dd_dry_run" });
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  const summary = {
    runId,
    startedAt: new Date(startTime).toISOString(),
    durationSeconds,
    terminationReason,
    totalFiles: files.length,
    totalFindings: findings.length,
    personas,
    budget: resolvedBudget,
    dryRun,
  };
  await writeJson(path.join(artifactBase, "summary.json"), summary);

  const markdown = buildSummaryMarkdown({ runId, summary, routing, byPersona });
  const reportPath = path.join(artifactBase, "report.md");
  await fsp.writeFile(reportPath, markdown, "utf-8");

  emit({
    type: "investor_dd_complete",
    totalFindings: findings.length,
    durationSeconds,
    terminationReason,
  });
  await streamHandle.close();

  const artifactFiles = await fsp.readdir(artifactBase);
  const manifest = {};
  for (const file of artifactFiles) {
    const abs = path.join(artifactBase, file);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) continue;
    const contents = await fsp.readFile(abs);
    manifest[file] = {
      sha256: sha256(contents),
      bytes: stat.size,
    };
  }
  await writeJson(path.join(artifactBase, "manifest.json"), manifest);

  return { runId, artifactDir: artifactBase, summary };
}
