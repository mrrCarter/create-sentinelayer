import { randomUUID } from "node:crypto";
import path from "node:path";

import { createMultiProviderApiClient } from "../ai/client.js";
import { evaluateBudget } from "../cost/budget.js";
import { estimateTokens } from "../cost/tokenizer.js";
import { createAgentEvent } from "../events/schema.js";
import {
  SHARED_TOOLS,
  SHARED_READ_ONLY_TOOLS,
  createAgentContext,
  createToolDispatcher,
  BudgetExhaustedError,
} from "../agents/shared-tools/index.js";
import {
  DEFAULT_AUDIT_AGENT_TOOLS,
  normalizeAuditAgentTools,
} from "./registry.js";

const DEFAULT_MAX_TURNS = 6;
const HEARTBEAT_INTERVAL_TURNS = 3;
const DEFAULT_PERSONA_BUDGET = Object.freeze({
  maxCostUsd: 0.75,
  maxOutputTokens: 6000,
  maxRuntimeMs: 300000,
  maxToolCalls: 50,
  warningThresholdPercent: 70,
});

const MUTATING_TOOLS = new Set(["FileEdit"]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSeverity(value) {
  const severity = normalizeString(value).toUpperCase();
  if (severity === "P0" || severity === "P1" || severity === "P2" || severity === "P3") {
    return severity;
  }
  return "P3";
}

function normalizeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPosixPath(value) {
  return normalizeString(value).replace(/\\/g, "/");
}

function severitySummary(findings = []) {
  const summary = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings || []) {
    const severity = normalizeSeverity(finding.severity);
    summary[severity] += 1;
  }
  summary.blocking = summary.P0 > 0 || summary.P1 > 0;
  summary.findingCount = findings.length;
  return summary;
}

function normalizeFinding(finding = {}, agent = {}, source = "persona-agentic-loop") {
  const title = normalizeString(finding.title || finding.message || finding.ruleId || "Audit finding");
  const message = normalizeString(finding.message || finding.title || title);
  return {
    ...finding,
    severity: normalizeSeverity(finding.severity),
    file: toPosixPath(finding.file || finding.path || ""),
    line: Math.max(0, Math.floor(normalizeNumber(finding.line, 0))),
    title,
    message,
    confidence: Math.max(0, Math.min(1, normalizeNumber(finding.confidence, agent.confidenceFloor || 0.7))),
    persona: normalizeString(finding.persona || agent.id),
    source: normalizeString(finding.source || source),
  };
}

function snapshotUsage(ctx) {
  return {
    costUsd: ctx.usage.costUsd,
    outputTokens: ctx.usage.outputTokens,
    toolCalls: ctx.usage.toolCalls,
    durationMs: Date.now() - ctx.startedAt,
    filesRead: [...(ctx.usage.filesRead || [])],
  };
}

function buildAgentIdentity(agent = {}) {
  return {
    id: normalizeString(agent.id) || "audit-persona",
    persona: normalizeString(agent.persona || agent.id || "Audit Persona"),
    domain: normalizeString(agent.domain),
  };
}

function resolveGrantedTools(agent = {}) {
  const grants = normalizeAuditAgentTools(agent.tools, { useDefaultWhenEmpty: true });
  return grants.length > 0 ? grants : [...DEFAULT_AUDIT_AGENT_TOOLS];
}

function resolveAvailableTools(agent = {}) {
  const permissionMode = normalizeString(agent.permissionMode || "plan").toLowerCase();
  const granted = resolveGrantedTools(agent);
  return granted.filter((tool) => {
    if (!SHARED_TOOLS[tool]) {
      return false;
    }
    if (permissionMode === "plan" && MUTATING_TOOLS.has(tool)) {
      return false;
    }
    return true;
  });
}

function createAuditToolDispatcher(availableTools = []) {
  const toolMap = {};
  const readOnlyTools = new Set();
  for (const tool of availableTools) {
    if (!SHARED_TOOLS[tool]) {
      continue;
    }
    toolMap[tool] = SHARED_TOOLS[tool];
    if (SHARED_READ_ONLY_TOOLS.has(tool)) {
      readOnlyTools.add(tool);
    }
  }
  return createToolDispatcher(toolMap, readOnlyTools);
}

function normalizePathWithinRoot(value, rootPath) {
  const raw = normalizeString(value);
  if (!raw || raw === ".") {
    return rootPath;
  }
  return path.isAbsolute(raw) ? raw : path.resolve(rootPath, raw);
}

function normalizeToolInput(toolName, input = {}, rootPath) {
  const normalized = { ...(input || {}) };
  if (toolName === "FileRead") {
    normalized.file_path = normalizePathWithinRoot(
      normalized.file_path || normalized.filePath || normalized.path,
      rootPath
    );
    normalized.allowed_root = rootPath;
  } else if (toolName === "FileEdit") {
    normalized.file_path = normalizePathWithinRoot(
      normalized.file_path || normalized.filePath || normalized.path,
      rootPath
    );
    normalized.allowed_root = rootPath;
  } else if (toolName === "Grep" || toolName === "Glob") {
    normalized.path = normalizePathWithinRoot(normalized.path || ".", rootPath);
  } else if (toolName === "Shell") {
    normalized.cwd = normalizePathWithinRoot(normalized.cwd || ".", rootPath);
  }
  return normalized;
}

function buildPersonaSystemPrompt({
  agent,
  rootPath,
  ingest,
  grantedTools,
  availableTools,
  sharedContext,
  hybridContext,
}) {
  const summary = ingest?.summary || {};
  const frameworks = Array.isArray(ingest?.frameworks) ? ingest.frameworks.join(", ") : "";
  const riskSurfaces = Array.isArray(ingest?.riskSurfaces)
    ? ingest.riskSurfaces.map((item) => item.surface || item).filter(Boolean).join(", ")
    : "";
  const sharedCount = Array.isArray(sharedContext?.entries) ? sharedContext.entries.length : 0;
  const hybridCount = Array.isArray(hybridContext?.results) ? hybridContext.results.length : 0;

  return `SYSTEM PROMPT - SENTINELAYER AUDIT PERSONA
${agent.persona} | ${agent.domain} | ${agent.id}

ROLE
You are the ${agent.domain} specialist for SentinelLayer's investor due-diligence audit.
You are isolated from other personas. Build your own evidence before trusting routed baseline findings.

CODEBASE CONTEXT
Root: ${rootPath}
Files scanned: ${summary.filesScanned || "unknown"}
Total LOC: ${summary.totalLoc || "unknown"}
Frameworks: ${frameworks || "unknown"}
Risk surfaces: ${riskSurfaces || "none"}
Shared context entries: ${sharedCount}
Hybrid memory entries: ${hybridCount}

AVAILABLE TOOLS
Granted: ${grantedTools.join(", ") || "none"}
Usable in this run: ${availableTools.join(", ") || "none"}
To call a tool, output exactly one fenced block:
\`\`\`tool_use
{"tool":"Grep","input":{"pattern":"credential|token|secret","path":"."}}
\`\`\`

EVIDENCE CONTRACT - 11 LENSES
1. Security, auth, secrets, and trust boundaries
2. Architecture, module boundaries, dependency direction, and coupling
3. Data layer correctness, migrations, queries, and persistence guarantees
4. Release engineering, CI/CD gates, provenance, rollback, and versioning
5. Infrastructure, environment, IaC, and blast radius
6. Reliability, timeout, retry, idempotency, and failure-mode behavior
7. Observability, logs, metrics, traces, and alertability
8. Testing, coverage, fixture quality, and regression proof
9. Performance, runtime cost, N+1 paths, and bottlenecks
10. Compliance, privacy, policy, retention, and audit evidence
11. Documentation, operator guidance, AI governance, and maintainability

RULES
- Use tools before reporting a finding unless the finding is already in supplied evidence.
- Every confirmed finding needs file, line, severity, user/system impact, recommended fix, and confidence.
- Report only high-confidence findings. Below ${agent.confidenceFloor || 0.7} is an evidence gap, not a confirmed issue.
- In plan mode, do not mutate files. If FileEdit is not usable, propose the fix without editing.
- Prefer a small number of concrete findings over noisy speculation.

OUTPUT CONTRACT
When you need more evidence, call one tool.
When complete, return a JSON array in a fenced \`\`\`json block:
[{
  "severity": "P1",
  "file": "src/example.js",
  "line": 42,
  "title": "Concrete issue title",
  "message": "Concrete issue title",
  "evidence": "File:line proof or command output summary",
  "rootCause": "Why it happens",
  "recommendedFix": "Smallest safe fix",
  "user_impact": "What users or operators experience",
  "confidence": 0.9
}]`;
}

function buildInitialUserPrompt({
  agent,
  deterministicBaseline,
  seedFindings,
  sharedContext,
  hybridContext,
}) {
  const parts = [];
  parts.push(`Run an isolated ${agent.domain} audit pass now.`);
  parts.push("Start by inspecting the code with tools. Do not simply restate routed baseline findings.");

  const baselineFindings = Array.isArray(deterministicBaseline?.findings)
    ? deterministicBaseline.findings
    : [];
  if (baselineFindings.length > 0) {
    parts.push(`\nOmar deterministic baseline has ${baselineFindings.length} total findings. You may use it only after forming evidence.`);
    for (const finding of baselineFindings.slice(0, 12)) {
      parts.push(`- [${finding.severity || "P3"}] ${finding.file || ""}:${finding.line || ""} ${finding.message || finding.title || ""}`);
    }
  }

  if (seedFindings.length > 0) {
    parts.push(`\nRouted/legacy seed findings for your domain (${seedFindings.length}):`);
    for (const finding of seedFindings.slice(0, 12)) {
      parts.push(`- [${finding.severity || "P3"}] ${finding.file || ""}:${finding.line || ""} ${finding.message || finding.title || ""}`);
    }
  }

  const sharedEntries = Array.isArray(sharedContext?.entries) ? sharedContext.entries : [];
  if (sharedEntries.length > 0) {
    parts.push(`\nShared blackboard context (${sharedEntries.length}):`);
    for (const entry of sharedEntries.slice(0, 8)) {
      parts.push(`- [${entry.severity || "P3"}] ${entry.file || ""}:${entry.line || ""} ${entry.message || ""}`);
    }
  }

  const hybridResults = Array.isArray(hybridContext?.results) ? hybridContext.results : [];
  if (hybridResults.length > 0) {
    parts.push(`\nMemory recall (${hybridResults.length}):`);
    for (const entry of hybridResults.slice(0, 8)) {
      parts.push(`- ${entry.snippet || entry.text || entry.documentId || ""}`);
    }
  }

  parts.push("\nFirst action: call a relevant read/search tool. If enough evidence already exists, return the final JSON findings.");
  return parts.join("\n");
}

function parseToolUseBlocks(text) {
  const calls = [];
  const regex = /```tool_use\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(String(text || ""))) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const tool = normalizeAuditAgentTools([entry?.tool || entry?.name])[0] || "";
        if (tool) {
          calls.push({
            tool,
            input: entry?.input && typeof entry.input === "object" ? entry.input : {},
          });
        }
      }
    } catch {
      // Malformed tool blocks are ignored; the next model turn can recover.
    }
  }
  return calls;
}

function parseJsonFindings(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```json\s*\n([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw.trim();
  if (!candidate) {
    return [];
  }
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed?.findings)) {
      return parsed.findings;
    }
  } catch {
    // No valid findings payload.
  }
  return [];
}

function formatPromptForClient(systemPrompt, messages) {
  const parts = [systemPrompt];
  for (const message of messages) {
    const role = message.role === "assistant" ? "ASSISTANT" : "USER";
    parts.push(`\n${role}:\n${message.content}`);
  }
  return parts.join("\n");
}

function createDeterministicPersonaClient() {
  let callCount = 0;
  return {
    async invoke() {
      callCount += 1;
      if (callCount === 1) {
        return {
          provider: "local",
          model: "deterministic-persona-test",
          text: [
            "I will inspect the repository file set before concluding.",
            "```tool_use",
            "{\"tool\":\"Glob\",\"input\":{\"pattern\":\"**/*.{js,ts,tsx,jsx,json,yml,yaml,md}\",\"path\":\".\",\"limit\":50}}",
            "```",
          ].join("\n"),
        };
      }
      return {
        provider: "local",
        model: "deterministic-persona-test",
        text: "No additional high-confidence findings beyond the supplied evidence.\n```json\n[]\n```",
      };
    },
  };
}

function resolveClient({ clientFactory, provider, env }) {
  if (typeof clientFactory === "function") {
    return clientFactory();
  }
  if (env?.SENTINELAYER_CLI_TEST_MODE === "1" && env?.SENTINELAYER_CLI_LIVE_AI_TESTS !== "1") {
    return createDeterministicPersonaClient();
  }
  return createMultiProviderApiClient(provider || {});
}

function estimateResponseUsage(response, responseText) {
  const usage = response?.usage || {};
  const outputTokens = Math.max(
    0,
    Math.floor(normalizeNumber(usage.outputTokens ?? usage.output_tokens, estimateTokens(responseText, {
      provider: response?.provider,
      model: response?.model,
    })))
  );
  const costUsd = Math.max(0, normalizeNumber(usage.costUsd ?? usage.cost_usd, (outputTokens / 1_000_000) * 15));
  return { outputTokens, costUsd };
}

function computeConfidence(agent, findings = []) {
  if (!findings.length) {
    return Math.min(0.99, Math.max(0, normalizeNumber(agent.confidenceFloor, 0.7)) + 0.05);
  }
  const total = findings.reduce((sum, finding) => sum + normalizeNumber(finding.confidence, agent.confidenceFloor || 0.7), 0);
  return Math.max(0, Math.min(1, total / findings.length));
}

export async function runPersonaAgenticLoop({
  agent,
  rootPath,
  ingest = null,
  deterministicBaseline = null,
  seedFindings = [],
  sharedContext = null,
  hybridContext = null,
  artifactDir = "",
  provider = null,
  budget = {},
  maxTurns = null,
  abortController = null,
  onEvent = null,
  clientFactory = null,
  env = process.env,
  dryRun = false,
} = {}) {
  const resolvedRootPath = path.resolve(String(rootPath || "."));
  const normalizedAgent = {
    id: normalizeString(agent?.id) || "audit-persona",
    persona: normalizeString(agent?.persona || agent?.id || "Audit Persona"),
    domain: normalizeString(agent?.domain || "Audit"),
    permissionMode: normalizeString(agent?.permissionMode || "plan") || "plan",
    maxTurns: Math.max(1, Math.floor(normalizeNumber(agent?.maxTurns, DEFAULT_MAX_TURNS))),
    confidenceFloor: Math.max(0, Math.min(1, normalizeNumber(agent?.confidenceFloor, 0.7))),
    tools: resolveGrantedTools(agent || {}),
  };
  const grantedTools = resolveGrantedTools(normalizedAgent);
  const availableTools = resolveAvailableTools(normalizedAgent);
  const toolDispatcher = createAuditToolDispatcher(availableTools);
  const startedAt = Date.now();
  const runId = `audit-persona-${normalizedAgent.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const agentIdentity = buildAgentIdentity(normalizedAgent);
  const loopBudget = { ...DEFAULT_PERSONA_BUDGET, ...budget };
  const ctx = createAgentContext({
    agentIdentity,
    budget: loopBudget,
    runId,
    artifactDir,
    onEvent,
  });

  const emit = (event, payload = {}) => {
    const evt = createAgentEvent({
      event,
      agent: agentIdentity,
      payload,
      usage: snapshotUsage(ctx),
      sessionId: ctx.sessionId,
      runId,
    });
    if (onEvent) {
      onEvent(evt);
    }
    return evt;
  };

  const allFindings = (Array.isArray(seedFindings) ? seedFindings : []).map((finding) =>
    normalizeFinding(finding, normalizedAgent, "legacy-seed")
  );
  const loopMaxTurns = Math.max(
    1,
    Math.floor(normalizeNumber(maxTurns, normalizedAgent.maxTurns || DEFAULT_MAX_TURNS))
  );

  emit("agent_start", {
    runId,
    mode: "audit",
    maxTurns: loopMaxTurns,
    budget: loopBudget,
    grantedTools,
    availableTools,
    permissionMode: normalizedAgent.permissionMode,
    dryRun: Boolean(dryRun),
  });

  if (dryRun) {
    emit("progress", {
      phase: "dry_run",
      message: `${normalizedAgent.id} planned with ${availableTools.length} usable tools.`,
    });
    const summary = severitySummary(allFindings);
    emit("agent_complete", {
      ...summary,
      status: "dry_run",
      turns: 0,
      costUsd: ctx.usage.costUsd,
      durationMs: Date.now() - startedAt,
    });
    return {
      runId,
      agentId: normalizedAgent.id,
      persona: normalizedAgent.persona,
      domain: normalizedAgent.domain,
      status: "dry_run",
      findings: allFindings,
      summary,
      confidence: computeConfidence(normalizedAgent, allFindings),
      usage: snapshotUsage(ctx),
      grantedTools,
      availableTools,
    };
  }

  const client = resolveClient({ clientFactory, provider, env });
  const systemPrompt = buildPersonaSystemPrompt({
    agent: normalizedAgent,
    rootPath: resolvedRootPath,
    ingest,
    grantedTools,
    availableTools,
    sharedContext,
    hybridContext,
  });
  const messages = [
    {
      role: "user",
      content: buildInitialUserPrompt({
        agent: normalizedAgent,
        deterministicBaseline,
        seedFindings: allFindings,
        sharedContext,
        hybridContext,
      }),
    },
  ];

  let turnCount = 0;
  let status = "completed";

  while (turnCount < loopMaxTurns) {
    if (abortController?.signal?.aborted) {
      status = "aborted";
      emit("agent_abort", { reason: "aborted", turn: turnCount });
      break;
    }

    const preCheck = evaluateBudget({
      sessionSummary: {
        costUsd: ctx.usage.costUsd,
        outputTokens: ctx.usage.outputTokens,
        durationMs: Date.now() - ctx.startedAt,
        toolCalls: ctx.usage.toolCalls,
        noProgressStreak: 0,
      },
      ...loopBudget,
    });
    if (preCheck.blocking) {
      status = "budget_stop";
      emit("budget_stop", { reasons: preCheck.reasons, turn: turnCount });
      break;
    }
    if (preCheck.warnings.length > 0) {
      emit("budget_warning", { warnings: preCheck.warnings, turn: turnCount });
    }

    turnCount += 1;
    if (turnCount % HEARTBEAT_INTERVAL_TURNS === 0) {
      emit("heartbeat", {
        turnsCompleted: turnCount,
        turnsMax: loopMaxTurns,
        findingsSoFar: allFindings.length,
      });
    }

    let response;
    try {
      response = await client.invoke({
        prompt: formatPromptForClient(systemPrompt, messages),
      });
    } catch (error) {
      status = "llm_error_fallback";
      emit("llm_error", {
        turn: turnCount,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }

    const responseText = normalizeString(response?.text);
    const responseUsage = estimateResponseUsage(response, responseText);
    ctx.usage.outputTokens += responseUsage.outputTokens;
    ctx.usage.costUsd += responseUsage.costUsd;
    ctx.usage.runtimeMs = Date.now() - ctx.startedAt;

    emit("reasoning", {
      phase: "agentic_analysis",
      turn: turnCount,
      summary: responseText.slice(0, 240),
    });

    const toolCalls = parseToolUseBlocks(responseText);
    if (toolCalls.length === 0) {
      const parsedFindings = parseJsonFindings(responseText).map((finding) =>
        normalizeFinding(finding, normalizedAgent)
      );
      for (const finding of parsedFindings) {
        allFindings.push(finding);
        emit("finding", finding);
      }
      messages.push({ role: "assistant", content: responseText });
      break;
    }

    const toolResults = [];
    for (const call of toolCalls) {
      if (!availableTools.includes(call.tool)) {
        const error = `Tool ${call.tool} is not available to ${normalizedAgent.id}.`;
        toolResults.push({ tool: call.tool, error });
        emit("tool_result", { tool: call.tool, success: false, error });
        continue;
      }
      try {
        const input = normalizeToolInput(call.tool, call.input, resolvedRootPath);
        const result = await toolDispatcher.dispatchTool(call.tool, input, ctx);
        toolResults.push({ tool: call.tool, result });
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          status = "budget_stop";
          emit("budget_stop", {
            turn: turnCount,
            reason: error.message,
            reasons: error.budgetCheck?.reasons || [],
          });
          break;
        }
        toolResults.push({
          tool: call.tool,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    messages.push({ role: "assistant", content: responseText });
    messages.push({
      role: "user",
      content:
        toolResults
          .map((result) =>
            result.error
              ? `Tool ${result.tool} failed: ${result.error}`
              : `Tool ${result.tool} result:\n${JSON.stringify(result.result).slice(0, 3500)}`
          )
          .join("\n\n") +
        "\n\nContinue the audit. Call another tool if needed. If done, return final findings in a fenced JSON array.",
    });

    if (status === "budget_stop") {
      break;
    }
  }

  if (turnCount >= loopMaxTurns && status === "completed") {
    emit("progress", {
      phase: "turn_limit",
      message: `${normalizedAgent.id} reached maxTurns=${loopMaxTurns}.`,
    });
  }

  const summary = severitySummary(allFindings);
  const confidence = computeConfidence(normalizedAgent, allFindings);
  const usage = snapshotUsage(ctx);
  emit("agent_complete", {
    ...summary,
    status,
    turns: turnCount,
    confidence,
    costUsd: usage.costUsd,
    durationMs: Date.now() - startedAt,
  });

  return {
    runId,
    agentId: normalizedAgent.id,
    persona: normalizedAgent.persona,
    domain: normalizedAgent.domain,
    status,
    findings: allFindings,
    summary,
    confidence,
    usage,
    grantedTools,
    availableTools,
    turns: turnCount,
  };
}
