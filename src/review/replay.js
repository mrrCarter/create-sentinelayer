import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export const REVIEW_RUN_CONTEXT_FILE = "REVIEW_RUN_CONTEXT.json";

function normalizeString(value) {
  return String(value || "").trim();
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return "";
  }
  return normalizeString(result.stdout);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function parseGitDirtyFiles(rawStatus = "") {
  const lines = String(rawStatus || "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const files = [];
  for (const line of lines) {
    if (line.length < 4) {
      continue;
    }
    const candidate = line.slice(3).trim();
    if (candidate) {
      files.push(normalizePath(candidate));
    }
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

export function collectGitState(targetPath) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const commitSha = runGit(normalizedTargetPath, ["rev-parse", "HEAD"]);
  const branch = runGit(normalizedTargetPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirtyRaw = runGit(normalizedTargetPath, ["status", "--porcelain"]);
  const dirtyFiles = parseGitDirtyFiles(dirtyRaw);
  return {
    commitSha,
    branch,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}

function normalizeInvocation(invocation = {}) {
  return {
    aiEnabled: Boolean(invocation.aiEnabled),
    aiDryRun: Boolean(invocation.aiDryRun),
    provider: normalizeString(invocation.provider),
    model: normalizeString(invocation.model),
    sessionId: normalizeString(invocation.sessionId),
    aiMaxFindings: normalizeString(invocation.aiMaxFindings) || "20",
    maxCost: normalizeString(invocation.maxCost) || "1.0",
    maxTokens: normalizeString(invocation.maxTokens) || "0",
    maxRuntimeMs: normalizeString(invocation.maxRuntimeMs) || "0",
    maxToolCalls: normalizeString(invocation.maxToolCalls) || "0",
    maxNoProgress: normalizeString(invocation.maxNoProgress) || "3",
    warnAtPercent: normalizeString(invocation.warnAtPercent) || "80",
    outputDir: normalizeString(invocation.outputDir),
  };
}

export async function writeReviewRunContext({
  runDirectory,
  runId,
  targetPath,
  mode,
  invocation = {},
  replay = {},
} = {}) {
  const normalizedRunDirectory = path.resolve(String(runDirectory || "."));
  const context = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    runId: normalizeString(runId),
    targetPath: path.resolve(String(targetPath || ".")),
    mode: normalizeString(mode) || "full",
    invocation: normalizeInvocation(invocation),
    gitState: collectGitState(targetPath),
    replay: {
      sourceRunId: normalizeString(replay.sourceRunId),
      replayed: Boolean(replay.replayed),
    },
  };
  const contextPath = path.join(normalizedRunDirectory, REVIEW_RUN_CONTEXT_FILE);
  await fsp.mkdir(normalizedRunDirectory, { recursive: true });
  await fsp.writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf-8");
  return {
    context,
    contextPath,
  };
}

export async function loadReviewRunContext(runDirectory) {
  const normalizedRunDirectory = path.resolve(String(runDirectory || "."));
  const contextPath = path.join(normalizedRunDirectory, REVIEW_RUN_CONTEXT_FILE);
  const context = JSON.parse(await fsp.readFile(contextPath, "utf-8"));
  return {
    context,
    contextPath,
  };
}

function fingerprintFinding(finding = {}) {
  return [
    normalizePath(finding.file),
    String(Number(finding.line || 1)),
    normalizeString(finding.message).toLowerCase().replace(/\s+/g, " "),
  ].join("|");
}

export function compareUnifiedReports(baseReport = {}, candidateReport = {}) {
  const leftFindings = Array.isArray(baseReport.findings) ? baseReport.findings : [];
  const rightFindings = Array.isArray(candidateReport.findings) ? candidateReport.findings : [];

  const leftMap = new Map();
  for (const finding of leftFindings) {
    leftMap.set(fingerprintFinding(finding), finding);
  }
  const rightMap = new Map();
  for (const finding of rightFindings) {
    rightMap.set(fingerprintFinding(finding), finding);
  }

  const added = [];
  const removed = [];
  const severityChanged = [];

  for (const [fingerprint, finding] of rightMap.entries()) {
    const existing = leftMap.get(fingerprint);
    if (!existing) {
      added.push({
        fingerprint,
        findingId: finding.findingId,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        message: finding.message,
      });
      continue;
    }
    if (normalizeString(existing.severity) !== normalizeString(finding.severity)) {
      severityChanged.push({
        fingerprint,
        findingId: finding.findingId,
        fromSeverity: existing.severity,
        toSeverity: finding.severity,
        file: finding.file,
        line: finding.line,
        message: finding.message,
      });
    }
  }

  for (const [fingerprint, finding] of leftMap.entries()) {
    if (!rightMap.has(fingerprint)) {
      removed.push({
        fingerprint,
        findingId: finding.findingId,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        message: finding.message,
      });
    }
  }

  const baseSummary = baseReport.summary || {};
  const candidateSummary = candidateReport.summary || {};
  const summaryDelta = {
    P0: Number(candidateSummary.P0 || 0) - Number(baseSummary.P0 || 0),
    P1: Number(candidateSummary.P1 || 0) - Number(baseSummary.P1 || 0),
    P2: Number(candidateSummary.P2 || 0) - Number(baseSummary.P2 || 0),
    P3: Number(candidateSummary.P3 || 0) - Number(baseSummary.P3 || 0),
  };
  summaryDelta.blockingChanged = Boolean(baseSummary.blocking) !== Boolean(candidateSummary.blocking);

  return {
    deterministicEquivalent:
      added.length === 0 && removed.length === 0 && severityChanged.length === 0,
    counts: {
      added: added.length,
      removed: removed.length,
      severityChanged: severityChanged.length,
    },
    summaryDelta,
    added,
    removed,
    severityChanged,
  };
}

function sanitizeRunId(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function writeReviewComparisonArtifact({
  runDirectory,
  baseRunId,
  candidateRunId,
  comparison,
} = {}) {
  const normalizedRunDirectory = path.resolve(String(runDirectory || "."));
  const fileName = `REVIEW_COMPARISON_${sanitizeRunId(baseRunId)}_vs_${sanitizeRunId(
    candidateRunId
  )}.json`;
  const artifactPath = path.join(normalizedRunDirectory, fileName);
  const payload = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    baseRunId: normalizeString(baseRunId),
    candidateRunId: normalizeString(candidateRunId),
    comparison,
  };
  await fsp.mkdir(normalizedRunDirectory, { recursive: true });
  await fsp.writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return {
    artifactPath,
    payload,
  };
}

