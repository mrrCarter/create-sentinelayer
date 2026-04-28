/**
 * Investor-DD devTestBot phase (PR-E3).
 *
 * Adds a bounded, artifact-producing browser evidence phase to the DD
 * package without making local runs depend on a live browser target. When
 * no approved baseUrl is supplied, devTestBot runs in dry-run mode and
 * writes an explicit evidence-gap artifact bundle.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { recordProvisionedIdentity } from "../ai/identity-store.js";
import { runDevTestBotSession } from "../agents/devtestbot/tool.js";
import { checkBudget } from "./investor-dd-file-loop.js";

export const DEVTESTBOT_PHASE_MAX_CONCURRENT = 4;
export const DEVTESTBOT_PHASE_DEFAULT_SCOPE = "smoke";
export const DEVTESTBOT_PHASE_DEFAULT_SWARMS = 1;
export const DEVTESTBOT_PHASE_DEFAULT_PER_SWARM_BUDGET_USD = 0.25;

async function writeJson(filePath, obj) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeScope(value) {
  const normalized = normalizeString(value).toLowerCase().replace(/\s+/g, "-");
  return normalized || DEVTESTBOT_PHASE_DEFAULT_SCOPE;
}

function clampInt(value, { min = 0, max = DEVTESTBOT_PHASE_MAX_CONCURRENT, fallback = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePlannerJson(text) {
  const raw = normalizeString(text);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function buildPlannerPrompt({ rootPath, files = [], findings = [], budget = {} }) {
  const severityCounts = {};
  for (const finding of findings || []) {
    const severity = normalizeString(finding?.severity) || "UNKNOWN";
    severityCounts[severity] = (severityCounts[severity] || 0) + 1;
  }
  return [
    "You are the investor-DD orchestrator deciding the devTestBot runtime evidence plan.",
    "Return only compact JSON with keys: identityCount, swarmCount, perSwarmBudget, scope.",
    "Constraints: identityCount 0-4, swarmCount 0-4, perSwarmBudget USD, scope smoke|auth|password-reset|full.",
    "Use smoke unless code/findings justify auth or password-reset runtime evidence.",
    `Target path: ${rootPath}`,
    `Files discovered: ${files.length}`,
    `Findings so far: ${findings.length}`,
    `Severity counts: ${JSON.stringify(severityCounts)}`,
    `Remaining DD budget: ${Number(budget?.maxUsd || 0) - Number(budget?.spentUsd || 0)}`,
  ].join("\n");
}

async function callPlannerClient({ plannerClient, rootPath, files, findings, budget }) {
  if (!plannerClient) return {};
  const prompt = buildPlannerPrompt({ rootPath, files, findings, budget });
  if (typeof plannerClient.decideDevTestBotPhase === "function") {
    return plannerClient.decideDevTestBotPhase({ rootPath, files, findings, budget, prompt });
  }
  if (typeof plannerClient.invoke === "function") {
    const response = await plannerClient.invoke({ prompt, stream: false });
    return parsePlannerJson(response?.text || response);
  }
  if (typeof plannerClient.generatePlan === "function") {
    const response = await plannerClient.generatePlan([{ role: "user", content: prompt }], {
      phase: "devtestbot",
    });
    return parsePlannerJson(response?.text || response?.content || response);
  }
  return {};
}

function chooseScope({ requestedScope, files = [], findings = [], plannedScope }) {
  if (requestedScope) return normalizeScope(requestedScope);
  if (plannedScope) return normalizeScope(plannedScope);
  const combined = [
    ...files,
    ...findings.map((finding) => `${finding?.kind || ""} ${finding?.title || ""} ${finding?.evidence || ""}`),
  ]
    .join("\n")
    .toLowerCase();
  if (/password|reset|otp|magic-link/.test(combined)) return "password-reset";
  if (/auth|login|signup|session/.test(combined)) return "auth";
  return DEVTESTBOT_PHASE_DEFAULT_SCOPE;
}

function remainingBudgetUsd(budget) {
  const maxUsd = Number(budget?.maxUsd);
  const spentUsd = Number(budget?.spentUsd || 0);
  if (!Number.isFinite(maxUsd)) return Infinity;
  return Math.max(0, maxUsd - spentUsd);
}

function normalizePhaseOptions(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  return {
    enabled: source.enabled !== false,
    baseUrl: normalizeString(source.baseUrl),
    scope: normalizeString(source.scope),
    identityCount: source.identityCount,
    swarmCount: source.swarmCount,
    perSwarmBudget: source.perSwarmBudget,
    execute: source.execute,
    recordVideo: source.recordVideo,
    plannerClient: source.plannerClient || null,
    runner: source.runner || null,
    provisionIdentity: source.provisionIdentity || null,
    maxConcurrentAgents: source.maxConcurrentAgents,
  };
}

export async function planDevTestBotPhase({
  rootPath,
  files = [],
  findings = [],
  budget = null,
  options = {},
} = {}) {
  const normalized = normalizePhaseOptions(options);
  if (!normalized.enabled) {
    return {
      enabled: false,
      reason: "disabled",
      identityCount: 0,
      swarmCount: 0,
      perSwarmBudget: 0,
      scope: DEVTESTBOT_PHASE_DEFAULT_SCOPE,
      scopes: [],
      execute: false,
      baseUrl: "",
      maxConcurrentAgents: 0,
    };
  }

  const budgetCheck = checkBudget(budget);
  if (!budgetCheck.ok) {
    return {
      enabled: false,
      reason: budgetCheck.reason,
      identityCount: 0,
      swarmCount: 0,
      perSwarmBudget: 0,
      scope: DEVTESTBOT_PHASE_DEFAULT_SCOPE,
      scopes: [],
      execute: false,
      baseUrl: normalized.baseUrl,
      maxConcurrentAgents: 0,
    };
  }

  let planned = {};
  try {
    planned = await callPlannerClient({
      plannerClient: normalized.plannerClient,
      rootPath,
      files,
      findings,
      budget,
    });
  } catch {
    planned = {};
  }
  const swarmCount = clampInt(normalized.swarmCount ?? planned.swarmCount, {
    min: 1,
    max: DEVTESTBOT_PHASE_MAX_CONCURRENT,
    fallback: DEVTESTBOT_PHASE_DEFAULT_SWARMS,
  });
  const identityCount = clampInt(normalized.identityCount ?? planned.identityCount, {
    min: swarmCount > 0 ? 1 : 0,
    max: DEVTESTBOT_PHASE_MAX_CONCURRENT,
    fallback: swarmCount,
  });
  const scope = chooseScope({
    requestedScope: normalized.scope,
    plannedScope: planned.scope,
    files,
    findings,
  });
  const remaining = remainingBudgetUsd(budget);
  const plannedPerSwarmBudget = normalizePositiveNumber(
    normalized.perSwarmBudget ?? planned.perSwarmBudget,
    DEVTESTBOT_PHASE_DEFAULT_PER_SWARM_BUDGET_USD,
  );
  const perSwarmBudget = Number.isFinite(remaining)
    ? Math.min(plannedPerSwarmBudget, remaining / Math.max(1, swarmCount))
    : plannedPerSwarmBudget;
  const scopes = Array.from({ length: swarmCount }, (_, index) => {
    const plannedScopes = Array.isArray(planned.scopes) ? planned.scopes : [];
    return normalizeScope(plannedScopes[index] || scope);
  });
  const execute = Boolean(normalized.baseUrl) && normalized.execute !== false;
  const maxConcurrentAgents = clampInt(normalized.maxConcurrentAgents, {
    min: 1,
    max: DEVTESTBOT_PHASE_MAX_CONCURRENT,
    fallback: Math.min(swarmCount, DEVTESTBOT_PHASE_MAX_CONCURRENT),
  });

  return {
    enabled: swarmCount > 0 && identityCount > 0 && perSwarmBudget >= 0,
    reason: "",
    identityCount,
    swarmCount,
    perSwarmBudget,
    scope,
    scopes,
    execute,
    baseUrl: normalized.baseUrl,
    recordVideo: normalized.recordVideo !== false,
    maxConcurrentAgents,
  };
}

function makeSyntheticIdentityResponse({ runId, index }) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return {
    id: `aidenid-devtestbot-${runId}-${index + 1}-${suffix}`,
    emailAddress: `devtestbot+${suffix}@aidenid.local`,
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    tags: ["investor-dd", "devtestbot", runId],
  };
}

export async function provisionDevTestBotIdentities({
  outputRoot,
  runId,
  count,
  provisionIdentity = null,
  onEvent = () => {},
} = {}) {
  if (!outputRoot) throw new TypeError("provisionDevTestBotIdentities requires outputRoot");
  if (!runId) throw new TypeError("provisionDevTestBotIdentities requires runId");
  const total = clampInt(count, { min: 0, max: DEVTESTBOT_PHASE_MAX_CONCURRENT, fallback: 0 });
  const identities = [];

  for (let index = 0; index < total; index += 1) {
    const subagentId = `devtestbot-${index + 1}`;
    const idempotencyKey = `${runId}:${subagentId}`;
    let response = null;
    try {
      response = typeof provisionIdentity === "function"
        ? await provisionIdentity({ runId, index, subagentId, idempotencyKey })
        : makeSyntheticIdentityResponse({ runId, index });
    } catch (error) {
      onEvent({
        type: "devtestbot_identity_error",
        phase: "devtestbot",
        agentId: subagentId,
        error: safeErrorMessage(error),
      });
    }
    if (!normalizeString(response?.id)) {
      response = makeSyntheticIdentityResponse({ runId, index });
    }
    const recorded = await recordProvisionedIdentity({
      outputRoot,
      response,
      context: {
        source: "investor-dd-devtestbot",
        idempotencyKey,
        tags: ["investor-dd", "devtestbot", subagentId, runId],
        eventBudget: 1,
      },
    });
    const identity = recorded.identity || {};
    identities.push({
      subagentId,
      identityId: identity.identityId,
      status: identity.status,
      registryPath: recorded.registryPath,
    });
    onEvent({
      type: "devtestbot_identity_ready",
      phase: "devtestbot",
      agentId: subagentId,
      identityId: identity.identityId,
      status: identity.status,
    });
  }
  return identities;
}

async function runWithConcurrency(items, maxConcurrent, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = [];
  const concurrency = Math.max(1, Math.min(Number(maxConcurrent || 1), items.length || 1));
  for (let index = 0; index < concurrency; index += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return results;
}

function summarizeResultForPackage({ subagentId, identity, result }) {
  return {
    subagentId,
    identityId: identity?.identityId || "",
    scope: result?.scope || "",
    completed: Boolean(result?.completed),
    dryRun: Boolean(result?.dryRun),
    findingCount: Number(result?.findingCount || 0),
    artifactBundle: result?.artifactBundle || null,
    laneSummaries: result?.laneSummaries || {},
    resultPath: result?.artifactBundle?.resultPath || "",
    findingsPath: result?.artifactBundle?.findingsPath || "",
    eventsPath: result?.artifactBundle?.eventsPath || "",
  };
}

function decorateFinding(finding, { subagentId, identityId, artifactBundle }) {
  return {
    ...finding,
    personaId: finding.personaId || "devtestbot",
    tool: finding.tool || "devtestbot.run_session",
    source: finding.source || "devtestbot",
    agentId: subagentId,
    identityId,
    artifactBundlePath: artifactBundle?.root || "",
  };
}

function safeErrorMessage(error) {
  return String(error?.message || error || "devTestBot subagent failed")
    .replace(/(authorization|cookie|token|secret|password|otp|reset[-_ ]?link)\s*[:=]\s*[^"'\s]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

export async function runDevTestBotPhase({
  runId,
  rootPath,
  outputRoot,
  runRoot,
  artifactDir,
  files = [],
  findings = [],
  budget = null,
  options = {},
  onEvent = () => {},
} = {}) {
  if (!runId) throw new TypeError("runDevTestBotPhase requires runId");
  if (!rootPath) throw new TypeError("runDevTestBotPhase requires rootPath");
  if (!outputRoot) throw new TypeError("runDevTestBotPhase requires outputRoot");
  if (!runRoot) throw new TypeError("runDevTestBotPhase requires runRoot");
  if (!artifactDir) throw new TypeError("runDevTestBotPhase requires artifactDir");

  const normalized = normalizePhaseOptions(options);
  const phaseStartedAt = Date.now();
  const plan = await planDevTestBotPhase({
    rootPath,
    files,
    findings,
    budget,
    options: normalized,
  });
  const phaseRoot = path.join(runRoot, "devtestbot");
  await fsp.mkdir(phaseRoot, { recursive: true });

  onEvent({
    type: "phase_start",
    phase: "devtestbot",
    identityCount: plan.identityCount,
    swarmCount: plan.swarmCount,
    execute: plan.execute,
  });
  onEvent({
    type: "devtestbot_start",
    phase: "devtestbot",
    plan: {
      enabled: plan.enabled,
      reason: plan.reason,
      identityCount: plan.identityCount,
      swarmCount: plan.swarmCount,
      perSwarmBudget: plan.perSwarmBudget,
      scope: plan.scope,
      scopes: plan.scopes,
      execute: plan.execute,
      baseUrlProvided: Boolean(plan.baseUrl),
      maxConcurrentAgents: plan.maxConcurrentAgents,
    },
  });

  if (!plan.enabled) {
    const skipped = {
      runId,
      phase: "devtestbot",
      skipped: true,
      reason: plan.reason || "disabled",
      plan,
      identities: [],
      subagents: [],
      findings: [],
      artifactRoot: phaseRoot,
    };
    await writeJson(path.join(artifactDir, "devtestbot-summary.json"), skipped);
    onEvent({
      type: "devtestbot_complete",
      phase: "devtestbot",
      skipped: true,
      reason: skipped.reason,
      findingCount: 0,
    });
    onEvent({ type: "phase_complete", phase: "devtestbot", skipped: true, findingCount: 0 });
    return skipped;
  }

  const identities = await provisionDevTestBotIdentities({
    outputRoot,
    runId,
    count: plan.identityCount,
    provisionIdentity: normalized.provisionIdentity,
    onEvent,
  });
  const runner = normalized.runner || runDevTestBotSession;
  const subagents = Array.from({ length: plan.swarmCount }, (_, index) => {
    const subagentId = `devtestbot-${index + 1}`;
    return {
      subagentId,
      scope: plan.scopes[index] || plan.scope,
      identity: identities[index % identities.length],
      outputDir: path.join(phaseRoot, subagentId),
      budgetUsd: plan.perSwarmBudget,
    };
  });

  const packageFindings = [];
  const subagentResults = await runWithConcurrency(
    subagents,
    plan.maxConcurrentAgents,
    async (assignment) => {
      const budgetCheck = checkBudget(budget);
      if (!budgetCheck.ok) {
        onEvent({
          type: "devtestbot_agent_error",
          phase: "devtestbot",
          agentId: assignment.subagentId,
          reason: budgetCheck.reason,
        });
        return {
          subagentId: assignment.subagentId,
          identityId: assignment.identity?.identityId || "",
          scope: assignment.scope,
          completed: false,
          error: budgetCheck.reason,
          findings: [],
        };
      }

      onEvent({
        type: "devtestbot_agent_start",
        phase: "devtestbot",
        agentId: assignment.subagentId,
        identityId: assignment.identity?.identityId || "",
        scope: assignment.scope,
        execute: plan.execute,
      });
      try {
        const result = await runner({
          runId,
          targetPath: rootPath,
          outputRoot,
          outputDir: assignment.outputDir,
          scope: assignment.scope,
          identityId: assignment.identity?.identityId || "",
          baseUrl: plan.baseUrl,
          execute: plan.execute,
          recordVideo: plan.recordVideo,
        }, {
          targetPath: rootPath,
          outputRoot,
          runId,
          outputDir: assignment.outputDir,
          scope: assignment.scope,
          identityId: assignment.identity?.identityId || "",
          baseUrl: plan.baseUrl,
          execute: plan.execute,
          onEvent: (event) => {
            onEvent({
              type: "devtestbot_agent_event",
              phase: "devtestbot",
              agentId: assignment.subagentId,
              event: event?.event || event?.type || "",
            });
          },
        });
        if (budget && Number.isFinite(budget.maxUsd)) {
          budget.spentUsd += assignment.budgetUsd;
        }
        const decorated = (result.findings || []).map((finding) =>
          decorateFinding(finding, {
            subagentId: assignment.subagentId,
            identityId: assignment.identity?.identityId || "",
            artifactBundle: result.artifactBundle,
          })
        );
        packageFindings.push(...decorated);
        onEvent({
          type: "devtestbot_agent_complete",
          phase: "devtestbot",
          agentId: assignment.subagentId,
          findingCount: decorated.length,
          artifactRoot: result.artifactBundle?.root || assignment.outputDir,
        });
        return {
          ...summarizeResultForPackage({
            subagentId: assignment.subagentId,
            identity: assignment.identity,
            result,
          }),
          findings: decorated,
        };
      } catch (error) {
        const safeMessage = safeErrorMessage(error);
        onEvent({
          type: "devtestbot_agent_error",
          phase: "devtestbot",
          agentId: assignment.subagentId,
          error: safeMessage,
        });
        return {
          subagentId: assignment.subagentId,
          identityId: assignment.identity?.identityId || "",
          scope: assignment.scope,
          completed: false,
          error: safeMessage,
          findings: [],
          artifactBundle: { root: assignment.outputDir },
        };
      }
    },
  );

  const summary = {
    runId,
    phase: "devtestbot",
    skipped: false,
    artifactRoot: phaseRoot,
    generatedAt: new Date().toISOString(),
    durationSeconds: (Date.now() - phaseStartedAt) / 1000,
    plan: {
      ...plan,
      baseUrl: plan.baseUrl ? "[configured]" : "",
    },
    identities,
    subagents: subagentResults,
    findingCount: packageFindings.length,
    findings: packageFindings,
  };
  await writeJson(path.join(artifactDir, "devtestbot-summary.json"), summary);
  onEvent({
    type: "devtestbot_complete",
    phase: "devtestbot",
    findingCount: packageFindings.length,
    artifactRoot: phaseRoot,
  });
  onEvent({
    type: "phase_complete",
    phase: "devtestbot",
    findingCount: packageFindings.length,
    artifactRoot: phaseRoot,
  });
  return summary;
}
