import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_BUDGET = Object.freeze({
  maxCostUsd: 0.5,
  maxOutputTokens: 3000,
  maxRuntimeMs: 300000,
  maxToolCalls: 40,
});

const BUILTIN_SWARM_AGENTS = Object.freeze([
  {
    id: "omar",
    persona: "Omar Gate",
    role: "orchestrator",
    domain: "Autonomous Governance",
    tools: ["planner", "budget-governor", "handoff-router"],
    permissionMode: "plan",
    maxTurns: 12,
    confidenceFloor: 0.9,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: {
      maxCostUsd: 1.5,
      maxOutputTokens: 10000,
      maxRuntimeMs: 900000,
      maxToolCalls: 120,
    },
    evidenceRequirements: ["scope_constraints", "handoff_manifest", "gate_decision"],
    escalationTargets: ["security", "reliability", "release"],
  },
  {
    id: "security",
    persona: "Nina Patel",
    role: "specialist",
    domain: "Security",
    tools: ["read", "grep", "dependency-audit"],
    permissionMode: "plan",
    maxTurns: 8,
    confidenceFloor: 0.85,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: {
      maxCostUsd: 0.8,
      maxOutputTokens: 4000,
      maxRuntimeMs: 480000,
      maxToolCalls: 60,
    },
    evidenceRequirements: ["file_line_reference", "repro_steps"],
    escalationTargets: ["release", "reliability"],
  },
  {
    id: "architecture",
    persona: "Maya Volkov",
    role: "specialist",
    domain: "Architecture",
    tools: ["read", "grep", "structure-map"],
    permissionMode: "plan",
    maxTurns: 8,
    confidenceFloor: 0.82,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["component_map", "impact_summary"],
    escalationTargets: ["performance", "testing"],
  },
  {
    id: "testing",
    persona: "Priya Raman",
    role: "specialist",
    domain: "Testing",
    tools: ["read", "grep", "test-runner"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["coverage_gaps", "failing_paths"],
    escalationTargets: ["architecture"],
  },
  {
    id: "performance",
    persona: "Arjun Mehta",
    role: "specialist",
    domain: "Performance",
    tools: ["read", "grep", "profiler-hints"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["latency_paths", "runtime_assumptions"],
    escalationTargets: ["architecture", "reliability"],
  },
  {
    id: "compliance",
    persona: "Leila Farouk",
    role: "specialist",
    domain: "Compliance",
    tools: ["read", "grep", "control-map"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.82,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["control_refs", "evidence_paths"],
    escalationTargets: ["security", "release"],
  },
  {
    id: "documentation",
    persona: "Samir Okafor",
    role: "specialist",
    domain: "Documentation",
    tools: ["read", "grep", "spec-check"],
    permissionMode: "plan",
    maxTurns: 5,
    confidenceFloor: 0.75,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: {
      maxCostUsd: 0.35,
      maxOutputTokens: 2500,
      maxRuntimeMs: 240000,
      maxToolCalls: 30,
    },
    evidenceRequirements: ["doc_paths", "spec_mismatches"],
    escalationTargets: ["architecture", "release"],
  },
  {
    id: "reliability",
    persona: "Noah Ben-David",
    role: "specialist",
    domain: "Reliability",
    tools: ["read", "grep", "failure-analysis"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["failure_modes", "rollback_plan"],
    escalationTargets: ["release", "observability"],
  },
  {
    id: "release",
    persona: "Omar Singh",
    role: "specialist",
    domain: "Release Engineering",
    tools: ["read", "grep", "workflow-review"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["workflow_refs", "gate_matrix"],
    escalationTargets: ["security", "reliability"],
  },
  {
    id: "observability",
    persona: "Sofia Alvarez",
    role: "specialist",
    domain: "Observability",
    tools: ["read", "grep", "telemetry-review"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.78,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["signal_inventory", "gaps"],
    escalationTargets: ["reliability", "release"],
  },
  {
    id: "infrastructure",
    persona: "Kat Hughes",
    role: "specialist",
    domain: "Infrastructure",
    tools: ["read", "grep", "infra-lint"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.78,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["infra_paths", "blast_radius"],
    escalationTargets: ["security", "reliability"],
  },
  {
    id: "supply-chain",
    persona: "Nora Kline",
    role: "specialist",
    domain: "Supply Chain",
    tools: ["read", "grep", "dependency-audit"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.82,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["dependency_refs", "version_risks"],
    escalationTargets: ["security", "release"],
  },
  {
    id: "frontend",
    persona: "Jules Tanaka",
    role: "specialist",
    domain: "Frontend",
    tools: ["read", "grep", "ui-lint"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.76,
    allowedPaths: ["."],
    networkMode: "restricted",
    defaultBudget: { ...DEFAULT_BUDGET },
    evidenceRequirements: ["component_paths", "repro_steps"],
    escalationTargets: ["testing", "architecture"],
  },
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeAgentId(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeRole(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "orchestrator" || normalized === "specialist") {
    return normalized;
  }
  return "specialist";
}

function normalizeNetworkMode(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "enabled" || normalized === "restricted" || normalized === "disabled") {
    return normalized;
  }
  return "restricted";
}

function normalizePositiveNumber(value, fallback, field) {
  const normalized = Number(value);
  if (Number.isFinite(normalized) && normalized > 0) {
    return normalized;
  }
  if (fallback !== undefined) {
    return Number(fallback);
  }
  throw new Error(`${field} must be a positive number.`);
}

function normalizeBudget(budget = {}, fallback = DEFAULT_BUDGET) {
  if (budget === undefined || budget === null || typeof budget !== "object" || Array.isArray(budget)) {
    throw new Error("defaultBudget must be an object when provided.");
  }

  return {
    maxCostUsd: normalizePositiveNumber(
      budget.maxCostUsd,
      fallback.maxCostUsd,
      "defaultBudget.maxCostUsd"
    ),
    maxOutputTokens: Math.floor(
      normalizePositiveNumber(
        budget.maxOutputTokens,
        fallback.maxOutputTokens,
        "defaultBudget.maxOutputTokens"
      )
    ),
    maxRuntimeMs: Math.floor(
      normalizePositiveNumber(
        budget.maxRuntimeMs,
        fallback.maxRuntimeMs,
        "defaultBudget.maxRuntimeMs"
      )
    ),
    maxToolCalls: Math.floor(
      normalizePositiveNumber(
        budget.maxToolCalls,
        fallback.maxToolCalls,
        "defaultBudget.maxToolCalls"
      )
    ),
  };
}

function normalizeAgentRecord(record = {}, existing = {}) {
  const id = normalizeAgentId(record.id || existing.id);
  const fallbackBudget = existing.defaultBudget || DEFAULT_BUDGET;

  return {
    id,
    persona: normalizeString(record.persona || existing.persona),
    role: normalizeRole(record.role || existing.role),
    domain: normalizeString(record.domain || existing.domain),
    tools: Array.isArray(record.tools || existing.tools)
      ? (record.tools || existing.tools).map((item) => normalizeString(item)).filter(Boolean)
      : [],
    permissionMode: normalizeString(record.permissionMode || existing.permissionMode || "plan") || "plan",
    maxTurns: Math.max(1, Math.floor(Number(record.maxTurns || existing.maxTurns || 1))),
    confidenceFloor: Math.max(
      0,
      Math.min(1, Number(record.confidenceFloor || existing.confidenceFloor || 0.7))
    ),
    allowedPaths: Array.isArray(record.allowedPaths || existing.allowedPaths)
      ? (record.allowedPaths || existing.allowedPaths).map((item) => normalizeString(item)).filter(Boolean)
      : ["."],
    networkMode: normalizeNetworkMode(record.networkMode || existing.networkMode),
    defaultBudget: normalizeBudget(record.defaultBudget || existing.defaultBudget || {}, fallbackBudget),
    evidenceRequirements: Array.isArray(record.evidenceRequirements || existing.evidenceRequirements)
      ? (record.evidenceRequirements || existing.evidenceRequirements)
          .map((item) => normalizeString(item))
          .filter(Boolean)
      : [],
    escalationTargets: Array.isArray(record.escalationTargets || existing.escalationTargets)
      ? (record.escalationTargets || existing.escalationTargets)
          .map((item) => normalizeAgentId(item))
          .filter(Boolean)
      : [],
  };
}

function mergeRegistry(builtinAgents = [], overrideAgents = []) {
  const byId = new Map();
  const order = [];

  for (const builtin of builtinAgents) {
    const normalized = normalizeAgentRecord(builtin);
    byId.set(normalized.id, normalized);
    order.push(normalized.id);
  }

  for (const override of overrideAgents) {
    const id = normalizeAgentId(override.id);
    if (!id) {
      continue;
    }
    if (!byId.has(id)) {
      order.push(id);
    }
    const existing = byId.get(id) || { id };
    byId.set(id, normalizeAgentRecord(override, existing));
  }

  return order.map((id) => ({ ...byId.get(id) })).filter(Boolean);
}

function parseAgentFilter(rawValue) {
  const normalized = normalizeString(rawValue);
  if (!normalized) {
    return [];
  }
  return [...new Set(normalized.split(",").map((item) => normalizeAgentId(item)).filter(Boolean))];
}

export function listBuiltinSwarmAgents() {
  return BUILTIN_SWARM_AGENTS.map((agent) => normalizeAgentRecord(agent));
}

export async function loadSwarmRegistry({ registryFile = "" } = {}) {
  const builtin = listBuiltinSwarmAgents();
  const resolvedRegistryFile = normalizeString(registryFile)
    ? path.resolve(process.cwd(), registryFile)
    : "";
  if (!resolvedRegistryFile) {
    return {
      registrySource: "builtin",
      registryFile: "",
      agents: builtin,
    };
  }

  const raw = await fsp.readFile(resolvedRegistryFile, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.agents)) {
    throw new Error("Invalid swarm registry file: expected { agents: [...] }.");
  }

  return {
    registrySource: "custom",
    registryFile: resolvedRegistryFile,
    agents: mergeRegistry(builtin, parsed.agents),
  };
}

export function selectSwarmAgents(agents = [], requested = "") {
  const requestedIds = parseAgentFilter(requested);
  if (requestedIds.length === 0) {
    return {
      selected: [...agents],
      requestedIds,
      missing: [],
    };
  }

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const selected = [];
  const missing = [];
  for (const id of requestedIds) {
    const agent = byId.get(id);
    if (!agent) {
      missing.push(id);
      continue;
    }
    selected.push(agent);
  }
  return {
    selected,
    requestedIds,
    missing,
  };
}
