import fsp from "node:fs/promises";
import path from "node:path";

export const DEFAULT_AUDIT_AGENT_TOOLS = Object.freeze([
  "FileRead",
  "Grep",
  "Glob",
  "Shell",
  "FileEdit",
]);

const TOOL_NAME_ALIASES = Object.freeze({
  read: "FileRead",
  file_read: "FileRead",
  "file-read": "FileRead",
  fileread: "FileRead",
  grep: "Grep",
  glob: "Glob",
  shell: "Shell",
  file_edit: "FileEdit",
  "file-edit": "FileEdit",
  fileedit: "FileEdit",
  dispatch: "Dispatch",
});

const BUILTIN_AUDIT_AGENTS = Object.freeze([
  {
    id: "security",
    persona: "Nina Patel",
    domain: "Security",
    tools: ["read", "grep", "dependency-audit"],
    permissionMode: "plan",
    maxTurns: 8,
    confidenceFloor: 0.85,
    evidenceRequirements: ["file_line_reference", "repro_steps"],
    escalationTargets: ["release", "architecture"],
  },
  {
    id: "architecture",
    persona: "Maya Volkov",
    domain: "Architecture",
    tools: ["read", "grep", "structure-map"],
    permissionMode: "plan",
    maxTurns: 8,
    confidenceFloor: 0.8,
    evidenceRequirements: ["component_map", "impact_summary"],
    escalationTargets: ["security", "performance"],
  },
  {
    id: "performance",
    persona: "Arjun Mehta",
    domain: "Performance",
    tools: ["read", "grep", "profiler-hints"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    evidenceRequirements: ["latency_paths", "runtime_assumptions"],
    escalationTargets: ["architecture", "reliability"],
  },
  {
    id: "compliance",
    persona: "Leila Farouk",
    domain: "Compliance",
    tools: ["read", "grep", "control-map"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.82,
    evidenceRequirements: ["control_refs", "evidence_paths"],
    escalationTargets: ["security", "release"],
  },
  {
    id: "frontend",
    persona: "Jules Tanaka",
    domain: "Frontend",
    tools: ["read", "grep", "ui-lint"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.75,
    evidenceRequirements: ["component_paths", "repro_steps"],
    escalationTargets: ["testing", "security"],
  },
  {
    id: "data-layer",
    persona: "Linh Tran",
    domain: "Data Layer",
    tools: ["read", "grep", "query-review"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    evidenceRequirements: ["query_paths", "risk_evidence"],
    escalationTargets: ["performance", "security"],
  },
  {
    id: "release",
    persona: "Omar Singh",
    domain: "Release Engineering",
    tools: ["read", "grep", "workflow-review"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    evidenceRequirements: ["workflow_refs", "gate_matrix"],
    escalationTargets: ["security", "reliability"],
  },
  {
    id: "infrastructure",
    persona: "Kat Hughes",
    domain: "Infrastructure",
    tools: ["read", "grep", "infra-lint"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.78,
    evidenceRequirements: ["infra_paths", "blast_radius"],
    escalationTargets: ["security", "reliability"],
  },
  {
    id: "reliability",
    persona: "Noah Ben-David",
    domain: "Reliability",
    tools: ["read", "grep", "test-runner"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.78,
    evidenceRequirements: ["failure_modes", "rollback_plan"],
    escalationTargets: ["release", "observability"],
  },
  {
    id: "observability",
    persona: "Sofia Alvarez",
    domain: "Observability",
    tools: ["read", "grep", "telemetry-review"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.75,
    evidenceRequirements: ["signal_inventory", "gaps"],
    escalationTargets: ["reliability", "release"],
  },
  {
    id: "testing",
    persona: "Priya Raman",
    domain: "Testing",
    tools: ["read", "grep", "test-runner"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.8,
    evidenceRequirements: ["failing_paths", "coverage_gaps"],
    escalationTargets: ["frontend", "architecture"],
  },
  {
    id: "supply-chain",
    persona: "Nora Kline",
    domain: "Supply Chain",
    tools: ["read", "grep", "dependency-audit"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.82,
    evidenceRequirements: ["dependency_refs", "version_risks"],
    escalationTargets: ["security", "release"],
  },
  {
    id: "code-quality",
    persona: "Ethan Park",
    domain: "Code Quality",
    tools: ["read", "grep", "lint-review"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.75,
    evidenceRequirements: ["rule_hits", "refactor_candidates"],
    escalationTargets: ["architecture", "testing"],
  },
  {
    id: "documentation",
    persona: "Samir Okafor",
    domain: "Documentation",
    tools: ["read", "grep", "spec-check"],
    permissionMode: "plan",
    maxTurns: 4,
    confidenceFloor: 0.7,
    evidenceRequirements: ["doc_paths", "spec_mismatches"],
    escalationTargets: ["architecture", "release"],
  },
  {
    id: "ai-governance",
    persona: "Amina Chen",
    domain: "AI Governance",
    tools: ["read", "grep", "policy-check"],
    permissionMode: "plan",
    maxTurns: 6,
    confidenceFloor: 0.82,
    evidenceRequirements: ["budget_controls", "eval_refs"],
    escalationTargets: ["security", "reliability"],
  },
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToolName(value) {
  const raw = normalizeString(value);
  if (!raw) {
    return "";
  }
  const alias = TOOL_NAME_ALIASES[raw.toLowerCase()];
  if (alias) {
    return alias;
  }
  return raw;
}

export function normalizeAuditAgentTools(tools = [], { useDefaultWhenEmpty = false } = {}) {
  const normalized = Array.isArray(tools)
    ? tools.map((item) => normalizeToolName(item)).filter(Boolean)
    : [];
  const unique = [...new Set(normalized)];
  if (unique.length > 0) {
    return unique;
  }
  return useDefaultWhenEmpty ? [...DEFAULT_AUDIT_AGENT_TOOLS] : [];
}

function normalizeAgentId(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeAgentRecord(record = {}) {
  const hasToolOverride = Object.prototype.hasOwnProperty.call(record, "tools");
  return {
    id: normalizeAgentId(record.id),
    persona: normalizeString(record.persona),
    domain: normalizeString(record.domain),
    tools: normalizeAuditAgentTools(record.tools, { useDefaultWhenEmpty: !hasToolOverride }),
    permissionMode: normalizeString(record.permissionMode || "plan") || "plan",
    maxTurns: Math.max(1, Math.floor(Number(record.maxTurns || 1))),
    confidenceFloor: Math.max(0, Math.min(1, Number(record.confidenceFloor || 0))),
    evidenceRequirements: Array.isArray(record.evidenceRequirements)
      ? record.evidenceRequirements.map((item) => normalizeString(item)).filter(Boolean)
      : [],
    escalationTargets: Array.isArray(record.escalationTargets)
      ? record.escalationTargets.map((item) => normalizeAgentId(item)).filter(Boolean)
      : [],
  };
}

function mergeRegistry(builtinAgents = [], overrideAgents = []) {
  const byId = new Map();
  for (const builtin of builtinAgents) {
    byId.set(builtin.id, { ...builtin });
  }
  for (const override of overrideAgents) {
    const normalized = normalizeAgentRecord(override);
    if (!normalized.id) {
      continue;
    }
    const existing = byId.get(normalized.id) || {};
    if (!Object.prototype.hasOwnProperty.call(override, "tools")) {
      normalized.tools = Array.isArray(existing.tools) && existing.tools.length > 0
        ? [...existing.tools]
        : [...DEFAULT_AUDIT_AGENT_TOOLS];
    }
    byId.set(normalized.id, {
      ...existing,
      ...normalized,
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function parseAgentFilter(rawValue) {
  const normalized = normalizeString(rawValue);
  if (!normalized) {
    return [];
  }
  return [...new Set(normalized.split(",").map((item) => normalizeAgentId(item)).filter(Boolean))];
}

export function listBuiltinAuditAgents() {
  return BUILTIN_AUDIT_AGENTS.map((agent) =>
    normalizeAgentRecord({
      ...agent,
      tools: DEFAULT_AUDIT_AGENT_TOOLS,
    })
  );
}

export async function loadAuditRegistry({ registryFile = "" } = {}) {
  const builtin = listBuiltinAuditAgents();
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
    throw new Error("Invalid audit registry file: expected { agents: [...] }.");
  }

  const merged = mergeRegistry(builtin, parsed.agents);
  return {
    registrySource: "custom",
    registryFile: resolvedRegistryFile,
    agents: merged,
  };
}

export function selectAuditAgents(agents = [], requested = "") {
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

