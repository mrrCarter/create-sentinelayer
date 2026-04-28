import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";
import { createAgentEvent } from "../events/schema.js";
import { resolveCodebaseIngest } from "../ingest/engine.js";
import { runDeterministicReviewPipeline } from "../review/local-review.js";
import { loadOmarGateDeterministicCache } from "../review/omargate-cache.js";
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
import {
  buildDocumentsFromBlackboardEntries,
  buildSharedMemoryCorpus,
  queryHybridRetriever,
} from "../memory/retrieval.js";
import { runPersonaAgenticLoop } from "./persona-loop.js";

const AUDIT_ORCHESTRATOR_AGENT = Object.freeze({
  id: "audit-orchestrator",
  persona: "Audit Orchestrator",
  shortName: "Audit",
  color: "cyan",
  avatar: "A",
});

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

function resolveMemoryProvider(env = process.env) {
  const provider = normalizeString(env.SENTINELAYER_MEMORY_PROVIDER).toLowerCase();
  if (provider === "api" || provider === "auto" || provider === "local") {
    return provider;
  }
  return "local";
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

function emitAuditEvent(onEvent, runId, event, payload = {}) {
  if (!onEvent) return;
  onEvent(createAgentEvent({
    event,
    agent: AUDIT_ORCHESTRATOR_AGENT,
    payload,
    runId,
  }));
}

function emitProgressShadow(onEvent, runId, phase, message, extra = {}) {
  emitAuditEvent(onEvent, runId, "progress", {
    phase,
    message,
    shadowFor: extra.shadowFor || phase,
    ...extra,
  });
}

function emitAuditLifecycleEvent(onEvent, runId, event, payload = {}, shadowMessage = "") {
  emitAuditEvent(onEvent, runId, event, payload);
  if (shadowMessage) {
    emitProgressShadow(onEvent, runId, payload.phase || event, shadowMessage, {
      shadowFor: event,
    });
  }
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

function normalizeIsolationMode(value) {
  const normalized = normalizeString(value).toLowerCase();
  return normalized === "relaxed" ? "relaxed" : "strict";
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
Persona isolation: ${report.isolation || "strict"}
Seed from deterministic: ${report.seedFromDeterministic === false ? "no" : "yes"}
OmarGate reuse: ${report.omargateReuse?.used ? `yes (${report.omargateReuse.runId})` : report.omargateReuse?.requested ? `requested ${report.omargateReuse.requested} (${report.omargateReuse.reason || "unavailable"})` : "no"}

Summary:
- Findings: P0=${report.summary.P0} P1=${report.summary.P1} P2=${report.summary.P2} P3=${report.summary.P3}
- Blocking: ${report.summary.blocking ? "yes" : "no"}
- Agents: ${report.agentResults.length}

Shared memory:
- Enabled: ${report.sharedMemory?.enabled ? "yes" : "no"}
- Entries: ${report.sharedMemory?.entryCount || 0}
- Queries: ${report.sharedMemory?.queryCount || 0}
- Corpus docs: ${report.sharedMemory?.corpusDocumentCount || 0}
- Retrieval provider: ${report.sharedMemory?.retrieval?.providerRequested || "local"}
- Providers used: ${(report.sharedMemory?.retrieval?.providersUsed || []).join(", ") || "local"}
- Artifact: ${report.sharedMemory?.artifactPath || "n/a"}

Ingest:
- Files scanned: ${report.ingest.summary.filesScanned}
- LOC: ${report.ingest.summary.totalLoc}
- Frameworks: ${report.ingest.frameworks.join(", ") || "none"}
- Risk surfaces: ${report.ingest.riskSurfaces.join(", ") || "none"}
- Refresh: ${report.ingest.refresh?.refreshed ? "yes" : "no"}
- Stale: ${report.ingest.refresh?.stale ? "yes" : "no"}
- Refresh reasons: ${(report.ingest.refresh?.reasons || []).join(", ") || "none"}

Deterministic baseline:
- Run ID: ${report.deterministicBaseline.runId || "n/a"}
- Report: ${report.deterministicBaseline.reportPath || "n/a"}
- Reused OmarGate run: ${report.omargateReuse?.used ? report.omargateReuse.runId : "n/a"}
- Summary: P0=${report.deterministicBaseline.summary.P0} P1=${report.deterministicBaseline.summary.P1} P2=${report.deterministicBaseline.summary.P2} P3=${report.deterministicBaseline.summary.P3}

Agent outcomes:
${agentLines || "- none"}
`;
}

async function buildSpecialistSeed({
  agent,
  deterministicBaseline,
  ingest,
  agentsDirectory,
}) {
  let findings = [];
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

  return {
    findings,
    summary,
    confidence,
    specialistReportPath,
  };
}

export async function runAuditOrchestrator({
  targetPath,
  agents = [],
  maxParallel = 3,
  outputDir = "",
  dryRun = false,
  refreshIngest = false,
  provider = null,
  onEvent = null,
  clientFactory = null,
  isolation = "strict",
  seedFromDeterministic = true,
  reuseOmarGate = "",
} = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const isolationMode = normalizeIsolationMode(isolation);
  const useDeterministicSeed = seedFromDeterministic !== false;
  const requestedOmarGateReuse = normalizeString(reuseOmarGate);
  const outputRoot = await resolveOutputRoot({
    cwd: normalizedTargetPath,
    outputDirOverride: outputDir,
    env: process.env,
  });
  const runId = `audit-${formatTimestampToken()}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const runDirectory = path.join(outputRoot, "audits", runId);
  const agentsDirectory = path.join(runDirectory, "agents");
  await fsp.mkdir(agentsDirectory, { recursive: true });
  const blackboard = createBlackboard({
    runId,
    scope: "audit-orchestrator",
  });
  const selectedAgentIds = agents.map((agent) => agent.id);
  const normalizedMaxParallel = Math.max(1, Math.floor(Number(maxParallel || 1)));

  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "orchestrator_start",
    {
      runId,
      targetPath: normalizedTargetPath,
      selectedAgents: selectedAgentIds,
      agentCount: selectedAgentIds.length,
      maxParallel: normalizedMaxParallel,
      dryRun: Boolean(dryRun),
      isolation: isolationMode,
      seedFromDeterministic: useDeterministicSeed,
      reuseOmarGate: requestedOmarGateReuse || "",
    },
    `Audit orchestrator starting with ${selectedAgentIds.length} agent(s).`
  );

  const ingestStartedAt = Date.now();
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "phase_start",
    { phase: "ingest", targetPath: normalizedTargetPath, refresh: Boolean(refreshIngest) },
    "Starting codebase ingest."
  );
  const ingestResolution = await resolveCodebaseIngest({
    rootPath: normalizedTargetPath,
    outputDir,
    refresh: Boolean(refreshIngest),
  });
  const ingest = ingestResolution.ingest;
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "phase_complete",
    {
      phase: "ingest",
      durationMs: Math.max(0, Date.now() - ingestStartedAt),
      filesScanned: Number(ingest?.summary?.filesScanned || 0),
      totalLoc: Number(ingest?.summary?.totalLoc || 0),
      refreshed: Boolean(ingestResolution.refreshed),
      stale: Boolean(ingestResolution.stale),
    },
    `Ingest complete: ${Number(ingest?.summary?.filesScanned || 0)} files.`
  );

  let deterministicBaseline = {
    runId: "",
    reportPath: "",
    reportJsonPath: "",
    summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
    findings: [],
  };
  let omargateReuse = {
    requested: requestedOmarGateReuse,
    used: false,
    runId: "",
    deterministicRunId: "",
    artifactPath: "",
    reason: requestedOmarGateReuse ? (dryRun ? "dry_run" : "not_found") : "not_requested",
  };
  const baselineStartedAt = Date.now();
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "phase_start",
    {
      phase: "deterministic_baseline",
      skipped: Boolean(dryRun),
      reuseRequested: Boolean(requestedOmarGateReuse),
      requestedOmarGateRunId: requestedOmarGateReuse,
    },
    dryRun
      ? "Skipping deterministic baseline for dry run."
      : requestedOmarGateReuse
        ? "Resolving OmarGate deterministic baseline reuse."
        : "Starting deterministic baseline."
  );
  if (!dryRun) {
    let reusedBaseline = null;
    if (requestedOmarGateReuse) {
      const reused = await loadOmarGateDeterministicCache({
        targetPath: normalizedTargetPath,
        outputDir,
        runIdOrLatest: requestedOmarGateReuse,
      });
      if (reused.found) {
        const cache = reused.cache || {};
        reusedBaseline = {
          runId: cache.deterministicRunId || cache.runId || reused.runId,
          reportPath: cache.source?.reportPath || "",
          reportJsonPath: cache.artifacts?.jsonPath || "",
          summary: cache.summary || severitySummary(cache.findings || []),
          findings: Array.isArray(cache.findings) ? cache.findings : [],
          reusedFromOmarGate: true,
          reusedOmarGateRunId: reused.runId,
          reuseArtifactPath: reused.artifactPath,
        };
        omargateReuse = {
          requested: requestedOmarGateReuse,
          used: true,
          runId: reused.runId,
          deterministicRunId: cache.deterministicRunId || "",
          artifactPath: reused.artifactPath,
          reason: "",
        };
      } else {
        omargateReuse = {
          requested: requestedOmarGateReuse,
          used: false,
          runId: "",
          deterministicRunId: "",
          artifactPath: "",
          reason: reused.reason || "not_found",
        };
      }
    }
    if (reusedBaseline) {
      deterministicBaseline = reusedBaseline;
    } else {
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
  }
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "phase_complete",
    {
      phase: "deterministic_baseline",
      skipped: Boolean(dryRun),
      reused: Boolean(omargateReuse.used),
      omargateReuse,
      durationMs: Math.max(0, Date.now() - baselineStartedAt),
      findingCount: deterministicBaseline.findings.length,
      summary: deterministicBaseline.summary,
    },
    dryRun
      ? "Deterministic baseline skipped."
      : omargateReuse.used
        ? `Reused OmarGate deterministic baseline ${omargateReuse.runId}: ${deterministicBaseline.findings.length} finding(s).`
        : `Deterministic baseline complete: ${deterministicBaseline.findings.length} finding(s).`
  );
  if (useDeterministicSeed) {
    appendBlackboardFindings(blackboard, {
      agentId: "omar",
      findings: deterministicBaseline.findings,
      source: omargateReuse.used ? "omargate-reuse" : "deterministic-baseline",
    });
  }
  const memoryProvider = resolveMemoryProvider(process.env);
  const memoryApiEndpoint = normalizeString(process.env.SENTINELAYER_MEMORY_API_ENDPOINT);
  const memoryApiKey = normalizeString(
    process.env.SENTINELAYER_MEMORY_API_KEY ||
      process.env.SENTINELAYER_TOKEN ||
      process.env.SENTINELAYER_API_TOKEN
  );
  const sharedMemoryCorpus = await buildSharedMemoryCorpus({
    outputRoot,
    targetPath: normalizedTargetPath,
    ingest,
    excludeRunId: runId,
  });
  const sharedMemoryQueries = [];

  const routeBuckets = new Map();
  if (useDeterministicSeed) {
    for (const finding of deterministicBaseline.findings) {
      const bucketId = routeFindingToAgentId(finding);
      const existing = routeBuckets.get(bucketId) || [];
      existing.push(finding);
      routeBuckets.set(bucketId, existing);
    }
  }

  const dispatchStartedAt = Date.now();
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "phase_start",
    { phase: "dispatch", agentCount: agents.length, maxParallel: normalizedMaxParallel },
    `Dispatching ${agents.length} audit persona(s).`
  );
  const agentResults = await runWithConcurrency(agents, normalizedMaxParallel, async (agent) => {
    const agentStart = Date.now();
    emitAuditLifecycleEvent(
      onEvent,
      runId,
      "dispatch",
      {
        phase: "dispatch",
        agentId: agent.id,
        persona: agent.persona,
        domain: agent.domain,
        isolation: isolationMode,
        seedFromDeterministic: useDeterministicSeed,
      },
      `Dispatching ${agent.id} persona.`
    );
    const sharedContext = queryBlackboard(blackboard, {
      query: `${agent.id} ${agent.domain} ${agent.persona}`,
      agentId: agent.id,
      limit: 24,
    });
    const hybridContext = await queryHybridRetriever({
      query: `${agent.id} ${agent.domain} ${agent.persona}`,
      documents: [
        ...buildDocumentsFromBlackboardEntries(blackboard.entries),
        ...sharedMemoryCorpus.documents,
      ],
      limit: 24,
      provider: memoryProvider,
      apiEndpoint: memoryApiEndpoint,
      apiKey: memoryApiKey,
    });
    sharedMemoryQueries.push({
      agentId: agent.id,
      providerUsed: hybridContext.providerUsed,
      apiFallback: Boolean(hybridContext.apiFallback),
      resultCount: Array.isArray(hybridContext.results) ? hybridContext.results.length : 0,
      apiError: hybridContext.apiError || "",
    });
    const personaDeterministicBaseline = useDeterministicSeed
      ? deterministicBaseline
      : { ...deterministicBaseline, findings: [] };
    const routedFindings = useDeterministicSeed ? routeBuckets.get(agent.id) || [] : [];
    const specialistSeed = useDeterministicSeed
      ? await buildSpecialistSeed({
          agent,
          deterministicBaseline,
          ingest,
          agentsDirectory,
        })
      : {
          findings: [],
          summary: severitySummary([]),
          confidence: computeConfidenceFloor(agent.confidenceFloor, 0),
          specialistReportPath: "",
        };
    let findings = specialistSeed.findings.length > 0 ? specialistSeed.findings : routedFindings;
    let summary = specialistSeed.findings.length > 0
      ? specialistSeed.summary
      : severitySummary(findings);
    let confidence = specialistSeed.findings.length > 0
      ? specialistSeed.confidence
      : computeConfidenceFloor(agent.confidenceFloor, findings.length);
    let specialistReportPath = specialistSeed.specialistReportPath;
    let agenticReport = null;

    if (agent.id !== "frontend") {
      agenticReport = await runPersonaAgenticLoop({
        agent,
        rootPath: normalizedTargetPath,
        ingest,
        deterministicBaseline: personaDeterministicBaseline,
        seedFindings: findings,
        sharedContext,
        hybridContext,
        artifactDir: agentsDirectory,
        provider,
        onEvent,
        clientFactory,
        dryRun: Boolean(dryRun),
        isolation: isolationMode,
      });
      findings = agenticReport.findings;
      summary = agenticReport.summary;
      confidence = agenticReport.confidence;
    }

    const agentStatus = summary.blocking
      ? "escalate"
      : agenticReport && !["completed", "dry_run"].includes(agenticReport.status)
        ? agenticReport.status
        : "ok";

    const result = {
      agentId: agent.id,
      persona: agent.persona,
      domain: agent.domain,
      permissionMode: agent.permissionMode,
      maxTurns: agent.maxTurns,
      confidenceFloor: agent.confidenceFloor,
      isolation: isolationMode,
      seedFromDeterministic: useDeterministicSeed,
      routedSeedFindingCount: routedFindings.length,
      specialistSeedFindingCount: specialistSeed.findings.length,
      confidence,
      findingCount: findings.length,
      summary,
      findings: findings.slice(0, 120),
      status: agentStatus,
      startedAt: new Date(agentStart).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - agentStart),
      escalationTargets: agent.escalationTargets || [],
      evidenceRequirements: agent.evidenceRequirements || [],
      specialistReportPath,
      agenticRunId: agenticReport?.runId || "",
      agenticStatus: agenticReport?.status || (agent.id === "frontend" ? "preserved-frontend-flow" : ""),
      agenticMessageHistoryLength: Number(agenticReport?.messageHistoryLength || 0),
      swarm: agenticReport?.swarm || null,
      usage: agenticReport?.usage || {
        costUsd: 0,
        outputTokens: 0,
        toolCalls: 0,
        durationMs: Math.max(0, Date.now() - agentStart),
        filesRead: [],
      },
      grantedTools: agenticReport?.grantedTools || agent.tools || [],
      availableTools: agenticReport?.availableTools || [],
      sharedContextEntryCount: sharedContext.entries.length,
      sharedContextPreview: sharedContext.entries.slice(0, 5).map((entry) => ({
        entryId: entry.entryId,
        severity: entry.severity,
        file: entry.file,
        line: entry.line,
        message: entry.message,
      })),
      hybridContextProvider: hybridContext.providerUsed,
      hybridContextApiFallback: Boolean(hybridContext.apiFallback),
      hybridContextEntryCount: Array.isArray(hybridContext.results) ? hybridContext.results.length : 0,
      hybridContextPreview: (hybridContext.results || []).slice(0, 5).map((entry) => ({
        documentId: entry.documentId || "",
        sourceType: entry.sourceType || "",
        severity: entry.severity || "P3",
        score: Number(entry.score || 0),
        snippet: normalizeString(entry.snippet || ""),
      })),
    };
    appendBlackboardFindings(blackboard, {
      agentId: agent.id,
      findings,
      source: agenticReport ? "persona-agentic-loop" : "specialist-agent",
      note: `${agent.id} persona finding`,
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
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "phase_complete",
    {
      phase: "dispatch",
      durationMs: Math.max(0, Date.now() - dispatchStartedAt),
      agentCount: agentResults.length,
      statuses: agentResults.reduce((acc, result) => {
        const status = normalizeString(result.status) || "unknown";
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {}),
    },
    `Dispatch complete: ${agentResults.length} persona result(s).`
  );

  const reconcileStartedAt = Date.now();
  const candidateFindingCount = agentResults.reduce(
    (count, agent) => count + (Array.isArray(agent.findings) ? agent.findings.length : 0),
    0
  );
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "reconcile_start",
    { phase: "reconcile", agentCount: agentResults.length, candidateFindingCount },
    `Reconciling ${candidateFindingCount} candidate finding(s).`
  );
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
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "reconcile_complete",
    {
      phase: "reconcile",
      durationMs: Math.max(0, Date.now() - reconcileStartedAt),
      candidateFindingCount,
      findingCount: uniqueFindings.length,
      dedupedCount: Math.max(0, candidateFindingCount - uniqueFindings.length),
      summary,
    },
    `Reconcile complete: ${uniqueFindings.length} unique finding(s).`
  );
  const sharedMemoryArtifact = await writeBlackboardArtifact(blackboard, {
    outputRoot,
  });
  const sharedMemorySummary = summarizeBlackboard(blackboard);
  sharedMemoryQueries.sort((left, right) => left.agentId.localeCompare(right.agentId));
  const providersUsed = Array.from(new Set(sharedMemoryQueries.map((item) => item.providerUsed))).sort();

  const report = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    runId,
    targetPath: normalizedTargetPath,
    outputRoot,
    runDirectory,
    dryRun: Boolean(dryRun),
    maxParallel: normalizedMaxParallel,
    isolation: isolationMode,
    seedFromDeterministic: useDeterministicSeed,
    durationMs: Math.max(0, Date.now() - startedAt),
    ingest: {
      summary: ingest.summary,
      frameworks: Array.isArray(ingest.frameworks) ? ingest.frameworks : [],
      riskSurfaces: Array.isArray(ingest.riskSurfaces)
        ? ingest.riskSurfaces.map((item) => item.surface)
        : [],
      refresh: {
        outputPath: ingestResolution.outputPath,
        refreshed: ingestResolution.refreshed,
        stale: ingestResolution.stale,
        reasons: ingestResolution.reasons,
        refreshedBecause: ingestResolution.refreshedBecause,
        lastCommitAt: ingestResolution.lastCommitAt,
        contentHash: ingestResolution.fingerprint?.contentHash || "",
      },
    },
    deterministicBaseline,
    omargateReuse,
    sharedMemory: {
      enabled: true,
      artifactPath: sharedMemoryArtifact.artifactPath,
      entryCount: sharedMemorySummary.entryCount,
      queryCount: sharedMemorySummary.queryCount,
      severity: sharedMemorySummary.severity,
      createdAt: sharedMemorySummary.createdAt,
      updatedAt: sharedMemorySummary.updatedAt,
      corpusDocumentCount: sharedMemoryCorpus.documents.length,
      corpusSourceCounts: sharedMemoryCorpus.sourceCounts,
      retrieval: {
        providerRequested: memoryProvider,
        apiDelegationEnabled: Boolean(memoryApiEndpoint),
        providersUsed,
        queryCount: sharedMemoryQueries.length,
        queries: sharedMemoryQueries,
        hasSpecDocument: sharedMemoryCorpus.hasSpecDocument,
        historyRunDocumentCount: sharedMemoryCorpus.historyRunDocumentCount,
      },
    },
    selectedAgents: selectedAgentIds,
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
  emitAuditLifecycleEvent(
    onEvent,
    runId,
    "orchestrator_complete",
    {
      runId,
      targetPath: normalizedTargetPath,
      durationMs: Math.max(0, Date.now() - startedAt),
      agentCount: agentResults.length,
      summary,
      reportJsonPath,
      reportMarkdownPath,
      ddPackageManifestPath: ddPackage.manifestPath || "",
    },
    `Audit orchestrator complete: P0=${summary.P0} P1=${summary.P1} P2=${summary.P2} P3=${summary.P3}.`
  );

  return {
    ...report,
    reportJsonPath,
    reportMarkdownPath,
    ddPackage,
  };
}

