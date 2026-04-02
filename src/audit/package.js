import fsp from "node:fs/promises";
import path from "node:path";

function normalizeString(value) {
  return String(value || "").trim();
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeRunDirectory(runDirectory) {
  const normalized = normalizeString(runDirectory);
  if (!normalized) {
    throw new Error("runDirectory is required for DD package generation.");
  }
  return path.resolve(normalized);
}

function buildFindingsIndex(report = {}) {
  const seen = new Set();
  const indexed = [];
  for (const agent of report.agentResults || []) {
    for (const finding of agent.findings || []) {
      const key = `${toPosixPath(finding.file)}:${finding.line}:${normalizeString(
        finding.message
      ).toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      indexed.push({
        findingId: `DD-${String(indexed.length + 1).padStart(4, "0")}`,
        severity: finding.severity,
        file: toPosixPath(finding.file),
        line: finding.line,
        message: finding.message,
        ruleId: finding.ruleId || "",
        suggestedFix: finding.suggestedFix || "",
        ownerAgentId: agent.agentId,
      });
    }
  }
  return indexed.slice(0, 500);
}

function buildExecutiveSummaryMarkdown({ report, manifest, findingsIndex }) {
  const topFindings = findingsIndex
    .slice(0, 20)
    .map((item) => `- [${item.severity}] ${item.file}:${item.line} ${item.message}`)
    .join("\n");

  return `# DD_EXEC_SUMMARY

Generated: ${manifest.generatedAt}
Run ID: ${manifest.runId}
Target: ${manifest.targetPath}

Overall findings:
- P0=${manifest.summary.P0}
- P1=${manifest.summary.P1}
- P2=${manifest.summary.P2}
- P3=${manifest.summary.P3}
- Blocking: ${manifest.summary.blocking ? "yes" : "no"}

Agent coverage:
${(manifest.agents || [])
  .map(
    (agent) =>
      `- ${agent.agentId} (${agent.persona}, ${agent.domain}) findings=${agent.findingCount} status=${agent.status}`
  )
  .join("\n")}

Deterministic baseline:
- Run ID: ${manifest.deterministicBaseline.runId || "n/a"}
- Summary: P0=${manifest.deterministicBaseline.summary.P0} P1=${manifest.deterministicBaseline.summary.P1} P2=${manifest.deterministicBaseline.summary.P2} P3=${manifest.deterministicBaseline.summary.P3}
- Report: ${manifest.deterministicBaseline.reportPath || "n/a"}

Top findings index:
${topFindings || "- none"}

Package artifacts:
- manifest: ${path.join(report.runDirectory, "DD_PACKAGE_MANIFEST.json")}
- findings index: ${path.join(report.runDirectory, "DD_FINDINGS_INDEX.json")}
- executive summary: ${path.join(report.runDirectory, "DD_EXEC_SUMMARY.md")}
`;
}

export function buildDdPackageManifest(report = {}) {
  const findingsIndex = buildFindingsIndex(report);
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    runId: report.runId || "",
    targetPath: report.targetPath || "",
    runDirectory: report.runDirectory || "",
    summary: report.summary || { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
    deterministicBaseline: {
      runId: report.deterministicBaseline?.runId || "",
      reportPath: report.deterministicBaseline?.reportPath || "",
      reportJsonPath: report.deterministicBaseline?.reportJsonPath || "",
      summary: report.deterministicBaseline?.summary || { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
    },
    ingest: report.ingest || {},
    agents: (report.agentResults || []).map((agent) => ({
      agentId: agent.agentId,
      persona: agent.persona,
      domain: agent.domain,
      status: agent.status,
      findingCount: agent.findingCount,
      confidence: agent.confidence,
      artifactPath: agent.artifactPath || "",
      specialistReportPath: agent.specialistReportPath || "",
    })),
    findingsIndexCount: findingsIndex.length,
  };
}

export async function writeDdPackage({ report = {}, runDirectory } = {}) {
  const resolvedRunDirectory = normalizeRunDirectory(runDirectory || report.runDirectory);
  const manifest = buildDdPackageManifest({
    ...report,
    runDirectory: resolvedRunDirectory,
  });
  const findingsIndex = buildFindingsIndex({
    ...report,
    runDirectory: resolvedRunDirectory,
  });
  const manifestPath = path.join(resolvedRunDirectory, "DD_PACKAGE_MANIFEST.json");
  const findingsIndexPath = path.join(resolvedRunDirectory, "DD_FINDINGS_INDEX.json");
  const executiveSummaryPath = path.join(resolvedRunDirectory, "DD_EXEC_SUMMARY.md");
  const executiveSummary = buildExecutiveSummaryMarkdown({
    report: {
      ...report,
      runDirectory: resolvedRunDirectory,
    },
    manifest,
    findingsIndex,
  });

  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  await fsp.writeFile(findingsIndexPath, `${JSON.stringify(findingsIndex, null, 2)}\n`, "utf-8");
  await fsp.writeFile(executiveSummaryPath, `${executiveSummary.trim()}\n`, "utf-8");

  return {
    manifest,
    findingsIndexCount: findingsIndex.length,
    manifestPath,
    findingsIndexPath,
    executiveSummaryPath,
  };
}

export async function loadAuditRunReport(runDirectory) {
  const resolvedRunDirectory = normalizeRunDirectory(runDirectory);
  const reportPath = path.join(resolvedRunDirectory, "AUDIT_REPORT.json");
  const raw = await fsp.readFile(reportPath, "utf-8");
  const report = JSON.parse(raw);
  return {
    report,
    reportPath,
    runDirectory: resolvedRunDirectory,
  };
}

export async function resolveAuditRunDirectory({ outputRoot, runId = "" } = {}) {
  const normalizedOutputRoot = path.resolve(String(outputRoot || "."));
  const auditsDirectory = path.join(normalizedOutputRoot, "audits");
  const requestedRunId = normalizeString(runId);

  if (requestedRunId) {
    const requestedDirectory = path.join(auditsDirectory, requestedRunId);
    await fsp.access(path.join(requestedDirectory, "AUDIT_REPORT.json"));
    return requestedDirectory;
  }

  const entries = await fsp.readdir(auditsDirectory, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (candidates.length === 0) {
    throw new Error("No audit runs found to package.");
  }

  const withMtime = [];
  for (const candidate of candidates) {
    const candidateDirectory = path.join(auditsDirectory, candidate);
    const reportPath = path.join(candidateDirectory, "AUDIT_REPORT.json");
    try {
      const stat = await fsp.stat(reportPath);
      withMtime.push({
        candidateDirectory,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Ignore directories without a report artifact.
    }
  }

  if (withMtime.length === 0) {
    throw new Error("No valid audit run reports found under output root.");
  }

  withMtime.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return withMtime[0].candidateDirectory;
}
