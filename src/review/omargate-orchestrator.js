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
 * Deduplicate findings by file:line:title key.
 */
function deduplicateFindings(allFindings) {
  const seen = new Set();
  const unique = [];
  for (const finding of allFindings) {
    const key = `${finding.file || ""}:${finding.line || 0}:${String(finding.title || finding.message || "").toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
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

  if (onEvent) {
    onEvent({
      stream: "sl_event",
      event: "omargate_start",
      payload: { runId, mode, personas, maxParallel, maxCostUsd, dryRun },
    });
  }

  const detSummary = deterministic?.summary || { P0: 0, P1: 0, P2: 0, P3: 0 };
  const detFindings = deterministic?.findings || [];

  // Per-persona cost budget = global / persona count (with minimum floor)
  const perPersonaCost = Math.max(0.25, maxCostUsd / personas.length);

  const personaResults = await runWithConcurrency(personas, maxParallel, async (personaId) => {
    const personaStart = Date.now();

    if (onEvent) {
      onEvent({
        stream: "sl_event",
        event: "persona_start",
        payload: { personaId, mode, runId },
      });
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
          onEvent({
            stream: "sl_event",
            event: "persona_finding",
            payload: { personaId, ...finding },
          });
        }
        onEvent({
          stream: "sl_event",
          event: "persona_complete",
          payload: {
            personaId,
            findings: findings.length,
            summary: result?.summary || {},
            costUsd: result?.costUsd || 0,
            durationMs: Date.now() - personaStart,
          },
        });
      }

      return {
        personaId,
        status: "ok",
        findings,
        summary: result?.summary || { P0: 0, P1: 0, P2: 0, P3: 0 },
        costUsd: result?.costUsd || 0,
        model: result?.model || model || null,
        durationMs: Date.now() - personaStart,
      };
    } catch (err) {
      if (onEvent) {
        onEvent({
          stream: "sl_event",
          event: "persona_error",
          payload: { personaId, error: err.message },
        });
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
    r.status === "fulfilled" ? r.value : { personaId: "unknown", status: "error", findings: [], summary: { P0: 0, P1: 0, P2: 0, P3: 0 }, costUsd: 0, error: r.reason?.message || "unknown" }
  );

  // Merge and deduplicate findings
  const allAiFindings = settled.flatMap((r) => r.findings);
  const uniqueFindings = deduplicateFindings(allAiFindings);

  // Compute combined summary
  const combinedP0 = uniqueFindings.filter((f) => f.severity === "P0").length;
  const combinedP1 = uniqueFindings.filter((f) => f.severity === "P1").length;
  const combinedP2 = uniqueFindings.filter((f) => f.severity === "P2").length;
  const combinedP3 = uniqueFindings.filter((f) => f.severity === "P3").length;
  const totalCost = settled.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  const totalDuration = Date.now() - startTime;

  const result = {
    runId,
    mode,
    personas: settled.map((r) => ({
      id: r.personaId,
      status: r.status,
      findings: r.findings.length,
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      error: r.error || null,
    })),
    findings: uniqueFindings,
    summary: {
      P0: combinedP0,
      P1: combinedP1,
      P2: combinedP2,
      P3: combinedP3,
      blocking: combinedP0 > 0 || combinedP1 > 0,
    },
    totalCostUsd: totalCost,
    totalDurationMs: totalDuration,
    dryRun,
  };

  if (onEvent) {
    onEvent({
      stream: "sl_event",
      event: "omargate_complete",
      payload: {
        runId,
        mode,
        personaCount: settled.length,
        findings: uniqueFindings.length,
        summary: result.summary,
        totalCostUsd: totalCost,
        totalDurationMs: totalDuration,
      },
    });
  }

  return result;
}
