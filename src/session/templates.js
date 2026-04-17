const SESSION_TEMPLATE_REGISTRY_VERSION = "1.0.0";
const DEFAULT_DASHBOARD_BASE_URL = "https://sentinelayer.com/dashboard/sessions";

const TEMPLATE_DEFINITIONS = Object.freeze({
  "code-review": {
    id: "code-review",
    version: "1.0.0",
    description: "One coder + one reviewer. Reviewer watches Omar Gate, fixes P2s.",
    suggestedAgents: [
      { role: "coder", instructions: "Build features from the spec." },
      { role: "reviewer", instructions: "Review each PR via Omar Gate, fix P2s, merge when clean." },
    ],
    daemonModel: "gpt-5.4-mini",
    ttlHours: 8,
  },
  "security-audit": {
    id: "security-audit",
    version: "1.0.0",
    description: "Full 13-persona Omar Gate audit with human oversight.",
    suggestedAgents: [
      {
        role: "auditor",
        instructions: "Run sl /omargate deep --scan-mode full-depth and report findings.",
      },
    ],
    daemonModel: "gpt-5.4-mini",
    ttlHours: 4,
  },
  "e2e-test": {
    id: "e2e-test",
    version: "1.0.0",
    description: "Coder + tester with AIdenID email provisioning.",
    suggestedAgents: [
      { role: "coder", instructions: "Build the feature." },
      {
        role: "tester",
        instructions: "Test auth flows with sl ai provision-email + sl ai identity wait-for-otp.",
      },
    ],
    daemonModel: "gpt-5.4-mini",
    ttlHours: 8,
    autoProvisionEmails: 10,
  },
  "incident-response": {
    id: "incident-response",
    version: "1.0.0",
    description: "All-hands: multiple agents diagnosing and fixing a production issue.",
    suggestedAgents: [
      { role: "investigator", instructions: "Read logs, trace the error, identify root cause." },
      {
        role: "fixer",
        instructions: "Implement the fix based on investigator findings.",
      },
      {
        role: "verifier",
        instructions: "Test the fix, run regression suite, verify deployment.",
      },
    ],
    daemonModel: "gpt-5.3-codex",
    ttlHours: 4,
  },
  standup: {
    id: "standup",
    version: "1.0.0",
    description: "Quick coordination session. Human directs agents via dashboard.",
    suggestedAgents: [],
    daemonModel: "gpt-5.4-nano",
    ttlHours: 1,
  },
});

function normalizeString(value) {
  return String(value || "").trim();
}

function sanitizeTemplateAgent(agent = {}) {
  return {
    role: normalizeString(agent.role) || "agent",
    instructions: normalizeString(agent.instructions) || "Follow session guidance.",
  };
}

function sanitizeTemplate(template = {}) {
  const suggestedAgents = Array.isArray(template.suggestedAgents)
    ? template.suggestedAgents.map((agent) => sanitizeTemplateAgent(agent))
    : [];
  return {
    id: normalizeString(template.id),
    version: normalizeString(template.version) || "1.0.0",
    description: normalizeString(template.description),
    daemonModel: normalizeString(template.daemonModel),
    ttlHours: Number.isFinite(Number(template.ttlHours))
      ? Math.max(1, Math.floor(Number(template.ttlHours)))
      : 1,
    autoProvisionEmails:
      template.autoProvisionEmails === undefined || template.autoProvisionEmails === null
        ? null
        : Math.max(1, Math.floor(Number(template.autoProvisionEmails) || 1)),
    suggestedAgents,
    registryVersion: SESSION_TEMPLATE_REGISTRY_VERSION,
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function listTemplateIds() {
  return Object.keys(TEMPLATE_DEFINITIONS).sort();
}

function resolveAgentNameSeed(role) {
  const normalizedRole = normalizeString(role).toLowerCase() || "agent";
  if (normalizedRole === "coder") {
    return "codex";
  }
  if (normalizedRole === "reviewer") {
    return "claude";
  }
  const alias = normalizedRole.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return alias || "agent";
}

function buildDashboardUrl(sessionId, { baseUrl = DEFAULT_DASHBOARD_BASE_URL } = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedBaseUrl = normalizeString(baseUrl).replace(/\/+$/g, "");
  if (!normalizedSessionId) {
    return normalizedBaseUrl || DEFAULT_DASHBOARD_BASE_URL;
  }
  return `${normalizedBaseUrl || DEFAULT_DASHBOARD_BASE_URL}/${normalizedSessionId}`;
}

function buildTemplateLaunchPlan(sessionId, template = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedTemplate = sanitizeTemplate(template);
  const suggestedAgents = Array.isArray(normalizedTemplate.suggestedAgents)
    ? normalizedTemplate.suggestedAgents
    : [];
  const roleCounters = new Map();
  return suggestedAgents.map((agent, index) => {
    const terminal = index + 1;
    const role = normalizeString(agent.role) || "agent";
    const normalizedRole = normalizeString(role).toLowerCase() || "agent";
    const nextRoleCount = Number(roleCounters.get(normalizedRole) || 0) + 1;
    roleCounters.set(normalizedRole, nextRoleCount);
    const agentName = `${resolveAgentNameSeed(role)}-${nextRoleCount}`;
    const command = `sl session join ${normalizedSessionId} --name ${agentName} --role ${role}`;
    return {
      terminal,
      role,
      agentName,
      instructions: normalizeString(agent.instructions),
      command,
    };
  });
}

function getTemplateRegistry() {
  const templates = listTemplateIds().map((id) => sanitizeTemplate(TEMPLATE_DEFINITIONS[id]));
  return {
    registryVersion: SESSION_TEMPLATE_REGISTRY_VERSION,
    templates,
  };
}

function resolveSessionTemplate(templateName) {
  const normalizedTemplateName = normalizeString(templateName).toLowerCase();
  if (!normalizedTemplateName) {
    return null;
  }
  const template = TEMPLATE_DEFINITIONS[normalizedTemplateName];
  if (!template) {
    const available = listTemplateIds().join(", ");
    throw new Error(
      `Unknown session template '${templateName}'. Use --template one of: ${available}. Run 'sl session templates --json' for details.`
    );
  }
  return sanitizeTemplate(deepClone(template));
}

export {
  DEFAULT_DASHBOARD_BASE_URL,
  SESSION_TEMPLATE_REGISTRY_VERSION,
  buildDashboardUrl,
  buildTemplateLaunchPlan,
  getTemplateRegistry,
  resolveSessionTemplate,
};
