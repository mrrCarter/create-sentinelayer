import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";
import { collectCodebaseIngest } from "../ingest/engine.js";
import { runDeterministicReviewPipeline } from "../review/local-review.js";
import {
  renderArchitectureSpecialistMarkdown,
  runArchitectureSpecialist,
} from "./agents/architecture.js";
import {
  renderComplianceSpecialistMarkdown,
  runComplianceSpecialist,
} from "./agents/compliance.js";
import {
  renderDocumentationSpecialistMarkdown,
  runDocumentationSpecialist,
} from "./agents/documentation.js";
import {
  renderPerformanceSpecialistMarkdown,
  runPerformanceSpecialist,
} from "./agents/performance.js";
import {
  renderSecuritySpecialistMarkdown,
  runSecuritySpecialist,
} from "./agents/security.js";
import {
  renderTestingSpecialistMarkdown,
  runTestingSpecialist,
} from "./agents/testing.js";
import { writeDdPackage } from "./package.js";
import {
  appendBlackboardFindings,
  createBlackboard,
  queryBlackboard,
  summarizeBlackboard,
  writeBlackboardArtifact,
} from "../memory/blackboard.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function formatTimestampToken() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function severitySummary(findings = []) {
  const summary = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  for (const finding of findings) {
    const severity = normalizeString(finding.severity).toUpperCase();
    if (Object.prototype.hasOwnProperty.call(summary, severity)) {
      summary[severity] += 1;
    }
  }
  summary.blocking = summary.P0 > 0 || summary.P1 > 0;
  return summary;
}

function routeFindingToAgentId(finding = {}) {
  const file = normalizeString(finding.file).toLowerCase();
  const message = normalizeString(finding.message).toLowerCase();
  const layer = normalizeString(finding.layer).toLowerCase();
  const combined = `${file} ${message} ${layer}`;

  if (/token|secret|credential|auth|tls|cors|xss|sql|jwt|injection/.test(combined)) {
    return "security";
  }
  if (/test|coverage|lint|typecheck|static analysis/.test(combined)) {
    return "testing";
  }
  if (/query|loop|n\+1|performance|latency|runtime/.test(combined)) {
    return "performance";
  }
  if (/compliance|soc2|hipaa|gdpr|privacy|pii|control|evidence|retention/.test(combined)) {
    return "compliance";
  }
  if (/spec|documentation|docs\//.test(combined)) {
    return "documentation";
  }
  if (/workflow|release|deploy|npm publish|ci/.test(combined)) {
    return "release";
  }
  if (/terraform|infra|kubernetes|ecs|aws/.test(combined)) {
    return "infrastructure";
  }
  if (/observability|telemetry|trace|metrics|log/.test(combined)) {
    return "observability";
  }
  if (/frontend|tsx|jsx|component|react/.test(combined)) {
    return "frontend";
  }
  if (/database|sql|migration|schema|data layer/.test(combined)) {
    return "data-layer";
  }
  if (/dependency|supply|package-lock|lockfile/.test(combined)) {
    return "supply-chain";
  }
  if (/ai|model|prompt|budget/.test(combined)) {
    return "ai-governance";
  }
  if (/reliability|timeout|retry|fallback/.test(combined)) {
    return "reliability";
  }
  return "architecture";
}

function computeConfidenceFloor(base, findingCount) {
  const floor = Number(base || 0);
  const normalizedFloor = Number.isFinite(floor) ? Math.max(0, Math.min(1, floor)) : 0.7;
  if (findingCount <= 0) {
    return Math.min(0.99, normalizedFloor + 0.05);
  }
  const damping = Math.min(0.2, findingCount * 0.01);
  return Math.max(0.5, Math.min(0.99, normalizedFloor - damping));
}

async function runWithConcurrency(items, maxParallel, worker) {
  const results = [];
  const queue = [...items];
  const limit = Math.max(1, Math.floor(Number(maxParallel || 1)));
  const runners = [];
  for (let index = 0; index < limit; index += 1) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const nextItem = queue.shift();
          if (!nextItem) {
            continue;
          }
          const value = await worker(nextItem);
          results.push(value);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

function buildAuditMarkdown(report = {}) {
  const agentLines = (report.agentResults || [])
    .map(
      (agent) =>
        `- ${agent.agentId} (${agent.persona}, ${agent.domain}) findings=${agent.findingCount} confidence=${(
          agent.confidence * 100
        ).toFixed(0)}% status=${agent.status}`
    )
    .join("\n");

  return `# AUDIT_REPORT

Generated: ${report.generatedAt}
Run ID: ${report.runId}
Target: ${report.targetPath}
Max parallel: ${report.maxParallel}
Dry run: ${report.dryRun ? "yes" : "no"}

Summary:
- Findings: P0=${report.summary.P0} P1=${report.summary.P1} P2=${report.summary.P2} P3=${report.summary.P3}
- Blocking: ${report.summary.blocking ? "yes" : "no"}
- Agents: ${report.agentResults.length}

Shared memory:
- Enabled: ${report.sharedMemory?.enabled ? "yes" : "no"}
- Entries: ${report.sharedMemory?.entryCount || 0}
- Queries: ${report.sharedMemory?.queryCount || 0}
- Artifact: ${report.sharedMemory?.artifactPath || "n/a"}

Ingest:
- Files scanned: ${report.ingest.summary.filesScanned}
- LOC: ${report.ingest.summary.totalLoc}
- Frameworks: ${report.ingest.frameworks.join(", ") || "none"}
- Risk surfaces: ${report.ingest.riskSurfaces.join(", ") || "none"}

Deterministic baseline:
- Run ID: ${report.deterministicBaseline.runId || "n/a"}
- Report: ${report.deterministicBaseline.reportPath || "n/a"}
- Summary: P0=${report.deterministicBaseline.summary.P0} P1=${report.deterministicBaseline.summary.P1} P2=${report.deterministicBaseline.summary.P2} P3=${report.deterministicBaseline.summary.P3}

Agent outcomes:
${agentLines || "- none"}
`;
}

export async function runAuditOrchestrator({
  targetPath,
  agents = [],
  maxParallel = 3,
  outputDir = "",
  dryRun = false,
} = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const outputRoot = await resolveOutputRoot({
    cwd: normalizedTargetPath,
    outputDirOverride: outputDir,
    env: process.env,
  });
  const runId = `audit-${formatTimestampToken()}-${randomUUID().slice(0, 8)}`;
  const runDirectory = path.join(outputRoot, "audits", runId);
  const agentsDirectory = path.join(runDirectory, "agents");
  await fsp.mkdir(agentsDirectory, { recursive: true });
  const blackboard = createBlackboard({
    runId,
    scope: "audit-orchestrator",
  });

  const ingest = await collectCodebaseIngest({ rootPath: normalizedTargetPath });

  let deterministicBaseline = {
    runId: "",
    reportPath: "",
    reportJsonPath: "",
    summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
    findings: [],
  };
  if (!dryRun) {
    const deterministic = await runDeterministicReviewPipeline({
      targetPath: normalizedTargetPath,
      mode: "full",
      outputDir,
    });
    deterministicBaseline = {
      runId: deterministic.runId,
      reportPath: deterministic.artifacts.markdownPath,
      reportJsonPath: deterministic.artifacts.jsonPath,
      summary: deterministic.summary,
      findings: deterministic.findings,
    };
  }
  appendBlackboardFindings(blackboard, {
    agentId: "omar",
    findings: deterministicBaseline.findings,
    source: "deterministic-baseline",
  });

  const routeBuckets = new Map();
  for (const finding of deterministicBaseline.findings) {
    const bucketId = routeFindingToAgentId(finding);
    const existing = routeBuckets.get(bucketId) || [];
    existing.push(finding);
    routeBuckets.set(bucketId, existing);
  }

  const startedAt = Date.now();
  const agentResults = await runWithConcurrency(agents, maxParallel, async (agent) => {
    const agentStart = Date.now();
    const sharedContext = queryBlackboard(blackboard, {
      query: `${agent.id} ${agent.domain} ${agent.persona}`,
      agentId: agent.id,
      limit: 24,
    });
    let findings = routeBuckets.get(agent.id) || [];
    let summary = severitySummary(findings);
    let confidence = computeConfidenceFloor(agent.confidenceFloor, findings.length);
    let specialistReportPath = "";

    if (agent.id === "security") {
      const securitySpecialist = runSecuritySpecialist({
        findings: deterministicBaseline.findings,
      });
      findings = securitySpecialist.findings;
      summary = securitySpecialist.summary;
      confidence = securitySpecialist.confidence;
      specialistReportPath = path.join(agentsDirectory, "SECURITY_AGENT_REPORT.md");
      await fsp.writeFile(
        specialistReportPath,
        `${renderSecuritySpecialistMarkdown(securitySpecialist).trim()}\n`,
        "utf-8"
      );
    } else if (agent.id === "architecture") {
      const architectureSpecialist = runArchitectureSpecialist({
        findings: deterministicBaseline.findings,
        ingest,
      });
      findings = architectureSpecialist.findings;
      summary = architectureSpecialist.summary;
      confidence = architectureSpecialist.confidence;
      specialistReportPath = path.join(agentsDirectory, "ARCHITECTURE_AGENT_REPORT.md");
      await fsp.writeFile(
        specialistReportPath,
        `${renderArchitectureSpecialistMarkdown(architectureSpecialist).trim()}\n`,
        "utf-8"
      );
    } else if (agent.id === "testing") {
      const testingSpecialist = runTestingSpecialist({
        findings: deterministicBaseline.findings,
        ingest,
      });
      findings = testingSpecialist.findings;
      summary = testingSpecialist.summary;
      confidence = testingSpecialist.confidence;
      specialistReportPath = path.join(agentsDirectory, "TESTING_AGENT_REPORT.md");
      await fsp.writeFile(
        specialistReportPath,
        `${renderTestingSpecialistMarkdown(testingSpecialist).trim()}\n`,
        "utf-8"
      );
    } else if (agent.id === "performance") {
      const performanceSpecialist = runPerformanceSpecialist({
        findings: deterministicBaseline.findings,
        ingest,
      });
      findings = performanceSpecialist.findings;
      summary = performanceSpecialist.summary;
      confidence = performanceSpecialist.confidence;
      specialistReportPath = path.join(agentsDirectory, "PERFORMANCE_AGENT_REPORT.md");
      await fsp.writeFile(
        specialistReportPath,
        `${renderPerformanceSpecialistMarkdown(performanceSpecialist).trim()}\n`,
        "utf-8"
      );
    } else if (agent.id === "compliance") {
      const complianceSpecialist = runComplianceSpecialist({
        findings: deterministicBaseline.findings,
        ingest,
      });
      findings = complianceSpecialist.findings;
      summary = complianceSpecialist.summary;
      confidence = complianceSpecialist.confidence;
      specialistReportPath = path.join(agentsDirectory, "COMPLIANCE_AGENT_REPORT.md");
      await fsp.writeFile(
        specialistReportPath,
        `${renderComplianceSpecialistMarkdown(complianceSpecialist).trim()}\n`,
        "utf-8"
      );
    } else if (agent.id === "documentation") {
      const documentationSpecialist = runDocumentationSpecialist({
        findings: deterministicBaseline.findings,
        ingest,
      });
      findings = documentationSpecialist.findings;
      summary = documentationSpecialist.summary;
      confidence = documentationSpecialist.confidence;
      specialistReportPath = path.join(agentsDirectory, "DOCUMENTATION_AGENT_REPORT.md");
      await fsp.writeFile(
        specialistReportPath,
        `${renderDocumentationSpecialistMarkdown(documentationSpecialist).trim()}\n`,
        "utf-8"
      );
    }

    const result = {
      agentId: agent.id,
      persona: agent.persona,
      domain: agent.domain,
      permissionMode: agent.permissionMode,
      maxTurns: agent.maxTurns,
      confidenceFloor: agent.confidenceFloor,
      confidence,
      findingCount: findings.length,
      summary,
      findings: findings.slice(0, 120),
      status: summary.blocking ? "escalate" : "ok",
      startedAt: new Date(agentStart).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - agentStart),
      escalationTargets: agent.escalationTargets || [],
      evidenceRequirements: agent.evidenceRequirements || [],
      specialistReportPath,
      sharedContextEntryCount: sharedContext.entries.length,
      sharedContextPreview: sharedContext.entries.slice(0, 5).map((entry) => ({
        entryId: entry.entryId,
        severity: entry.severity,
        file: entry.file,
        line: entry.line,
        message: entry.message,
      })),
    };
    appendBlackboardFindings(blackboard, {
      agentId: agent.id,
      findings,
      source: "specialist-agent",
      note: `${agent.id} specialist finding`,
      confidence,
    });
    const agentPath = path.join(agentsDirectory, `${agent.id}.json`);
    await fsp.writeFile(agentPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
    return {
      ...result,
      artifactPath: agentPath,
    };
  });
  agentResults.sort((left, right) => left.agentId.localeCompare(right.agentId));

  const uniqueFindings = [];
  const seen = new Set();
  for (const agent of agentResults) {
    for (const finding of agent.findings || []) {
      const key = `${toPosixPath(finding.file)}:${finding.line}:${normalizeString(
        finding.message
      ).toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueFindings.push(finding);
    }
  }
  const summary = severitySummary(uniqueFindings);
  const sharedMemoryArtifact = await writeBlackboardArtifact(blackboard, {
    outputRoot,
  });
  const sharedMemorySummary = summarizeBlackboard(blackboard);

  const report = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    runId,
    targetPath: normalizedTargetPath,
    outputRoot,
    runDirectory,
    dryRun: Boolean(dryRun),
    maxParallel: Math.max(1, Math.floor(Number(maxParallel || 1))),
    durationMs: Math.max(0, Date.now() - startedAt),
    ingest: {
      summary: ingest.summary,
      frameworks: Array.isArray(ingest.frameworks) ? ingest.frameworks : [],
      riskSurfaces: Array.isArray(ingest.riskSurfaces)
        ? ingest.riskSurfaces.map((item) => item.surface)
        : [],
    },
    deterministicBaseline,
    sharedMemory: {
      enabled: true,
      artifactPath: sharedMemoryArtifact.artifactPath,
      entryCount: sharedMemorySummary.entryCount,
      queryCount: sharedMemorySummary.queryCount,
      severity: sharedMemorySummary.severity,
      createdAt: sharedMemorySummary.createdAt,
      updatedAt: sharedMemorySummary.updatedAt,
    },
    selectedAgents: agents.map((agent) => agent.id),
    agentResults,
    summary,
  };

  const reportJsonPath = path.join(runDirectory, "AUDIT_REPORT.json");
  const reportMarkdownPath = path.join(runDirectory, "AUDIT_REPORT.md");
  await fsp.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fsp.writeFile(reportMarkdownPath, `${buildAuditMarkdown(report).trim()}\n`, "utf-8");
  const ddPackage = await writeDdPackage({
    report,
    runDirectory,
  });

  return {
    ...report,
    reportJsonPath,
    reportMarkdownPath,
    ddPackage,
  };
}

