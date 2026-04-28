/**
 * Omar Gate multi-persona orchestrator.
 *
 * Runs N persona-scoped AI review calls in parallel (bounded concurrency),
 * merges findings into a blackboard, deduplicates, and produces a unified report.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import { runAiReviewLayer } from "./ai-review.js";
import { buildPersonaReviewPrompt, PERSONA_IDS } from "./persona-prompts.js";
import { resolveFilteredPersonas, resolveScanMode } from "./scan-modes.js";
import { reconcileReviewFindings } from "./report.js";
import { resolvePersonaVisual } from "../agents/persona-visuals.js";
import { syncRunToDashboard } from "../telemetry/sync.js";
import { createAgentEvent } from "../events/schema.js";

const OMAR_ORCHESTRATOR_AGENT = Object.freeze({
  id: "omar-orchestrator",
  persona: "Omar Gate Orchestrator",
});

const OMAR_SWARM_THRESHOLDS = Object.freeze({
  minFilesForSwarm: 15,
  minRouteGroupsForSwarm: 3,
  minLocForSwarm: 5000,
  maxFilesPerScanner: 12,
  maxConcurrentAgents: 4,
});

const OMARGATE_DEFAULT_CONFIDENCE_FLOOR = 0.7;
const OMARGATE_CONFIDENCE_FLOORS = Object.freeze(
  Object.fromEntries(PERSONA_IDS.map((personaId) => [personaId, OMARGATE_DEFAULT_CONFIDENCE_FLOOR]))
);

/**
 * Run bounded-concurrency parallel execution.
 * @param {Array} items
 * @param {number} maxConcurrent
 * @param {Function} fn
 * @returns {Promise<Array>}
 */
async function runWithConcurrency(items, maxConcurrent, fn) {
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item)).finally(() => {
      executing.delete(p);
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= maxConcurrent) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function toPosixPath(value) {
  return normalizeString(value).replace(/\\/g, "/");
}

function uniqueScopeFiles(files = []) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(files) ? files : []) {
    const rawPath =
      typeof item === "string"
        ? item
        : item?.path || item?.file || item?.relativePath || "";
    const filePath = toPosixPath(rawPath);
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    const loc =
      typeof item === "object" && item
        ? Math.max(0, Math.floor(normalizeNumber(item.loc ?? item.lines ?? item.lineCount, 0)))
        : 0;
    normalized.push({ path: filePath, loc });
  }
  return normalized;
}

function filesFromScope(scope = {}) {
  if (Array.isArray(scope.files)) {
    return uniqueScopeFiles(scope.files);
  }
  if (Array.isArray(scope.primary)) {
    return uniqueScopeFiles(scope.primary);
  }
  if (Array.isArray(scope.scannedRelativeFiles)) {
    return uniqueScopeFiles(scope.scannedRelativeFiles);
  }
  return [];
}

function estimateScopeLoc(scope = {}, files = []) {
  const explicit =
    normalizeNumber(scope.totalLoc, 0) ||
    normalizeNumber(scope.estimatedLoc, 0) ||
    normalizeNumber(scope.summary?.totalLoc, 0);
  if (explicit > 0) {
    return Math.floor(explicit);
  }
  return files.reduce((sum, file) => sum + (file.loc > 0 ? file.loc : 80), 0);
}

function detectRouteGroups(files = []) {
  const routeGroups = new Set();
  for (const file of files) {
    const filePath = toPosixPath(file.path || file);
    const match = filePath.match(/(?:^|\/)(?:app|pages|routes)\/([^/]+)/);
    if (match?.[1]) {
      routeGroups.add(match[1]);
    }
  }
  return [...routeGroups].sort();
}

/**
 * Build the OmarGate persona file scope from deterministic review output.
 */
export function buildPersonaFileScope({ deterministic = {} } = {}) {
  const rawScope = deterministic?.scope || {};
  const ingestSummary = deterministic?.layers?.ingest?.summary || {};
  const files = filesFromScope(rawScope);
  const totalLoc =
    normalizeNumber(rawScope.totalLoc, 0) ||
    normalizeNumber(rawScope.estimatedLoc, 0) ||
    normalizeNumber(ingestSummary.totalLoc, 0) ||
    estimateScopeLoc(rawScope, files);

  return {
    files,
    scannedFiles: files.length,
    scannedRelativeFiles: files.map((file) => file.path),
    totalLoc: Math.floor(totalLoc),
  };
}

/**
 * Decide whether an OmarGate persona should fan out into scoped subagents.
 */
export function decideSwarm({ scope = {} } = {}) {
  const files = filesFromScope(scope);
  const routeGroups = detectRouteGroups(files);
  const estimatedLoc = estimateScopeLoc(scope, files);
  const spawn =
    files.length > OMAR_SWARM_THRESHOLDS.minFilesForSwarm ||
    routeGroups.length >= OMAR_SWARM_THRESHOLDS.minRouteGroupsForSwarm ||
    estimatedLoc > OMAR_SWARM_THRESHOLDS.minLocForSwarm;

  let reason = "below all thresholds";
  if (files.length > OMAR_SWARM_THRESHOLDS.minFilesForSwarm) {
    reason = `${files.length} files exceeds threshold (${OMAR_SWARM_THRESHOLDS.minFilesForSwarm})`;
  } else if (routeGroups.length >= OMAR_SWARM_THRESHOLDS.minRouteGroupsForSwarm) {
    reason = `${routeGroups.length} route groups exceeds threshold (${OMAR_SWARM_THRESHOLDS.minRouteGroupsForSwarm})`;
  } else if (estimatedLoc > OMAR_SWARM_THRESHOLDS.minLocForSwarm) {
    reason = `${estimatedLoc} LOC exceeds threshold (${OMAR_SWARM_THRESHOLDS.minLocForSwarm})`;
  }

  return {
    spawn,
    fileCount: files.length,
    routeGroups: routeGroups.length,
    routeGroupNames: routeGroups,
    estimatedLoc,
    reason,
    thresholds: { ...OMAR_SWARM_THRESHOLDS },
    maxConcurrent: OMAR_SWARM_THRESHOLDS.maxConcurrentAgents,
  };
}

export function partitionFiles(files = [], maxPerPartition = OMAR_SWARM_THRESHOLDS.maxFilesPerScanner) {
  const normalizedFiles = uniqueScopeFiles(files);
  const partitionSize = Math.max(1, Math.floor(normalizeNumber(maxPerPartition, OMAR_SWARM_THRESHOLDS.maxFilesPerScanner)));
  const partitions = [];
  for (let index = 0; index < normalizedFiles.length; index += partitionSize) {
    partitions.push(normalizedFiles.slice(index, index + partitionSize));
  }
  return partitions;
}

export function divideSwarmBudget(perPersonaCost, subagentCount) {
  const count = Math.max(1, Math.floor(normalizeNumber(subagentCount, 1)));
  const maxCostUsd = Math.max(0, normalizeNumber(perPersonaCost, 0)) / count;
  return {
    maxCostUsd,
    subagentCount: count,
  };
}

function summarizeFindings(findings = []) {
  const summary = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    const severity = normalizeString(finding.severity).toUpperCase();
    if (summary[severity] !== undefined) {
      summary[severity] += 1;
    } else {
      summary.P3 += 1;
    }
  }
  return {
    ...summary,
    blocking: summary.P0 > 0 || summary.P1 > 0,
  };
}

function personaAgentFromIdentity(identity = {}) {
  return {
    id: identity.id,
    persona: identity.fullName,
    shortName: identity.shortName,
    color: identity.color,
    avatar: identity.avatar,
    domain: identity.domain,
  };
}

function buildSubagentIdentity(identity, subagentIndex) {
  return {
    id: `${identity.id}-subagent-${subagentIndex}`,
    persona: `${identity.fullName} Subagent ${subagentIndex}`,
    shortName: `${identity.shortName || identity.id} #${subagentIndex}`,
    color: identity.color,
    avatar: identity.avatar,
    domain: identity.domain,
    parentId: identity.id,
  };
}

/**
 * Annotate persona result with visual identity so stream consumers
 * and downstream reports never see faceless persona IDs.
 */
function decoratePersonaResult(personaId, baseResult) {
  const visual = resolvePersonaVisual(personaId) || {};
  return {
    ...baseResult,
    personaId,
    persona: {
      id: personaId,
      shortName: visual.shortName || personaId,
      fullName: visual.fullName || personaId,
      avatar: visual.avatar || "",
      color: visual.color || "gray",
      domain: visual.domain || personaId,
    },
  };
}

function omargateConfidenceFloorForPersona(personaId) {
  return OMARGATE_CONFIDENCE_FLOORS[personaId] || OMARGATE_DEFAULT_CONFIDENCE_FLOOR;
}

async function runOmarPersonaSwarm({
  personaId,
  identity,
  targetPath,
  mode,
  runId,
  deterministic,
  outputDir,
  provider,
  model,
  perPersonaCost,
  dryRun,
  onEvent,
} = {}) {
  const scope = buildPersonaFileScope({ deterministic });
  const decision = decideSwarm({ scope });
  if (!decision.spawn || scope.files.length === 0) {
    return null;
  }

  const partitions = partitionFiles(scope.files, OMAR_SWARM_THRESHOLDS.maxFilesPerScanner);
  const budget = divideSwarmBudget(perPersonaCost, partitions.length);
  const maxConcurrent = Math.min(OMAR_SWARM_THRESHOLDS.maxConcurrentAgents, partitions.length);
  const swarmRunId = `${runId}-${personaId}-swarm`;
  const startedAt = Date.now();
  const blackboard = [];

  if (onEvent) {
    onEvent(createAgentEvent({
      event: "swarm_start",
      agent: personaAgentFromIdentity(identity),
      payload: {
        runId,
        swarmRunId,
        personaId,
        identity,
        mode,
        reason: decision.reason,
        fileCount: decision.fileCount,
        estimatedLoc: decision.estimatedLoc,
        routeGroups: decision.routeGroups,
        partitionCount: partitions.length,
        maxFilesPerSubagent: OMAR_SWARM_THRESHOLDS.maxFilesPerScanner,
        maxConcurrent,
        perPersonaCost,
        subagentMaxCostUsd: budget.maxCostUsd,
      },
      runId,
    }));
  }

  const parentRunDirectory = deterministic?.artifacts?.runDirectory || targetPath;
  const subagentResults = await runWithConcurrency(
    partitions.map((files, index) => ({ files, subagentIndex: index + 1 })),
    maxConcurrent,
    async ({ files, subagentIndex }) => {
      const subagentStart = Date.now();
      const subagentIdentity = buildSubagentIdentity(identity, subagentIndex);
      const scopedFiles = files.map((file) => file.path);
      const subagentRunId = `${swarmRunId}-${subagentIndex}`;

      if (onEvent) {
        onEvent(createAgentEvent({
          event: "agent_start",
          agent: subagentIdentity,
          payload: {
            runId,
            swarmRunId,
            subagentRunId,
            personaId,
            identity,
            subagentIndex,
            partitionCount: partitions.length,
            files: scopedFiles,
            fileCount: scopedFiles.length,
            maxCostUsd: budget.maxCostUsd,
          },
          runId,
        }));
      }

      try {
        const result = await runAiReviewLayer({
          targetPath,
          mode: "full",
          runId: subagentRunId,
          runDirectory: path.join(parentRunDirectory, "swarm", personaId, `subagent-${subagentIndex}`),
          deterministic: {
            ...deterministic,
            scope: {
              ...(deterministic?.scope || {}),
              scannedFiles: scopedFiles.length,
              scannedRelativeFiles: scopedFiles,
            },
            metadata: {
              ...(deterministic?.metadata || {}),
              omarSwarm: {
                personaId,
                subagentIndex,
                partitionCount: partitions.length,
                parentRunId: runId,
                swarmRunId,
              },
            },
          },
          outputDir,
          provider: provider || undefined,
          model: model || undefined,
          sessionId: `${subagentRunId}-ai`,
          maxCostUsd: budget.maxCostUsd,
          dryRun,
          env: process.env,
        });

        const personaConfidenceFloor = omargateConfidenceFloorForPersona(personaId);
        const findings = (result?.findings || []).map((finding) => {
          const normalized = {
            ...finding,
            persona: personaId,
            layer: personaId,
            confidenceFloor: personaConfidenceFloor,
            personaConfidenceFloor,
            swarm: {
              personaId,
              subagentIndex,
              partitionCount: partitions.length,
              files: scopedFiles,
            },
          };
          blackboard.push({
            agentId: subagentIdentity.id,
            source: personaId,
            ...normalized,
          });
          return normalized;
        });

        if (onEvent) {
          for (const finding of findings) {
            onEvent(createAgentEvent({
              event: "persona_finding",
              agent: personaAgentFromIdentity(identity),
              payload: { personaId, identity, subagentIndex, ...finding },
              runId,
            }));
          }
          onEvent(createAgentEvent({
            event: "agent_complete",
            agent: subagentIdentity,
            payload: {
              runId,
              swarmRunId,
              subagentRunId,
              personaId,
              subagentIndex,
              partitionCount: partitions.length,
              fileCount: scopedFiles.length,
              findings: findings.length,
              summary: result?.summary || summarizeFindings(findings),
              costUsd: result?.usage?.costUsd || 0,
              durationMs: Date.now() - subagentStart,
            },
            usage: {
              costUsd: result?.usage?.costUsd || 0,
              durationMs: Date.now() - subagentStart,
              toolCalls: result?.usage?.toolCalls || 0,
            },
            runId,
          }));
        }

        return {
          status: "ok",
          subagentIndex,
          agentId: subagentIdentity.id,
          files: scopedFiles,
          findings,
          summary: result?.summary || summarizeFindings(findings),
          costUsd: result?.usage?.costUsd || 0,
          model: result?.model || model || null,
          durationMs: Date.now() - subagentStart,
        };
      } catch (err) {
        if (onEvent) {
          onEvent(createAgentEvent({
            event: "agent_error",
            agent: subagentIdentity,
            payload: {
              runId,
              swarmRunId,
              subagentRunId,
              personaId,
              subagentIndex,
              partitionCount: partitions.length,
              error: err.message,
              durationMs: Date.now() - subagentStart,
            },
            usage: {
              costUsd: 0,
              durationMs: Date.now() - subagentStart,
              toolCalls: 0,
            },
            runId,
          }));
        }
        return {
          status: "error",
          subagentIndex,
          agentId: subagentIdentity.id,
          files: scopedFiles,
          findings: [],
          summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
          costUsd: 0,
          error: err.message,
          durationMs: Date.now() - subagentStart,
        };
      }
    }
  );

  const settledSubagents = subagentResults.map((result) =>
    result.status === "fulfilled"
      ? result.value
      : {
          status: "error",
          subagentIndex: 0,
          agentId: "unknown",
          files: [],
          findings: [],
          summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
          costUsd: 0,
          error: result.reason?.message || "unknown",
          durationMs: 0,
        }
  );
  const findings = settledSubagents.flatMap((result) => result.findings || []);
  const totalCostUsd = settledSubagents.reduce((sum, result) => sum + (result.costUsd || 0), 0);
  const summary = summarizeFindings(findings);
  const okCount = settledSubagents.filter((result) => result.status === "ok").length;
  const errorCount = settledSubagents.filter((result) => result.status === "error").length;

  if (onEvent) {
    onEvent(createAgentEvent({
      event: "swarm_complete",
      agent: personaAgentFromIdentity(identity),
      payload: {
        runId,
        swarmRunId,
        personaId,
        identity,
        subagentCount: settledSubagents.length,
        ok: okCount,
        error: errorCount,
        findings: findings.length,
        summary,
        totalCostUsd,
        durationMs: Date.now() - startedAt,
        blackboardEntries: blackboard.length,
      },
      usage: {
        costUsd: totalCostUsd,
        durationMs: Date.now() - startedAt,
        toolCalls: settledSubagents.length,
      },
      runId,
    }));
  }

  return {
    personaId,
    status: okCount > 0 ? "ok" : "error",
    findings,
    summary,
    costUsd: totalCostUsd,
    model: model || null,
    durationMs: Date.now() - startedAt,
    error: okCount > 0 ? null : settledSubagents.find((result) => result.error)?.error || null,
    swarm: {
      runId: swarmRunId,
      decision,
      subagentCount: settledSubagents.length,
      ok: okCount,
      error: errorCount,
      partitionSizes: partitions.map((files) => files.length),
      blackboardEntries: blackboard.length,
      subagents: settledSubagents.map((result) => ({
        id: result.agentId,
        index: result.subagentIndex,
        status: result.status,
        files: result.files,
        findings: (result.findings || []).length,
        costUsd: result.costUsd || 0,
        durationMs: result.durationMs || 0,
        error: result.error || null,
      })),
    },
  };
}

/**
 * Run the Omar Gate multi-persona orchestrator.
 *
 * @param {object} options
 * @param {string} options.targetPath - Repository path
 * @param {string} [options.scanMode] - "baseline", "deep", or "full-depth"
 * @param {number} [options.maxParallel] - Max concurrent persona calls (default 4)
 * @param {string} [options.provider] - LLM provider override
 * @param {string} [options.model] - LLM model override
 * @param {number} [options.maxCostUsd] - Global cost ceiling (default 5.0)
 * @param {boolean} [options.dryRun] - Dry-run mode (no LLM calls)
 * @param {string} [options.outputDir] - Output directory override
 * @param {object} [options.deterministic] - Deterministic scan results
 * @param {Function} [options.onEvent] - Event callback for streaming
 * @param {string[] | null} [options.includeOnly] - Only run these persona IDs (filters scan-mode roster).
 * @param {string[] | null} [options.skipPersonas] - Skip these persona IDs (filters scan-mode roster).
 * @returns {Promise<object>} Orchestrated results
 */
export async function runOmarGateOrchestrator({
  targetPath,
  scanMode = "deep",
  maxParallel = 4,
  provider = "",
  model = "",
  maxCostUsd = 5.0,
  dryRun = false,
  outputDir = "",
  deterministic = null,
  onEvent = null,
  includeOnly = null,
  skipPersonas = null,
} = {}) {
  const runId = `omargate-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();

  const filterRequested =
    (Array.isArray(includeOnly) && includeOnly.length > 0)
    || (Array.isArray(skipPersonas) && skipPersonas.length > 0);

  const resolved = filterRequested
    ? resolveFilteredPersonas(scanMode, {
        includeOnly: Array.isArray(includeOnly) ? includeOnly : undefined,
        skipPersonas: Array.isArray(skipPersonas) ? skipPersonas : undefined,
      })
    : { ...resolveScanMode(scanMode), dropped: [], unknown: [] };

  const { mode, personas } = resolved;
  const droppedPersonas = resolved.dropped || [];
  const unknownPersonas = resolved.unknown || [];

  if (onEvent && (droppedPersonas.length > 0 || unknownPersonas.length > 0)) {
    onEvent(createAgentEvent({
      event: "omargate_persona_filter",
      agent: OMAR_ORCHESTRATOR_AGENT,
      payload: {
        runId,
        mode,
        dropped: droppedPersonas,
        unknown: unknownPersonas,
        effective: personas,
      },
      runId,
    }));
  }

  const roster = personas.map((personaId) => {
    const visual = resolvePersonaVisual(personaId) || {};
    return {
      id: personaId,
      shortName: visual.shortName || personaId,
      fullName: visual.fullName || personaId,
      avatar: visual.avatar || "",
      color: visual.color || "gray",
      domain: visual.domain || personaId,
    };
  });

  if (onEvent) {
    onEvent(createAgentEvent({
      event: "omargate_start",
      agent: OMAR_ORCHESTRATOR_AGENT,
      payload: { runId, mode, personas, roster, maxParallel, maxCostUsd, dryRun },
      runId,
    }));
  }

  const detSummary = deterministic?.summary || { P0: 0, P1: 0, P2: 0, P3: 0 };
  const detFindings = deterministic?.findings || [];

  // Per-persona cost budget = global / persona count (with minimum floor)
  const perPersonaCost = Math.max(0.25, maxCostUsd / personas.length);
  let runningCostUsd = 0;

  const personaResults = await runWithConcurrency(personas, maxParallel, async (personaId) => {
    const visual = resolvePersonaVisual(personaId) || {};
    const identity = {
      id: personaId,
      shortName: visual.shortName || personaId,
      fullName: visual.fullName || personaId,
      avatar: visual.avatar || "",
      color: visual.color || "gray",
      domain: visual.domain || personaId,
    };

    // Global budget check — skip remaining personas if exhausted
    if (runningCostUsd >= maxCostUsd) {
      if (onEvent) {
        onEvent(createAgentEvent({
          event: "persona_skipped",
          agent: {
            id: identity.id,
            persona: identity.fullName,
            shortName: identity.shortName,
            color: identity.color,
            avatar: identity.avatar,
            domain: identity.domain,
          },
          payload: { personaId, identity, reason: "global_budget_exhausted", runningCostUsd, maxCostUsd },
          runId,
        }));
      }
      return {
        personaId,
        status: "skipped",
        findings: [],
        summary: { P0: 0, P1: 0, P2: 0, P3: 0 },
        costUsd: 0,
        durationMs: 0,
        reason: "global_budget_exhausted",
      };
    }

    const personaStart = Date.now();

    if (onEvent) {
      onEvent(createAgentEvent({
        event: "persona_start",
        agent: {
          id: identity.id,
          persona: identity.fullName,
          shortName: identity.shortName,
          color: identity.color,
          avatar: identity.avatar,
          domain: identity.domain,
        },
        payload: { personaId, identity, mode, runId },
        runId,
      }));
    }

    try {
      const swarmResult = await runOmarPersonaSwarm({
        personaId,
        identity,
        targetPath,
        mode,
        runId,
        deterministic,
        outputDir,
        provider,
        model,
        perPersonaCost,
        dryRun,
        onEvent,
      });

      if (swarmResult) {
        const personaCost = swarmResult.costUsd || 0;
        runningCostUsd += personaCost;

        if (onEvent) {
          if (swarmResult.status === "error") {
            onEvent(createAgentEvent({
              event: "persona_error",
              agent: personaAgentFromIdentity(identity),
              payload: {
                personaId,
                identity,
                error: swarmResult.error || "all subagents failed",
                swarm: swarmResult.swarm,
              },
              runId,
            }));
          } else {
            onEvent(createAgentEvent({
              event: "persona_complete",
              agent: personaAgentFromIdentity(identity),
              payload: {
                personaId,
                identity,
                findings: swarmResult.findings.length,
                summary: swarmResult.summary,
                costUsd: personaCost,
                durationMs: Date.now() - personaStart,
                swarm: swarmResult.swarm,
              },
              runId,
            }));
          }
        }

        return {
          ...swarmResult,
          durationMs: Date.now() - personaStart,
        };
      }

      const systemPrompt = buildPersonaReviewPrompt({
        personaId,
        targetPath,
        deterministicSummary: detSummary,
      });

      const result = await runAiReviewLayer({
        targetPath,
        mode: "full",
        runId: `${runId}-${personaId}`,
        runDirectory: targetPath,
        deterministic: {
          summary: detSummary,
          findings: detFindings,
          metadata: deterministic?.metadata || {},
        },
        outputDir,
        provider: provider || undefined,
        model: model || undefined,
        maxCostUsd: perPersonaCost,
        dryRun,
        env: process.env,
      });

      const personaConfidenceFloor = omargateConfidenceFloorForPersona(personaId);
      const findings = (result?.findings || []).map((f) => ({
        ...f,
        persona: personaId,
        layer: personaId,
        confidenceFloor: personaConfidenceFloor,
        personaConfidenceFloor,
      }));

      if (onEvent) {
        for (const finding of findings) {
          onEvent(createAgentEvent({
            event: "persona_finding",
            agent: {
              id: identity.id,
              persona: identity.fullName,
              shortName: identity.shortName,
              color: identity.color,
              avatar: identity.avatar,
              domain: identity.domain,
            },
            payload: { personaId, identity, ...finding },
            runId,
          }));
        }
        onEvent(createAgentEvent({
          event: "persona_complete",
          agent: {
            id: identity.id,
            persona: identity.fullName,
            shortName: identity.shortName,
            color: identity.color,
            avatar: identity.avatar,
            domain: identity.domain,
          },
          payload: {
            personaId,
            identity,
            findings: findings.length,
            summary: result?.summary || {},
            costUsd: result?.costUsd || 0,
            durationMs: Date.now() - personaStart,
          },
          runId,
        }));
      }

      const personaCost = result?.costUsd || 0;
      runningCostUsd += personaCost;

      return {
        personaId,
        status: "ok",
        findings,
        summary: result?.summary || { P0: 0, P1: 0, P2: 0, P3: 0 },
        costUsd: personaCost,
        model: result?.model || model || null,
        durationMs: Date.now() - personaStart,
      };
    } catch (err) {
      if (onEvent) {
        onEvent(createAgentEvent({
          event: "persona_error",
          agent: {
            id: identity.id,
            persona: identity.fullName,
            shortName: identity.shortName,
            color: identity.color,
            avatar: identity.avatar,
            domain: identity.domain,
          },
          payload: { personaId, identity, error: err.message },
          runId,
        }));
      }
      return {
        personaId,
        status: "error",
        findings: [],
        summary: { P0: 0, P1: 0, P2: 0, P3: 0 },
        costUsd: 0,
        error: err.message,
        durationMs: Date.now() - personaStart,
      };
    }
  });

  // Collect results (handle settled promises)
  const settled = personaResults.map((r) =>
    r.status === "fulfilled"
      ? decoratePersonaResult(r.value.personaId, r.value)
      : decoratePersonaResult("unknown", {
          status: "error",
          findings: [],
          summary: { P0: 0, P1: 0, P2: 0, P3: 0 },
          costUsd: 0,
          error: r.reason?.message || "unknown",
          durationMs: 0,
        })
  );

  // Reconcile AI findings with deterministic findings — canonical single list.
  // Confidence boost when multiple layers agree; deterministic findings get
  // confidence 1.0; AI findings keep their self-reported confidence.
  const allAiFindings = settled.flatMap((r) => r.findings);
  const reconciled = reconcileReviewFindings({
    deterministicFindings: detFindings,
    aiFindings: allAiFindings,
    defaultConfidenceFloor: OMARGATE_DEFAULT_CONFIDENCE_FLOOR,
    confidenceFloors: OMARGATE_CONFIDENCE_FLOORS,
  });
  const reconciledFindings = reconciled.findings;
  const reconciledSummary = reconciled.summary;
  const droppedBelowConfidence = Number(reconciledSummary?.droppedBelowConfidence || 0);
  const candidateFindingCount = detFindings.length + allAiFindings.length;
  const dedupedCount = Math.max(
    0,
    candidateFindingCount - reconciledFindings.length - droppedBelowConfidence
  );

  const totalCost = settled.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const totalDuration = Date.now() - startTime;

  // Silent-failure detection: if >=50% of personas errored OR total cost is
  // zero with non-zero personas dispatched, treat as a LOUD orchestrator
  // warning. Prior behavior silently returned zero AI findings, masking
  // auth failures or LLM proxy outages as "clean scan".
  const personaErrorCount = settled.filter((r) => r.status === "error").length;
  const personaSkippedCount = settled.filter((r) => r.status === "skipped").length;
  const personaOkCount = settled.filter((r) => r.status === "ok").length;
  const totalPersonas = settled.length;
  const errorRatio = totalPersonas > 0 ? personaErrorCount / totalPersonas : 0;
  const aiCoverageHealthy =
    totalPersonas === 0 ||
    (personaOkCount > 0 && totalCost > 0 && errorRatio < 0.5 && !dryRun);

  const personaHealth = {
    ok: personaOkCount,
    error: personaErrorCount,
    skipped: personaSkippedCount,
    total: totalPersonas,
    errorRatio,
    healthy: aiCoverageHealthy || dryRun,
    warnings: [],
  };
  if (!dryRun && totalPersonas > 0) {
    if (personaOkCount === 0 && personaErrorCount > 0) {
      personaHealth.warnings.push(
        `ALL ${totalPersonas} personas errored. AI coverage is ZERO. Re-check auth (sl auth login) or LLM proxy config.`
      );
    } else if (errorRatio >= 0.5) {
      personaHealth.warnings.push(
        `${personaErrorCount}/${totalPersonas} personas errored (${Math.round(errorRatio * 100)}%). AI coverage is degraded.`
      );
    }
    if (personaOkCount > 0 && totalCost <= 0) {
      personaHealth.warnings.push(
        `Personas reported ok status but totalCost=$0.00 — likely silently returned empty findings without making LLM calls.`
      );
    }
  }

  const result = {
    runId,
    mode,
    roster,
    personas: settled.map((r) => ({
      id: r.personaId,
      identity: r.persona,
      status: r.status,
      findings: (r.findings || []).length,
      summary: r.summary || { P0: 0, P1: 0, P2: 0, P3: 0 },
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      model: r.model || null,
      error: r.error || null,
      swarm: r.swarm || null,
    })),
    personaHealth,
    findings: reconciledFindings,
    findingsBySource: {
      deterministic: detFindings.length,
      ai: allAiFindings.length,
      reconciled: reconciledFindings.length,
      droppedBelowConfidence,
    },
    summary: reconciledSummary,
    totalCostUsd: totalCost,
    totalDurationMs: totalDuration,
    reconciliation: {
      deterministicFindings: detFindings.length,
      aiFindings: allAiFindings.length,
      reconciledFindings: reconciledFindings.length,
      dedupedCount,
      droppedBelowConfidence,
      droppedLowConfidence: droppedBelowConfidence,
      droppedLowConfidenceSingleSource: Number(
        reconciledSummary?.droppedBelowConfidenceSingleSource || droppedBelowConfidence
      ),
      multiSourceFindings: reconciledFindings.filter(
        (f) => Array.isArray(f.sources) && f.sources.length > 1
      ).length,
    },
    dryRun,
  };

  // Emit warnings to the event stream so terminal handler can render them.
  if (onEvent && personaHealth.warnings.length > 0) {
    onEvent(createAgentEvent({
      event: "persona_health_warning",
      agent: { id: "orchestrator", persona: "Omar Orchestrator" },
      payload: {
        ok: personaOkCount,
        error: personaErrorCount,
        total: totalPersonas,
        errorRatio,
        warnings: personaHealth.warnings,
      },
      runId,
    }));
  }

  if (onEvent) {
    onEvent(createAgentEvent({
      event: "omargate_complete",
      agent: OMAR_ORCHESTRATOR_AGENT,
      payload: {
        runId,
        mode,
        personaCount: settled.length,
        findings: reconciledFindings.length,
        summary: result.summary,
        reconciliation: result.reconciliation,
        totalCostUsd: totalCost,
        totalDurationMs: totalDuration,
      },
      runId,
    }));
  }

  // Fire-and-forget telemetry sync to dashboard
  syncRunToDashboard({
    command: `omargate deep --scan-mode ${mode}`,
    persona: "omar-orchestrator",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: totalCost,
      durationMs: totalDuration,
      toolCalls: personas.length,
    },
    summary: result.summary,
    reconciliation: result.reconciliation,
    stopReason: result.summary.blocking ? "blocked" : "passed",
    personaBreakdown: settled.map((r) => ({
      personaId: r.personaId,
      fullName: r.persona?.fullName || r.personaId,
      findings: r.findings?.length || 0,
      costUsd: r.costUsd || 0,
      durationMs: r.durationMs || 0,
      status: r.status,
      swarm: r.swarm
        ? {
            subagentCount: r.swarm.subagentCount || 0,
            ok: r.swarm.ok || 0,
            error: r.swarm.error || 0,
          }
        : null,
    })),
  }).catch(() => {});

  return result;
}
