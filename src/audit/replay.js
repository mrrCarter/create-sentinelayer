import fsp from "node:fs/promises";
import path from "node:path";

function normalizeString(value) {
  return String(value || "").trim();
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function fingerprintFinding(finding = {}) {
  return [
    normalizeString(finding.severity).toUpperCase(),
    toPosixPath(finding.file),
    String(Number(finding.line || 0)),
    normalizeString(finding.message).toLowerCase(),
  ].join("|");
}

function collectFindings(report = {}) {
  const flattened = [];
  for (const agent of report.agentResults || []) {
    for (const finding of agent.findings || []) {
      flattened.push({
        severity: normalizeString(finding.severity).toUpperCase(),
        file: toPosixPath(finding.file),
        line: Number(finding.line || 0),
        message: normalizeString(finding.message),
        ruleId: normalizeString(finding.ruleId),
        ownerAgentId: agent.agentId,
      });
    }
  }
  return flattened;
}

function summaryDelta(base = {}, candidate = {}) {
  const keys = ["P0", "P1", "P2", "P3"];
  const delta = {};
  for (const key of keys) {
    delta[key] = Number(candidate[key] || 0) - Number(base[key] || 0);
  }
  delta.blockingChanged = Boolean(base.blocking) !== Boolean(candidate.blocking);
  return delta;
}

export function compareAuditReports(baseReport = {}, candidateReport = {}) {
  const baseFindings = collectFindings(baseReport);
  const candidateFindings = collectFindings(candidateReport);
  const baseByFingerprint = new Map(baseFindings.map((finding) => [fingerprintFinding(finding), finding]));
  const candidateByFingerprint = new Map(
    candidateFindings.map((finding) => [fingerprintFinding(finding), finding])
  );

  const added = [];
  const removed = [];

  for (const [fingerprint, finding] of candidateByFingerprint.entries()) {
    if (!baseByFingerprint.has(fingerprint)) {
      added.push(finding);
    }
  }
  for (const [fingerprint, finding] of baseByFingerprint.entries()) {
    if (!candidateByFingerprint.has(fingerprint)) {
      removed.push(finding);
    }
  }

  const deterministicEquivalent = added.length === 0 && removed.length === 0;
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    baseRunId: normalizeString(baseReport.runId),
    candidateRunId: normalizeString(candidateReport.runId),
    baseSummary: baseReport.summary || { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
    candidateSummary: candidateReport.summary || { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
    summaryDelta: summaryDelta(baseReport.summary || {}, candidateReport.summary || {}),
    baseFindingCount: baseFindings.length,
    candidateFindingCount: candidateFindings.length,
    addedCount: added.length,
    removedCount: removed.length,
    deterministicEquivalent,
    added: added.slice(0, 500),
    removed: removed.slice(0, 500),
  };
}

export async function writeAuditComparisonArtifact({
  baseReport = {},
  candidateReport = {},
  outputDirectory = "",
} = {}) {
  const resolvedOutputDirectory = path.resolve(String(outputDirectory || "."));
  const comparison = compareAuditReports(baseReport, candidateReport);
  const fileName = `AUDIT_COMPARISON_${comparison.baseRunId}_vs_${comparison.candidateRunId}.json`;
  const outputPath = path.join(resolvedOutputDirectory, fileName);
  await fsp.writeFile(outputPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf-8");
  return {
    comparison,
    outputPath,
  };
}
