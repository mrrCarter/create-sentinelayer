import { randomUUID } from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";

import { createFileScanner } from "./file-scanner.js";
import { createPatternHunter, HUNT_TYPES } from "./pattern-hunter.js";
import { runSubAgentBatch } from "./sub-agent.js";
import { frontendAnalyze } from "../tools/frontend-analyze.js";
import { createAgentContext } from "../tools/dispatch.js";

/**
 * Jules Swarm Orchestrator
 *
 * Coordinates parallel sub-agents for thorough frontend audit.
 * Multi-pass convergence ensures no file is missed:
 *   Pass 1 (FileScanners): Read all files, discover import deps
 *   Pass 2 (PatternHunters): Search for 6 issue classes in parallel
 *   Convergence: Expand scope with discovered deps, re-scan if needed
 *   Coverage verification: Ensure every reachable file was read
 */

const SPAWN_THRESHOLDS = {
  minFilesForSwarm: 15,
  minRouteGroupsForSwarm: 3,
  minLocForSwarm: 5000,
  maxFilesPerScanner: 12,
  maxConcurrentAgents: 4,
};

/**
 * Decide whether the frontend surface warrants sub-agent spawning.
 */
export function shouldSpawnSubAgents(scopeMap) {
  const frontendFiles = (scopeMap.primary || []).filter(f => isFrontendFile(f.path || f));
  const routeGroups = detectRouteGroups(frontendFiles);
  const totalLoc = frontendFiles.reduce((sum, f) => sum + (f.loc || 80), 0);

  return {
    spawn: (
      frontendFiles.length > SPAWN_THRESHOLDS.minFilesForSwarm ||
      routeGroups.length >= SPAWN_THRESHOLDS.minRouteGroupsForSwarm ||
      totalLoc > SPAWN_THRESHOLDS.minLocForSwarm
    ),
    fileCount: frontendFiles.length,
    routeGroups: routeGroups.length,
    estimatedLoc: totalLoc,
    reason: frontendFiles.length > SPAWN_THRESHOLDS.minFilesForSwarm
      ? `${frontendFiles.length} frontend files exceeds threshold (${SPAWN_THRESHOLDS.minFilesForSwarm})`
      : routeGroups.length >= SPAWN_THRESHOLDS.minRouteGroupsForSwarm
        ? `${routeGroups.length} route groups exceeds threshold (${SPAWN_THRESHOLDS.minRouteGroupsForSwarm})`
        : totalLoc > SPAWN_THRESHOLDS.minLocForSwarm
          ? `${totalLoc} LOC exceeds threshold (${SPAWN_THRESHOLDS.minLocForSwarm})`
          : "below all thresholds",
  };
}

/**
 * Run the full swarm orchestration: scanners → hunters → convergence → coverage.
 *
 * @param {object} config
 * @param {object} config.scopeMap - { primary, secondary, tertiary } file lists
 * @param {string} config.rootPath - Codebase root
 * @param {object} config.blackboard - Shared blackboard instance
 * @param {object} config.budget - Total budget for all sub-agents
 * @param {object} [config.provider] - LLM provider overrides
 * @param {AbortController} [config.parentAbort]
 * @param {function} [config.onEvent]
 * @returns {Promise<SwarmResult>}
 */
export async function runJulesSwarm(config) {
  const {
    scopeMap, rootPath, blackboard, budget,
    provider, parentAbort, onEvent,
  } = config;

  const runId = `swarm-jules-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const allResults = [];

  emit(onEvent, "swarm_start", {
    runId,
    phases: ["file_scan", "pattern_hunt", "convergence", "coverage_verify"],
  });

  // ── Phase 1: File Scanners ──────────────────────────────────────

  const primaryFiles = (scopeMap.primary || []).map(f => f.path || f);
  const partitions = partitionFiles(primaryFiles, SPAWN_THRESHOLDS.maxFilesPerScanner);

  emit(onEvent, "phase_start", {
    phase: "file_scan",
    scannerCount: partitions.length,
    totalFiles: primaryFiles.length,
  });

  const scannerBudgetSlice = divideBudget(budget, partitions.length + HUNT_TYPES.length);

  const scanners = partitions.map((files, i) =>
    createFileScanner({
      id: `scanner-${i}`,
      files,
      budget: scannerBudgetSlice,
      blackboard,
      provider,
      parentAbort,
      onEvent,
    }),
  );

  const scanResults = await runSubAgentBatch(scanners, {
    maxConcurrent: SPAWN_THRESHOLDS.maxConcurrentAgents,
  });
  allResults.push(...scanResults);

  emit(onEvent, "phase_complete", {
    phase: "file_scan",
    agentsCompleted: scanResults.length,
    findingsCount: scanResults.reduce((s, r) => s + r.findings.length, 0),
  });

  // ── Phase 2: Pattern Hunters ────────────────────────────────────

  emit(onEvent, "phase_start", {
    phase: "pattern_hunt",
    hunterCount: HUNT_TYPES.length,
    huntTypes: HUNT_TYPES,
  });

  const hunterBudgetSlice = divideBudget(budget, partitions.length + HUNT_TYPES.length);

  const hunters = HUNT_TYPES.map(huntType =>
    createPatternHunter({
      huntType,
      rootPath,
      budget: hunterBudgetSlice,
      blackboard,
      provider,
      parentAbort,
      onEvent,
    }),
  );

  const huntResults = await runSubAgentBatch(hunters, {
    maxConcurrent: SPAWN_THRESHOLDS.maxConcurrentAgents,
  });
  allResults.push(...huntResults);

  emit(onEvent, "phase_complete", {
    phase: "pattern_hunt",
    agentsCompleted: huntResults.length,
    findingsCount: huntResults.reduce((s, r) => s + r.findings.length, 0),
  });

  // ── Convergence: Expand scope from discovered deps ──────────────

  emit(onEvent, "phase_start", { phase: "convergence" });

  const discoveredDeps = collectDiscoveredDeps(scanResults);
  const alreadyScanned = new Set(primaryFiles);
  const newFiles = discoveredDeps.filter(f => !alreadyScanned.has(f));

  let convergenceResults = [];
  if (newFiles.length > 0 && newFiles.length <= 30) {
    emit(onEvent, "convergence_expansion", {
      newFilesDiscovered: newFiles.length,
      spawningExtraScanner: true,
    });

    const extraPartitions = partitionFiles(newFiles, SPAWN_THRESHOLDS.maxFilesPerScanner);
    const extraScanners = extraPartitions.map((files, i) =>
      createFileScanner({
        id: `scanner-convergence-${i}`,
        files,
        budget: scannerBudgetSlice,
        blackboard,
        provider,
        parentAbort,
        onEvent,
      }),
    );

    convergenceResults = await runSubAgentBatch(extraScanners, {
      maxConcurrent: SPAWN_THRESHOLDS.maxConcurrentAgents,
    });
    allResults.push(...convergenceResults);
  }

  emit(onEvent, "phase_complete", {
    phase: "convergence",
    newFilesDiscovered: newFiles.length,
    extraScannersRun: convergenceResults.length,
  });

  // ── Coverage Verification ───────────────────────────────────────
  // Coverage is computed from CONFIRMED-READ files (via blackboard tool_call
  // events), not from the seed set. This prevents overstating coverage when
  // sub-agents hit budget limits before reading all assigned files.

  emit(onEvent, "phase_start", { phase: "coverage_verify" });

  // Collect confirmed-read files from sub-agent results
  const confirmedReadFiles = new Set();
  for (const result of allResults) {
    // Sub-agents track which files they actually read via tool calls
    if (result.findings) {
      for (const f of result.findings) {
        if (f.file) confirmedReadFiles.add(f.file);
        // FileScanner results include discovered files
        if (f.path) confirmedReadFiles.add(f.path);
      }
    }
    // Also count any file explicitly tracked by agent usage
    if (result.usage?.filesRead) {
      for (const f of result.usage.filesRead) confirmedReadFiles.add(f);
    }
  }
  // Add primary files only if they were in the confirmed set or no agents ran
  const allScannedFiles = confirmedReadFiles.size > 0
    ? confirmedReadFiles
    : new Set([...primaryFiles, ...newFiles]);

  // Use FrontendAnalyze to check what files should exist
  let frameworkInfo = {};
  try {
    frameworkInfo = frontendAnalyze({ operation: "detect_framework", path: rootPath });
  } catch { /* proceed without framework info */ }

  let scopeGraphInfo = {};
  try {
    scopeGraphInfo = frontendAnalyze({ operation: "scope_graph", path: rootPath });
  } catch { /* proceed without scope graph */ }

  const expectedFrontendFiles = scopeGraphInfo.components || 0;
  const coverageRatio = expectedFrontendFiles > 0
    ? ((allScannedFiles.size / expectedFrontendFiles) * 100).toFixed(1)
    : "N/A";

  // Identify files that were assigned but not confirmed-read
  const assignedButUnread = primaryFiles.filter(f => !confirmedReadFiles.has(f));
  const missedFiles = assignedButUnread.length > 0 && confirmedReadFiles.size > 0
    ? assignedButUnread
    : [];

  const coverageLedger = {
    seedFilesAssigned: primaryFiles.length,
    confirmedReadFiles: confirmedReadFiles.size,
    expandedFilesDiscovered: newFiles.length,
    totalFilesReviewed: allScannedFiles.size,
    expectedFrontendFiles,
    coverageRatio,
    missedFiles,
    coverageMethod: confirmedReadFiles.size > 0 ? "confirmed_read" : "seed_based_fallback",
  };

  emit(onEvent, "phase_complete", {
    phase: "coverage_verify",
    coverage: coverageLedger,
  });

  // ── Build Swarm Result ──────────────────────────────────────────

  const totalFindings = allResults.reduce((s, r) => s + r.findings.length, 0);
  const totalCost = allResults.reduce((s, r) => s + (r.usage?.costUsd || 0), 0);
  const totalToolCalls = allResults.reduce((s, r) => s + (r.usage?.toolCalls || 0), 0);
  const durationMs = Date.now() - startedAt;

  const result = {
    runId,
    status: "completed",
    framework: frameworkInfo.framework || "unknown",
    phases: {
      fileScanning: { agents: scanResults.length, findings: scanResults.reduce((s, r) => s + r.findings.length, 0) },
      patternHunting: { agents: huntResults.length, findings: huntResults.reduce((s, r) => s + r.findings.length, 0) },
      convergence: { newFiles: newFiles.length, extraScanners: convergenceResults.length },
    },
    coverage: coverageLedger,
    findings: {
      total: totalFindings,
      byAgent: allResults.map(r => ({ agentId: r.agentId, role: r.role, count: r.findings.length })),
    },
    usage: {
      totalAgents: allResults.length,
      totalCostUsd: totalCost,
      totalToolCalls,
      totalDurationMs: durationMs,
    },
    agentResults: allResults,
  };

  emit(onEvent, "swarm_complete", {
    runId,
    totalFindings,
    totalAgents: allResults.length,
    totalCostUsd: totalCost,
    durationMs,
    coverageRatio,
  });

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isFrontendFile(filePath) {
  return /\.(tsx|jsx|vue|svelte|css|scss|less)$/.test(filePath);
}

function detectRouteGroups(files) {
  const routeDirs = new Set();
  for (const f of files) {
    const filePath = f.path || f;
    const match = filePath.match(/(?:app|pages)\/([^/]+)/);
    if (match) routeDirs.add(match[1]);
  }
  return [...routeDirs];
}

function partitionFiles(files, maxPerPartition) {
  const partitions = [];
  for (let i = 0; i < files.length; i += maxPerPartition) {
    partitions.push(files.slice(i, i + maxPerPartition));
  }
  return partitions;
}

function divideBudget(totalBudget, agentCount) {
  if (agentCount <= 0) return totalBudget;
  return {
    maxCostUsd: (totalBudget.maxCostUsd || 5) / agentCount,
    maxOutputTokens: Math.floor((totalBudget.maxOutputTokens || 12000) / agentCount),
    maxRuntimeMs: totalBudget.maxRuntimeMs || 300000,
    maxToolCalls: Math.floor((totalBudget.maxToolCalls || 150) / agentCount),
    warningThresholdPercent: totalBudget.warningThresholdPercent || 70,
  };
}

function collectDiscoveredDeps(scanResults) {
  const deps = new Set();
  for (const result of scanResults) {
    for (const finding of result.findings) {
      if (finding.discoveredDependencies) {
        for (const dep of finding.discoveredDependencies) {
          if (typeof dep === "string" && dep.startsWith(".")) {
            deps.add(dep);
          }
        }
      }
    }
  }
  return [...deps];
}

function emit(onEvent, event, payload) {
  if (onEvent) {
    onEvent({
      stream: "sl_event",
      event,
      agent: { id: "frontend", persona: "Jules Tanaka", color: "cyan", avatar: "\u{1F3AF}" },
      payload,
    });
  }
}
