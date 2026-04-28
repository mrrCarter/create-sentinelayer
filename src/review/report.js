import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";

const REVIEW_REPORT_JSON = "REVIEW_REPORT.json";
const REVIEW_REPORT_MD = "REVIEW_REPORT.md";
const REVIEW_DECISIONS_JSON = "REVIEW_DECISIONS.json";

const SEVERITY_RANK = Object.freeze({
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
});

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSeverity(value) {
  const normalized = normalizeString(value).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(SEVERITY_RANK, normalized)) {
    return normalized;
  }
  return "P3";
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
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

function runToolVersion(command, args = []) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return "";
  }
  return normalizeString(result.stdout || result.stderr);
}

function formatConfidence(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return 0.6;
  }
  return Math.max(0, Math.min(1, normalized));
}

function normalizeConfidenceFloor(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return 0.7;
  }
  return Math.max(0, Math.min(1, normalized));
}

function confidenceFloorForFinding(finding = {}, {
  source = "ai",
  confidenceFloors = {},
  defaultConfidenceFloor = 0.7,
} = {}) {
  const persona = normalizeString(finding.persona || finding.personaId || finding.agentId);
  const layer = normalizeString(finding.layer);
  const identity = sourceIdentityForFinding(finding, source);
  const floor =
    finding.confidenceFloor ??
    finding.personaConfidenceFloor ??
    confidenceFloors[identity] ??
    confidenceFloors[persona] ??
    confidenceFloors[layer] ??
    confidenceFloors[source] ??
    defaultConfidenceFloor;
  return normalizeConfidenceFloor(floor);
}

function sourceIdentityForFinding(finding = {}, source = "ai") {
  if (source === "deterministic") {
    return "deterministic";
  }
  const persona = normalizeString(
    finding.persona || finding.personaId || finding.agentId || finding.layer
  );
  return `ai:${persona || "generic"}`;
}

function hasMultiSourceConfirmation(finding = {}) {
  const confirmationSources = Array.isArray(finding.confirmationSources)
    ? finding.confirmationSources
    : [];
  const sourceIdentities = confirmationSources.length > 0
    ? confirmationSources
    : (Array.isArray(finding.sources) ? finding.sources : []);
  return new Set(sourceIdentities.filter(Boolean)).size >= 2;
}

function dedupeKeyForFinding(finding = {}) {
  const file = toPosixPath(normalizeString(finding.file) || "unknown");
  const line = Number(finding.line || 1);
  const message = normalizeString(finding.message).toLowerCase().replace(/\s+/g, " ");
  return `${file}:${line}:${message}`;
}

function compareFindingPriority(left, right) {
  const leftSeverity = normalizeSeverity(left.severity);
  const rightSeverity = normalizeSeverity(right.severity);
  const severityDelta = SEVERITY_RANK[leftSeverity] - SEVERITY_RANK[rightSeverity];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const leftConfidence = formatConfidence(left.confidence);
  const rightConfidence = formatConfidence(right.confidence);
  if (leftConfidence > rightConfidence) {
    return -1;
  }
  if (leftConfidence < rightConfidence) {
    return 1;
  }
  return 0;
}

function summarizeFindings(findings = []) {
  const summary = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  for (const finding of findings) {
    summary[normalizeSeverity(finding.severity)] += 1;
  }
  return {
    ...summary,
    blocking: summary.P0 > 0 || summary.P1 > 0,
  };
}

export function dropBelowConfidence(findings = [], { threshold = 0.7 } = {}) {
  const defaultThreshold = normalizeConfidenceFloor(threshold);
  const kept = [];
  const dropped = [];

  for (const finding of findings || []) {
    const confidence = formatConfidence(finding.confidence);
    const confidenceFloor = normalizeConfidenceFloor(
      finding.confidenceFloor ?? finding.personaConfidenceFloor ?? defaultThreshold
    );
    if (!hasMultiSourceConfirmation(finding) && confidence < confidenceFloor) {
      dropped.push({
        ...finding,
        confidence,
        confidenceFloor,
        droppedReason: "below_confidence_floor_single_source",
      });
      continue;
    }
    kept.push({
      ...finding,
      confidence,
      confidenceFloor,
    });
  }

  return {
    findings: kept,
    dropped,
    droppedCount: dropped.length,
    threshold: defaultThreshold,
  };
}

export function reconcileReviewFindings({
  deterministicFindings = [],
  aiFindings = [],
  confidenceFloor = 0.7,
  defaultConfidenceFloor = confidenceFloor,
  confidenceFloors = {},
} = {}) {
  const merged = new Map();
  const normalizedDefaultConfidenceFloor = normalizeConfidenceFloor(defaultConfidenceFloor);

  const addFinding = (finding, source) => {
    const persona = normalizeString(finding.persona || finding.personaId || finding.agentId);
    const confidenceFloorForSource = confidenceFloorForFinding(finding, {
      source,
      confidenceFloors,
      defaultConfidenceFloor: normalizedDefaultConfidenceFloor,
    });
    const normalized = {
      findingId: "",
      severity: normalizeSeverity(finding.severity),
      file: toPosixPath(normalizeString(finding.file) || "unknown"),
      line: Math.max(1, Math.floor(Number(finding.line || 1))),
      message: normalizeString(finding.message) || "Unnamed finding",
      excerpt: normalizeString(finding.excerpt),
      ruleId: normalizeString(finding.ruleId),
      suggestedFix: normalizeString(finding.suggestedFix),
      persona,
      layer: normalizeString(finding.layer),
      confidence: source === "deterministic" ? 1 : formatConfidence(finding.confidence),
      confidenceFloor: confidenceFloorForSource,
      sources: [source],
      confirmationSources: [sourceIdentityForFinding(finding, source)],
      adjudication: {
        verdict: "pending",
        note: "",
        timestamp: "",
        actor: "",
      },
    };
    const key = dedupeKeyForFinding(normalized);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, normalized);
      return;
    }

    const nextSources = new Set([...(existing.sources || []), source]);
    const nextConfirmationSources = new Set([
      ...(existing.confirmationSources || []),
      ...(normalized.confirmationSources || []),
    ]);
    const preferred = compareFindingPriority(existing, normalized) <= 0 ? existing : normalized;
    preferred.sources = [...nextSources].sort((left, right) => left.localeCompare(right));
    preferred.confirmationSources = [...nextConfirmationSources].sort((left, right) =>
      left.localeCompare(right)
    );
    preferred.confidenceFloor = Math.max(
      normalizeConfidenceFloor(existing.confidenceFloor),
      normalizeConfidenceFloor(normalized.confidenceFloor)
    );
    if (!preferred.persona) {
      preferred.persona = existing.persona || normalized.persona;
    }
    if (!preferred.layer) {
      preferred.layer = existing.layer || normalized.layer;
    }
    if (!preferred.excerpt) {
      preferred.excerpt = existing.excerpt || normalized.excerpt;
    }
    if (!preferred.ruleId) {
      preferred.ruleId = existing.ruleId || normalized.ruleId;
    }
    if (!preferred.suggestedFix) {
      preferred.suggestedFix = existing.suggestedFix || normalized.suggestedFix;
    }
    merged.set(key, preferred);
  };

  for (const finding of deterministicFindings) {
    addFinding(finding, "deterministic");
  }
  for (const finding of aiFindings) {
    addFinding(finding, "ai");
  }

  const confidenceFilter = dropBelowConfidence([...merged.values()], {
    threshold: normalizedDefaultConfidenceFloor,
  });
  const findings = confidenceFilter.findings.sort((left, right) => {
    const severityDelta = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    const fileDelta = left.file.localeCompare(right.file);
    if (fileDelta !== 0) {
      return fileDelta;
    }
    return left.line - right.line;
  });

  findings.forEach((finding, index) => {
    finding.findingId = `F-${String(index + 1).padStart(3, "0")}`;
  });

  return {
    findings,
    droppedFindings: confidenceFilter.dropped,
    summary: {
      ...summarizeFindings(findings),
      confidenceFloor: confidenceFilter.threshold,
      droppedBelowConfidence: confidenceFilter.droppedCount,
      droppedBelowConfidenceSingleSource: confidenceFilter.droppedCount,
    },
  };
}

async function resolveSpecMetadata(targetPath, specFile = "") {
  const explicitSpecFile = normalizeString(specFile);
  const candidates = [];
  if (explicitSpecFile) {
    candidates.push(path.resolve(targetPath, explicitSpecFile));
  }
  candidates.push(path.join(targetPath, "SPEC.md"), path.join(targetPath, "docs", "spec.md"));
  for (const candidate of candidates) {
    try {
      const text = await fsp.readFile(candidate, "utf-8");
      const hash = createHash("sha256").update(text).digest("hex");
      return {
        path: candidate,
        sha256: hash,
      };
    } catch {
      continue;
    }
  }
  return {
    path: "",
    sha256: "",
  };
}

function buildSeverityMatrix() {
  return {
    P0: "blocks merge",
    P1: "critical; fix before release",
    P2: "warning; schedule remediation",
    P3: "informational",
  };
}

function buildSWEVerdictTemplate() {
  return {
    truthVerdict: "pending",
    severityVerdict: "pending",
    reproducibilityVerdict: "pending",
    remediationUsefulnessScore: null,
  };
}

function composeReportMarkdown(report = {}) {
  const findingLines =
    report.findings.length > 0
      ? report.findings
          .map(
            (finding, index) =>
              `${index + 1}. [${finding.severity}] ${finding.findingId} ${finding.file}:${finding.line} ${finding.message}\n` +
              `   confidence: ${(formatConfidence(finding.confidence) * 100).toFixed(0)}%\n` +
              `   sources: ${(finding.sources || []).join(", ") || "none"}\n` +
              `   verdict: ${finding.adjudication?.verdict || "pending"}\n` +
              `   suggested_fix: ${finding.suggestedFix || "Review and remediate as needed."}`
          )
          .join("\n")
      : "- none";

  return [
    "# REVIEW_REPORT",
    "",
    `Generated: ${report.generatedAt}`,
    `Run ID: ${report.runId}`,
    `Mode: ${report.mode}`,
    "",
    "Summary:",
    `- Findings: P0=${report.summary.P0} P1=${report.summary.P1} P2=${report.summary.P2} P3=${report.summary.P3}`,
    `- Blocking: ${report.summary.blocking ? "yes" : "no"}`,
    `- Total findings: ${report.findings.length}`,
    `- Dropped below confidence floor (single-source): ${report.summary.droppedBelowConfidence || 0}`,
    "",
    "Metadata:",
    `- commit_sha: ${report.metadata.git.commitSha || "unknown"}`,
    `- branch: ${report.metadata.git.branch || "unknown"}`,
    `- dirty: ${report.metadata.git.dirty ? "yes" : "no"}`,
    `- spec_sha256: ${report.metadata.spec.sha256 || "unknown"}`,
    `- model: ${report.metadata.ai.model || "none"}`,
    `- provider: ${report.metadata.ai.provider || "none"}`,
    `- temperature: ${report.metadata.ai.temperature === null ? "n/a" : report.metadata.ai.temperature}`,
    `- node_version: ${report.metadata.tools.node}`,
    "",
    "Severity matrix:",
    `- P0: ${report.severityMatrix.P0}`,
    `- P1: ${report.severityMatrix.P1}`,
    `- P2: ${report.severityMatrix.P2}`,
    `- P3: ${report.severityMatrix.P3}`,
    "",
    "Findings:",
    findingLines,
    "",
  ].join("\n");
}

export async function buildUnifiedReviewReport({
  targetPath,
  mode,
  runId,
  deterministic,
  aiLayer = null,
  specFile = "",
  defaultConfidenceFloor = 0.7,
  confidenceFloors = {},
} = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedMode = normalizeString(mode) || "full";
  const normalizedRunId = normalizeString(runId) || "review-report";
  const generatedAt = new Date().toISOString();

  const reconciliation = reconcileReviewFindings({
    deterministicFindings: deterministic?.findings || [],
    aiFindings: aiLayer?.findings || [],
    defaultConfidenceFloor,
    confidenceFloors,
  });
  const spec = await resolveSpecMetadata(normalizedTargetPath, specFile);
  const commitSha = runGit(normalizedTargetPath, ["rev-parse", "HEAD"]);
  const branch = runGit(normalizedTargetPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = normalizeString(runGit(normalizedTargetPath, ["status", "--porcelain"])).length > 0;

  const report = {
    schemaVersion: "1.0.0",
    generatedAt,
    targetPath: normalizedTargetPath,
    runId: normalizedRunId,
    mode: normalizedMode,
    summary: reconciliation.summary,
    findings: reconciliation.findings,
    droppedFindings: reconciliation.droppedFindings,
    severityMatrix: buildSeverityMatrix(),
    metadata: {
      git: {
        commitSha,
        branch,
        dirty,
      },
      spec,
      ai: {
        provider: aiLayer?.provider || "",
        model: aiLayer?.model || "",
        temperature: null,
        dryRun: Boolean(aiLayer?.dryRun),
      },
      tools: {
        node: process.version,
        npm: runToolVersion("npm", ["--version"]) || "unknown",
        git: runToolVersion("git", ["--version"]) || "unknown",
        platform: `${os.platform()}-${os.arch()}`,
      },
      sweFrameworkM2: buildSWEVerdictTemplate(),
      timestamps: {
        deterministicGeneratedAt: deterministic?.generatedAt || "",
        aiGeneratedAt: aiLayer ? generatedAt : "",
      },
    },
  };

  return {
    report,
    markdown: composeReportMarkdown(report),
  };
}

export async function writeUnifiedReviewArtifacts({
  runDirectory,
  report,
  markdown,
} = {}) {
  const normalizedRunDirectory = path.resolve(String(runDirectory || "."));
  await fsp.mkdir(normalizedRunDirectory, { recursive: true });
  const reportJsonPath = path.join(normalizedRunDirectory, REVIEW_REPORT_JSON);
  const reportMarkdownPath = path.join(normalizedRunDirectory, REVIEW_REPORT_MD);
  await fsp.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fsp.writeFile(reportMarkdownPath, `${String(markdown || "").trim()}\n`, "utf-8");
  return {
    reportJsonPath,
    reportMarkdownPath,
  };
}

async function resolveReviewsRoot({ targetPath, outputDir = "", env } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(String(targetPath || ".")),
    outputDirOverride: outputDir,
    env,
  });
  return path.join(outputRoot, "reviews");
}

async function resolveRunDirectory({ targetPath, runId = "", outputDir = "", env } = {}) {
  const reviewsRoot = await resolveReviewsRoot({ targetPath, outputDir, env });
  const explicitRunId = normalizeString(runId);
  if (explicitRunId) {
    const explicitDirectory = path.join(reviewsRoot, explicitRunId);
    await fsp.access(path.join(explicitDirectory, REVIEW_REPORT_JSON));
    return explicitDirectory;
  }

  const entries = await fsp.readdir(reviewsRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("review-"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const candidate of candidates) {
    const candidateDirectory = path.join(reviewsRoot, candidate);
    try {
      await fsp.access(path.join(candidateDirectory, REVIEW_REPORT_JSON));
      return candidateDirectory;
    } catch {
      continue;
    }
  }
  throw new Error("No review report found. Run `review` first.");
}

async function loadDecisions(decisionsPath) {
  try {
    const text = await fsp.readFile(decisionsPath, "utf-8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || typeof parsed.decisions !== "object") {
      throw new Error("Invalid review decisions payload.");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        version: 1,
        updatedAt: "",
        decisions: {},
      };
    }
    throw error;
  }
}

function applyDecisionsToReport(report, decisions = {}) {
  const next = JSON.parse(JSON.stringify(report));
  for (const finding of next.findings || []) {
    const decision = decisions[finding.findingId];
    if (!decision) {
      continue;
    }
    finding.adjudication = {
      verdict: decision.verdict,
      note: decision.note,
      timestamp: decision.timestamp,
      actor: decision.actor,
    };
  }
  return next;
}

export async function loadUnifiedReviewReport({
  targetPath,
  runId = "",
  outputDir = "",
  env,
} = {}) {
  const runDirectory = await resolveRunDirectory({ targetPath, runId, outputDir, env });
  const reportJsonPath = path.join(runDirectory, REVIEW_REPORT_JSON);
  const reportMarkdownPath = path.join(runDirectory, REVIEW_REPORT_MD);
  const report = JSON.parse(await fsp.readFile(reportJsonPath, "utf-8"));
  const decisionsPath = path.join(runDirectory, REVIEW_DECISIONS_JSON);
  const decisions = await loadDecisions(decisionsPath);
  const resolvedReport = applyDecisionsToReport(report, decisions.decisions);
  return {
    runDirectory,
    reportJsonPath,
    reportMarkdownPath,
    decisionsPath,
    decisions,
    report: resolvedReport,
  };
}

export async function recordReviewDecision({
  targetPath,
  runId = "",
  outputDir = "",
  findingId,
  verdict,
  note = "",
  actor = "",
  env,
} = {}) {
  const normalizedVerdict = normalizeString(verdict).toLowerCase();
  if (!["accept", "reject", "defer"].includes(normalizedVerdict)) {
    throw new Error("verdict must be one of: accept, reject, defer.");
  }
  const normalizedFindingId = normalizeString(findingId);
  if (!normalizedFindingId) {
    throw new Error("findingId is required.");
  }

  const loaded = await loadUnifiedReviewReport({
    targetPath,
    runId,
    outputDir,
    env,
  });
  const finding = (loaded.report.findings || []).find((item) => item.findingId === normalizedFindingId);
  if (!finding) {
    throw new Error(`Finding '${normalizedFindingId}' not found in run ${loaded.report.runId}.`);
  }

  const decision = {
    verdict: normalizedVerdict,
    note: normalizeString(note),
    timestamp: new Date().toISOString(),
    actor: normalizeString(actor) || "operator",
  };
  const nextDecisions = {
    version: 1,
    updatedAt: decision.timestamp,
    decisions: {
      ...(loaded.decisions.decisions || {}),
      [normalizedFindingId]: decision,
    },
  };
  await fsp.writeFile(loaded.decisionsPath, `${JSON.stringify(nextDecisions, null, 2)}\n`, "utf-8");

  const nextReport = applyDecisionsToReport(loaded.report, nextDecisions.decisions);
  const nextMarkdown = composeReportMarkdown(nextReport);
  await fsp.writeFile(loaded.reportJsonPath, `${JSON.stringify(nextReport, null, 2)}\n`, "utf-8");
  await fsp.writeFile(loaded.reportMarkdownPath, `${nextMarkdown.trim()}\n`, "utf-8");

  return {
    runId: nextReport.runId,
    runDirectory: loaded.runDirectory,
    findingId: normalizedFindingId,
    decision,
    reportJsonPath: loaded.reportJsonPath,
    reportMarkdownPath: loaded.reportMarkdownPath,
    decisionsPath: loaded.decisionsPath,
  };
}

function normalizeExportFormat(format) {
  const normalized = normalizeString(format).toLowerCase() || "md";
  const allowed = ["sarif", "json", "md", "github-annotations"];
  if (!allowed.includes(normalized)) {
    throw new Error(`format must be one of: ${allowed.join(", ")}.`);
  }
  return normalized;
}

function mapSeverityToAnnotationLevel(severity) {
  const normalized = normalizeSeverity(severity);
  if (normalized === "P0" || normalized === "P1") {
    return "error";
  }
  if (normalized === "P2") {
    return "warning";
  }
  return "notice";
}

function buildSarif(report) {
  const rules = [];
  const seenRules = new Set();
  const results = [];

  for (const finding of report.findings || []) {
    const ruleId = normalizeString(finding.ruleId) || finding.findingId;
    if (!seenRules.has(ruleId)) {
      rules.push({
        id: ruleId,
        name: finding.message,
        shortDescription: {
          text: finding.message,
        },
      });
      seenRules.add(ruleId);
    }

    results.push({
      ruleId,
      level: mapSeverityToAnnotationLevel(finding.severity),
      message: {
        text: `[${finding.findingId}] ${finding.message}`,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: finding.file,
            },
            region: {
              startLine: finding.line,
            },
          },
        },
      ],
      properties: {
        severity: finding.severity,
        confidence: formatConfidence(finding.confidence),
        verdict: finding.adjudication?.verdict || "pending",
      },
    });
  }

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "sentinelayer-review",
            informationUri: "https://github.com/mrrCarter/create-sentinelayer",
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            startTimeUtc: report.generatedAt,
          },
        ],
        results,
      },
    ],
  };
}

function buildGithubAnnotations(report) {
  return (report.findings || [])
    .map((finding) => {
      const level = mapSeverityToAnnotationLevel(finding.severity);
      return `::${level} file=${finding.file},line=${finding.line}::[${finding.findingId}] ${finding.message}`;
    })
    .join("\n");
}

function resolveDefaultExportPath(runDirectory, format) {
  if (format === "json") {
    return path.join(runDirectory, REVIEW_REPORT_JSON);
  }
  if (format === "md") {
    return path.join(runDirectory, REVIEW_REPORT_MD);
  }
  if (format === "sarif") {
    return path.join(runDirectory, "REVIEW_REPORT.sarif.json");
  }
  return path.join(runDirectory, "REVIEW_REPORT.github-annotations.txt");
}

export async function exportUnifiedReviewReport({
  targetPath,
  runId = "",
  outputDir = "",
  format = "md",
  outputFile = "",
  env,
} = {}) {
  const normalizedFormat = normalizeExportFormat(format);
  const loaded = await loadUnifiedReviewReport({
    targetPath,
    runId,
    outputDir,
    env,
  });
  const resolvedOutputPath = normalizeString(outputFile)
    ? path.resolve(path.resolve(String(targetPath || ".")), outputFile)
    : resolveDefaultExportPath(loaded.runDirectory, normalizedFormat);

  let serialized = "";
  if (normalizedFormat === "json") {
    serialized = `${JSON.stringify(loaded.report, null, 2)}\n`;
  } else if (normalizedFormat === "md") {
    serialized = `${composeReportMarkdown(loaded.report).trim()}\n`;
  } else if (normalizedFormat === "sarif") {
    serialized = `${JSON.stringify(buildSarif(loaded.report), null, 2)}\n`;
  } else {
    serialized = `${buildGithubAnnotations(loaded.report)}\n`;
  }

  await fsp.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fsp.writeFile(resolvedOutputPath, serialized, "utf-8");

  return {
    runId: loaded.report.runId,
    runDirectory: loaded.runDirectory,
    format: normalizedFormat,
    outputPath: resolvedOutputPath,
  };
}

