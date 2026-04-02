import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";

const SCHEMA_VERSION = 1;
const DEFAULT_GLOBAL_BUDGET = Object.freeze({
  maxCostUsd: 5,
  maxOutputTokens: 20000,
  maxRuntimeMs: 3600000,
  maxToolCalls: 500,
  warningThresholdPercent: 80,
});

function normalizeString(value) {
  return String(value || "").trim();
}

function formatTimestampToken() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function createSwarmRunId() {
  return `swarm-${formatTimestampToken()}-${randomUUID().slice(0, 8)}`;
}

function normalizePositiveNumber(value, fallback, field) {
  if (value === undefined || value === null || value === "") {
    return Number(fallback);
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function normalizeGlobalBudget(budget = {}) {
  return {
    maxCostUsd: normalizePositiveNumber(
      budget.maxCostUsd,
      DEFAULT_GLOBAL_BUDGET.maxCostUsd,
      "maxCostUsd"
    ),
    maxOutputTokens: Math.floor(
      normalizePositiveNumber(
        budget.maxOutputTokens,
        DEFAULT_GLOBAL_BUDGET.maxOutputTokens,
        "maxOutputTokens"
      )
    ),
    maxRuntimeMs: Math.floor(
      normalizePositiveNumber(
        budget.maxRuntimeMs,
        DEFAULT_GLOBAL_BUDGET.maxRuntimeMs,
        "maxRuntimeMs"
      )
    ),
    maxToolCalls: Math.floor(
      normalizePositiveNumber(
        budget.maxToolCalls,
        DEFAULT_GLOBAL_BUDGET.maxToolCalls,
        "maxToolCalls"
      )
    ),
    warningThresholdPercent: Math.max(
      1,
      Math.min(
        100,
        Math.floor(
          normalizePositiveNumber(
            budget.warningThresholdPercent,
            DEFAULT_GLOBAL_BUDGET.warningThresholdPercent,
            "warningThresholdPercent"
          )
        )
      )
    ),
  };
}

function normalizeMaxParallel(value) {
  const normalized = Number(value || 1);
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error("maxParallel must be an integer >= 1.");
  }
  return Math.floor(normalized);
}

function ensureLeader(agents = []) {
  const seen = new Set();
  const deduped = [];
  for (const agent of agents) {
    const id = normalizeString(agent.id).toLowerCase();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(agent);
  }

  const omar = deduped.find((agent) => String(agent.id || "").toLowerCase() === "omar");
  if (!omar) {
    throw new Error("Swarm plan requires the 'omar' orchestrator agent.");
  }

  return [omar, ...deduped.filter((agent) => String(agent.id || "").toLowerCase() !== "omar")];
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function deriveAgentObjective({ agent, scenario, objective }) {
  const normalizedScenario = normalizeString(scenario || "qa_audit");
  const normalizedObjective = normalizeString(objective);
  const scenarioHint = normalizedScenario.replace(/[_-]+/g, " ");
  if (String(agent.id || "").toLowerCase() === "omar") {
    return (
      normalizedObjective ||
      `Own the ${scenarioHint} orchestration: decompose tasks, assign scoped specialists, reconcile findings, and emit final gate decision.`
    );
  }
  if (normalizedObjective) {
    return `${normalizedObjective} Focus on ${agent.domain} scope and provide deterministic handoff evidence.`;
  }
  return `Analyze ${agent.domain} scope for scenario '${normalizedScenario}' and produce reproducible findings with file-level evidence.`;
}

function buildAgentBudget(agent = {}, globalBudget = DEFAULT_GLOBAL_BUDGET) {
  const agentBudget = agent.defaultBudget || {};
  const clamp = (agentValue, globalValue, field) => {
    const normalized = normalizePositiveNumber(agentValue, globalValue, `agent.${field}`);
    return Math.min(normalized, globalValue);
  };
  return {
    maxCostUsd: clamp(agentBudget.maxCostUsd, globalBudget.maxCostUsd, "maxCostUsd"),
    maxOutputTokens: Math.floor(
      clamp(agentBudget.maxOutputTokens, globalBudget.maxOutputTokens, "maxOutputTokens")
    ),
    maxRuntimeMs: Math.floor(clamp(agentBudget.maxRuntimeMs, globalBudget.maxRuntimeMs, "maxRuntimeMs")),
    maxToolCalls: Math.floor(clamp(agentBudget.maxToolCalls, globalBudget.maxToolCalls, "maxToolCalls")),
    warningThresholdPercent: globalBudget.warningThresholdPercent,
  };
}

function buildExecutionGraph(assignments = []) {
  const omar = assignments.find((assignment) => assignment.agentId === "omar");
  const specialists = assignments.filter((assignment) => assignment.agentId !== "omar");
  const edges = [];
  for (const specialist of specialists) {
    edges.push({
      from: "omar",
      to: specialist.agentId,
      contract: "task_dispatch",
    });
    edges.push({
      from: specialist.agentId,
      to: "omar",
      contract: "reconcile_handoff",
    });
  }

  return {
    nodes: assignments.map((assignment) => ({
      id: assignment.agentId,
      role: assignment.role,
      domain: assignment.domain,
    })),
    edges,
    phases: [
      {
        id: "phase-1-baseline",
        description: "Omar baseline scope and assignment synthesis",
        agentIds: omar ? ["omar"] : [],
      },
      {
        id: "phase-2-specialists",
        description: "Specialists execute scoped checks in parallel",
        agentIds: specialists.map((assignment) => assignment.agentId),
      },
      {
        id: "phase-3-reconcile",
        description: "Omar reconciles outputs and emits final gate result",
        agentIds: omar ? ["omar"] : [],
      },
    ],
  };
}

function summarizePlan(assignments = []) {
  const specialists = assignments.filter((assignment) => assignment.agentId !== "omar");
  return {
    orchestratorCount: assignments.some((assignment) => assignment.agentId === "omar") ? 1 : 0,
    specialistCount: specialists.length,
    domainCount: new Set(specialists.map((assignment) => assignment.domain)).size,
  };
}

function renderAssignmentMarkdown(assignments = []) {
  if (assignments.length === 0) {
    return "- none";
  }
  return assignments
    .map(
      (assignment) =>
        `- ${assignment.agentId} (${assignment.persona}, ${assignment.domain}) role=${assignment.role} budget(cost<=${assignment.budget.maxCostUsd}, tokens<=${assignment.budget.maxOutputTokens}, runtime_ms<=${assignment.budget.maxRuntimeMs}, tools<=${assignment.budget.maxToolCalls})`
    )
    .join("\n");
}

export function renderSwarmPlanMarkdown(plan = {}) {
  const summary = plan.summary || {};
  const budgets = plan.globalBudget || {};
  const graph = plan.executionGraph || {};
  const phases = (graph.phases || [])
    .map(
      (phase) => `- ${phase.id}: ${phase.description} :: [${(phase.agentIds || []).join(", ") || "none"}]`
    )
    .join("\n");

  return `# SWARM_PLAN

Generated: ${plan.generatedAt}
Run ID: ${plan.runId}
Target: ${plan.targetPath}
Scenario: ${plan.scenario}
Objective: ${plan.objective}
Max parallel: ${plan.maxParallel}

Global budgets:
- max_cost_usd: ${budgets.maxCostUsd}
- max_output_tokens: ${budgets.maxOutputTokens}
- max_runtime_ms: ${budgets.maxRuntimeMs}
- max_tool_calls: ${budgets.maxToolCalls}
- warning_threshold_percent: ${budgets.warningThresholdPercent}

Summary:
- orchestrators: ${summary.orchestratorCount || 0}
- specialists: ${summary.specialistCount || 0}
- domains: ${summary.domainCount || 0}

Execution phases:
${phases || "- none"}

Assignments:
${renderAssignmentMarkdown(plan.assignments || [])}
`;
}

export function buildSwarmExecutionPlan({
  targetPath,
  scenario = "qa_audit",
  objective = "",
  agents = [],
  maxParallel = 4,
  globalBudget = {},
  registrySource = "builtin",
  registryFile = "",
} = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedScenario = normalizeString(scenario || "qa_audit") || "qa_audit";
  const normalizedObjective = normalizeString(objective) || "Run OMAR-governed swarm quality audit.";
  const normalizedBudget = normalizeGlobalBudget(globalBudget);
  const orderedAgents = ensureLeader(agents);
  const normalizedMaxParallel = normalizeMaxParallel(maxParallel);
  const effectiveParallel = Math.max(
    1,
    Math.min(normalizedMaxParallel, orderedAgents.filter((agent) => agent.id !== "omar").length || 1)
  );
  const runId = createSwarmRunId();
  const generatedAt = new Date().toISOString();

  const assignments = orderedAgents.map((agent, index) => {
    const agentId = normalizeString(agent.id).toLowerCase();
    return {
      assignmentId: `${runId}-A${String(index + 1).padStart(2, "0")}`,
      agentId,
      persona: normalizeString(agent.persona),
      role: normalizeString(agent.role || "specialist").toLowerCase() || "specialist",
      domain: normalizeString(agent.domain),
      objective: deriveAgentObjective({
        agent,
        scenario: normalizedScenario,
        objective: normalizedObjective,
      }),
      budget: buildAgentBudget(agent, normalizedBudget),
      constraints: {
        permissionMode: normalizeString(agent.permissionMode || "plan") || "plan",
        allowedPaths: Array.isArray(agent.allowedPaths)
          ? agent.allowedPaths.map((item) => toPosixPath(item)).filter(Boolean)
          : ["."],
        networkMode: normalizeString(agent.networkMode || "restricted") || "restricted",
      },
      handoff: {
        artifacts: [
          `agents/${agentId}.json`,
          `handoff/${agentId}.json`,
          `handoff/${agentId}.md`,
        ],
        downstreamAgentIds:
          agentId === "omar"
            ? orderedAgents.filter((item) => item.id !== "omar").map((item) => item.id)
            : ["omar"],
      },
    };
  });

  const executionGraph = buildExecutionGraph(assignments);

  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    generatedAt,
    targetPath: normalizedTargetPath,
    scenario: normalizedScenario,
    objective: normalizedObjective,
    maxParallel: effectiveParallel,
    registrySource: normalizeString(registrySource || "builtin") || "builtin",
    registryFile: normalizeString(registryFile),
    globalBudget: normalizedBudget,
    selectedAgents: orderedAgents.map((agent) => normalizeString(agent.id).toLowerCase()),
    assignments,
    executionGraph,
    summary: summarizePlan(assignments),
  };
}

export async function writeSwarmPlanArtifacts({
  plan,
  outputDir = "",
  env,
  homeDir,
} = {}) {
  if (!plan || typeof plan !== "object") {
    throw new Error("plan is required.");
  }

  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(String(plan.targetPath || ".")),
    outputDirOverride: outputDir,
    env,
    homeDir,
  });
  const runDirectory = path.join(outputRoot, "swarms", plan.runId);
  const planJsonPath = path.join(runDirectory, "SWARM_PLAN.json");
  const planMarkdownPath = path.join(runDirectory, "SWARM_PLAN.md");
  await fsp.mkdir(runDirectory, { recursive: true });
  await fsp.writeFile(planJsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  await fsp.writeFile(planMarkdownPath, `${renderSwarmPlanMarkdown(plan).trim()}\n`, "utf-8");

  return {
    outputRoot,
    runDirectory,
    planJsonPath,
    planMarkdownPath,
  };
}
