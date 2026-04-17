/**
 * Omar Gate multi-persona orchestrator.
 *
 * Runs N persona-scoped AI review calls in parallel (bounded concurrency),
 * merges findings into a blackboard, deduplicates, and produces a unified report.
 */

import { randomUUID } from "node:crypto";

import { runAiReviewLayer } from "./ai-review.js";
import { buildPersonaReviewPrompt, PERSONA_IDS } from "./persona-prompts.js";
import { resolveScanMode } from "./scan-modes.js";
import { reconcileReviewFindings } from "./report.js";
import { resolvePersonaVisual } from "../agents/persona-visuals.js";
import { syncRunToDashboard } from "../telemetry/sync.js";
import { createAgentEvent } from "../events/schema.js";

const OMAR_ORCHESTRATOR_AGENT = Object.freeze({
  id: "omar-orchestrator",
  persona: "Omar Gate Orchestrator",
});

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
    const p = fn(item).then((result) => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= maxConcurrent) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
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
} = {}) {
  const runId = `omargate-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();

  const { mode, personas } = resolveScanMode(scanMode);

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

      const findings = (result?.findings || []).map((f) => ({
        ...f,
        persona: personaId,
        layer: personaId,
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
  });
  const reconciledFindings = reconciled.findings;
  const reconciledSummary = reconciled.summary;

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
    })),
    personaHealth,
    findings: reconciledFindings,
    findingsBySource: {
      deterministic: detFindings.length,
      ai: allAiFindings.length,
      reconciled: reconciledFindings.length,
    },
    summary: reconciledSummary,
    totalCostUsd: totalCost,
    totalDurationMs: totalDuration,
    reconciliation: {
      deterministicFindings: detFindings.length,
      aiFindings: allAiFindings.length,
      reconciledFindings: reconciledFindings.length,
      dedupedCount: detFindings.length + allAiFindings.length - reconciledFindings.length,
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
    })),
  }).catch(() => {});

  return result;
}
