/**
 * Unified per-persona runner for investor-DD (#investor-dd-4..15).
 *
 * Wires the 12 domain personas (security, backend, code-quality, testing,
 * data-layer, reliability, release, observability, infrastructure,
 * supply-chain, documentation, ai-governance) into the per-file review
 * loop. Each persona dispatches its declared domain tools against every
 * file the router assigns to it, collects findings, and returns a
 * per-persona coverage proof.
 *
 * This runner runs the tool registries DETERMINISTICALLY — the agentic
 * (LLM-driven) layer sits on top in a later PR. Determinism is the
 * investor-DD ground-truth floor; the LLM layer is additive.
 *
 * Frontend (Jules) is excluded here because Jules has its own bespoke
 * envelope with live-web validation; PR-25 routes Jules into investor-DD
 * via a dedicated live-validator dispatcher.
 */

import { AI_GOVERNANCE_TOOLS } from "../agents/ai-governance/tools/index.js";
import { BACKEND_TOOLS } from "../agents/backend/tools/index.js";
import { CODE_QUALITY_TOOLS } from "../agents/code-quality/tools/index.js";
import { DATA_LAYER_TOOLS } from "../agents/data-layer/tools/index.js";
import { DOCUMENTATION_TOOLS } from "../agents/documentation/tools/index.js";
import { INFRASTRUCTURE_TOOLS } from "../agents/infrastructure/tools/index.js";
import { OBSERVABILITY_TOOLS } from "../agents/observability/tools/index.js";
import { RELEASE_TOOLS } from "../agents/release/tools/index.js";
import { RELIABILITY_TOOLS } from "../agents/reliability/tools/index.js";
import { SECURITY_TOOLS } from "../agents/security/tools/index.js";
import { SUPPLY_CHAIN_TOOLS } from "../agents/supply-chain/tools/index.js";
import { TESTING_TOOLS } from "../agents/testing/tools/index.js";

import { checkBudget, createBudgetState } from "./investor-dd-file-loop.js";

/**
 * Registry of persona → tool map. Frontend handled separately via Jules.
 */
export const INVESTOR_DD_PERSONA_TOOL_REGISTRY = Object.freeze({
  security: SECURITY_TOOLS,
  backend: BACKEND_TOOLS,
  "code-quality": CODE_QUALITY_TOOLS,
  testing: TESTING_TOOLS,
  "data-layer": DATA_LAYER_TOOLS,
  reliability: RELIABILITY_TOOLS,
  release: RELEASE_TOOLS,
  observability: OBSERVABILITY_TOOLS,
  infrastructure: INFRASTRUCTURE_TOOLS,
  "supply-chain": SUPPLY_CHAIN_TOOLS,
  documentation: DOCUMENTATION_TOOLS,
  "ai-governance": AI_GOVERNANCE_TOOLS,
});

export const INVESTOR_DD_PERSONA_IDS = Object.freeze(
  Object.keys(INVESTOR_DD_PERSONA_TOOL_REGISTRY),
);

/**
 * Resolve the tool list for a given persona.
 *
 * @param {string} personaId
 * @returns {Array<{id: string, handler: Function, description: string}>}
 */
export function getPersonaTools(personaId) {
  const map = INVESTOR_DD_PERSONA_TOOL_REGISTRY[personaId];
  if (!map) return [];
  return Object.values(map);
}

/**
 * Dispatch every tool for the persona against a single file scope. Each
 * tool handler is invoked with `{ rootPath, files: [file] }` because
 * every persona's tool contract accepts this shape (see #A13-#A22).
 *
 * @param {object} params
 * @param {string} params.personaId
 * @param {string} params.file            - Single file (relative to rootPath).
 * @param {string} params.rootPath        - Repo root.
 * @param {object} params.budget          - Shared budget state.
 * @param {Function} [params.onEvent]
 * @returns {Promise<{findings: Array, toolInvocations: Array, stoppedEarly: boolean}>}
 */
export async function runPersonaOnFile({
  personaId,
  file,
  rootPath,
  budget,
  onEvent = () => {},
} = {}) {
  if (!personaId) throw new TypeError("runPersonaOnFile requires personaId");
  if (!file) throw new TypeError("runPersonaOnFile requires file");
  if (!rootPath) throw new TypeError("runPersonaOnFile requires rootPath");

  const tools = getPersonaTools(personaId);
  const findings = [];
  const toolInvocations = [];
  let stoppedEarly = false;

  for (const tool of tools) {
    const budgetCheck = checkBudget(budget);
    if (!budgetCheck.ok) {
      stoppedEarly = true;
      onEvent({
        type: "persona_tool_skipped",
        personaId,
        file,
        tool: tool.id,
        stopReason: budgetCheck.reason,
      });
      continue;
    }

    onEvent({ type: "persona_file_tool_call", personaId, file, tool: tool.id });

    try {
      const results = await tool.handler({ rootPath, files: [file] });
      if (budget) budget.toolCalls = (budget.toolCalls || 0) + 1;
      const normalized = Array.isArray(results) ? results : [];
      for (const f of normalized) {
        const decorated = {
          ...f,
          personaId,
          tool: tool.id,
          file: f.file || file,
        };
        findings.push(decorated);
        onEvent({ type: "persona_finding", personaId, file, tool: tool.id, finding: decorated });
      }
      toolInvocations.push({ tool: tool.id, findings: normalized.length });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      onEvent({
        type: "persona_tool_error",
        personaId,
        file,
        tool: tool.id,
        stopReason: errorMessage,
      });
      toolInvocations.push({ tool: tool.id, error: errorMessage });
    }
  }

  return { findings, toolInvocations, stoppedEarly };
}

/**
 * Run a single persona across its assigned files in the router output.
 *
 * @param {object} params
 * @param {string} params.personaId
 * @param {string[]} params.files
 * @param {string} params.rootPath
 * @param {object} params.budget
 * @param {Function} [params.onEvent]
 * @returns {Promise<{personaId: string, perFile: Array, findings: Array, visited: string[], skipped: string[], terminationReason: string}>}
 */
export async function runPersonaAcrossFiles({
  personaId,
  files,
  rootPath,
  budget,
  onEvent = () => {},
} = {}) {
  if (!Array.isArray(files)) throw new TypeError("runPersonaAcrossFiles requires files array");
  const safeBudget = budget || createBudgetState();
  const perFile = [];
  const allFindings = [];
  const visited = [];
  const skipped = [];
  let terminationReason = "ok";

  for (const file of files) {
    const budgetCheck = checkBudget(safeBudget);
    if (!budgetCheck.ok) {
      terminationReason = budgetCheck.reason;
      skipped.push(file);
      onEvent({ type: "persona_file_skipped", personaId, file, stopReason: budgetCheck.reason });
      continue;
    }

    onEvent({ type: "persona_file_start", personaId, file });
    const { findings, toolInvocations, stoppedEarly } = await runPersonaOnFile({
      personaId,
      file,
      rootPath,
      budget: safeBudget,
      onEvent,
    });
    perFile.push({ file, findings, toolInvocations, stoppedEarly });
    allFindings.push(...findings);
    visited.push(file);
    onEvent({
      type: "persona_file_complete",
      personaId,
      file,
      findingCount: findings.length,
      toolCount: toolInvocations.length,
    });
  }

  return {
    personaId,
    perFile,
    findings: allFindings,
    visited,
    skipped,
    terminationReason,
  };
}

/**
 * Run every persona in the supplied routing table in sequence. Each
 * persona's runtime is bounded by the shared budget; when the budget
 * trips, remaining personas (and remaining files within the current
 * persona) are marked `skipped` so the partial-report generator can
 * still emit what finished.
 *
 * @param {object} params
 * @param {Record<string, string[]>} params.routing - { personaId: filesInScope[] }
 * @param {string} params.rootPath
 * @param {object} params.budget
 * @param {Function} [params.onEvent]
 * @returns {Promise<{byPersona: Record<string, object>, findings: Array, terminationReason: string}>}
 */
export async function runAllPersonas({
  routing = {},
  rootPath,
  budget,
  onEvent = () => {},
} = {}) {
  if (!rootPath) throw new TypeError("runAllPersonas requires rootPath");
  const safeBudget = budget || createBudgetState();
  const byPersona = {};
  const allFindings = [];
  let terminationReason = "ok";

  for (const [personaId, files] of Object.entries(routing)) {
    const budgetCheck = checkBudget(safeBudget);
    if (!budgetCheck.ok) {
      terminationReason = budgetCheck.reason;
      byPersona[personaId] = {
        personaId,
        perFile: [],
        findings: [],
        visited: [],
        skipped: [...files],
        terminationReason: budgetCheck.reason,
      };
      onEvent({ type: "persona_skipped", personaId, stopReason: budgetCheck.reason });
      continue;
    }

    onEvent({ type: "persona_start", personaId, fileCount: files.length });
    const result = await runPersonaAcrossFiles({
      personaId,
      files,
      rootPath,
      budget: safeBudget,
      onEvent,
    });
    byPersona[personaId] = result;
    allFindings.push(...result.findings);
    if (result.terminationReason !== "ok" && terminationReason === "ok") {
      terminationReason = result.terminationReason;
    }
    onEvent({
      type: "persona_complete",
      personaId,
      findingCount: result.findings.length,
      visitedCount: result.visited.length,
      skippedCount: result.skipped.length,
    });
  }

  return { byPersona, findings: allFindings, terminationReason };
}
