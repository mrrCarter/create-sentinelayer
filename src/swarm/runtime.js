import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";
import { evaluateBudget } from "../cost/budget.js";

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

function createRuntimeRunId() {
  return `swarm-runtime-${formatTimestampToken()}-${randomUUID().slice(0, 8)}`;
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function estimateTokens(text) {
  const normalized = normalizeString(text);
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function normalizeEngine(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "playwright") {
    return "playwright";
  }
  return "mock";
}

function normalizeMaxSteps(value) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error("maxSteps must be an integer >= 1.");
  }
  return Math.floor(normalized);
}

function normalizePlaybookAction(action = {}) {
  const type = normalizeString(action.type).toLowerCase();
  if (!type) {
    return null;
  }
  return {
    type,
    url: normalizeString(action.url),
    selector: normalizeString(action.selector),
    text: normalizeString(action.text),
    ms: Math.max(0, Math.floor(Number(action.ms || 0))),
    path: normalizeString(action.path),
  };
}

export async function loadSwarmPlaybook(playbookFile = "") {
  const normalizedPath = normalizeString(playbookFile);
  if (!normalizedPath) {
    return [];
  }
  const resolved = path.resolve(process.cwd(), normalizedPath);
  const raw = await fsp.readFile(resolved, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.actions)) {
    throw new Error("Invalid playbook file: expected { actions: [...] }.");
  }
  return parsed.actions.map((action) => normalizePlaybookAction(action)).filter(Boolean);
}

export async function loadSwarmPlanFile(planFile = "") {
  const normalizedPath = normalizeString(planFile);
  if (!normalizedPath) {
    throw new Error("planFile is required.");
  }
  const resolved = path.resolve(process.cwd(), normalizedPath);
  const raw = await fsp.readFile(resolved, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid plan file: expected object payload.");
  }
  if (!Array.isArray(parsed.assignments) || parsed.assignments.length === 0) {
    throw new Error("Invalid plan file: assignments are required.");
  }
  return parsed;
}

function createEvent({
  runId,
  step,
  eventType,
  agentId = "",
  message = "",
  metadata = {},
  usage = {},
} = {}) {
  return {
    timestamp: new Date().toISOString(),
    runId,
    step,
    eventType,
    agentId: normalizeString(agentId).toLowerCase(),
    message: normalizeString(message),
    usage: {
      outputTokens: Number(usage.outputTokens || 0),
      toolCalls: Number(usage.toolCalls || 0),
      durationMs: Number(usage.durationMs || 0),
      costUsd: Number(usage.costUsd || 0),
    },
    metadata,
  };
}

async function executePlaywrightAction({ page, action, runDirectory, usage, runId, step }) {
  const type = action.type;
  const metadata = {
    action: type,
  };
  if (type === "goto") {
    const url = action.url || "about:blank";
    await page.goto(url, { waitUntil: "domcontentloaded" });
    metadata.url = url;
    usage.toolCalls += 1;
    usage.outputTokens += estimateTokens(`goto:${url}`);
    return createEvent({
      runId,
      step,
      eventType: "tool_call",
      agentId: "omar",
      message: `Playwright goto ${url}`,
      metadata,
      usage,
    });
  }
  if (type === "click") {
    if (!action.selector) {
      throw new Error("Playbook click action requires selector.");
    }
    await page.click(action.selector);
    metadata.selector = action.selector;
    usage.toolCalls += 1;
    usage.outputTokens += estimateTokens(`click:${action.selector}`);
    return createEvent({
      runId,
      step,
      eventType: "tool_call",
      agentId: "omar",
      message: `Playwright click ${action.selector}`,
      metadata,
      usage,
    });
  }
  if (type === "fill") {
    if (!action.selector) {
      throw new Error("Playbook fill action requires selector.");
    }
    await page.fill(action.selector, action.text || "");
    metadata.selector = action.selector;
    usage.toolCalls += 1;
    usage.outputTokens += estimateTokens(`fill:${action.selector}:${action.text || ""}`);
    return createEvent({
      runId,
      step,
      eventType: "tool_call",
      agentId: "omar",
      message: `Playwright fill ${action.selector}`,
      metadata,
      usage,
    });
  }
  if (type === "wait") {
    const waitMs = Math.max(0, Number(action.ms || 0));
    await page.waitForTimeout(waitMs);
    metadata.ms = waitMs;
    usage.toolCalls += 1;
    usage.outputTokens += estimateTokens(`wait:${waitMs}`);
    return createEvent({
      runId,
      step,
      eventType: "tool_call",
      agentId: "omar",
      message: `Playwright wait ${waitMs}ms`,
      metadata,
      usage,
    });
  }
  if (type === "screenshot") {
    const outputPath = action.path
      ? path.resolve(runDirectory, action.path)
      : path.join(runDirectory, "runtime", `step-${String(step).padStart(3, "0")}.png`);
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await page.screenshot({
      path: outputPath,
      fullPage: true,
    });
    metadata.path = toPosixPath(path.relative(runDirectory, outputPath));
    usage.toolCalls += 1;
    usage.outputTokens += estimateTokens(`screenshot:${metadata.path}`);
    return createEvent({
      runId,
      step,
      eventType: "tool_call",
      agentId: "omar",
      message: `Playwright screenshot ${metadata.path}`,
      metadata,
      usage,
    });
  }

  usage.toolCalls += 1;
  usage.outputTokens += estimateTokens(`unsupported:${type}`);
  return createEvent({
    runId,
    step,
    eventType: "tool_call",
    agentId: "omar",
    message: `Unsupported Playwright action skipped: ${type}`,
    metadata: {
      action: type,
      skipped: true,
    },
    usage,
  });
}

function buildRuntimeMarkdown(summary = {}) {
  return `# SWARM_RUNTIME

Generated: ${summary.generatedAt}
Run ID: ${summary.runId}
Plan run ID: ${summary.planRunId}
Target: ${summary.targetPath}
Scenario: ${summary.scenario}
Engine: ${summary.engine}
Execute: ${summary.execute ? "yes" : "no"}

Status:
- completed: ${summary.completed ? "yes" : "no"}
- stop_class: ${summary.stop?.stopClass || "NONE"}
- stop_reason: ${summary.stop?.reason || "none"}

Usage:
- output_tokens: ${summary.usage.outputTokens}
- tool_calls: ${summary.usage.toolCalls}
- duration_ms: ${summary.usage.durationMs}
- cost_usd: ${summary.usage.costUsd}

Artifacts:
- events: ${summary.runtimeEventsPath}
- summary_json: ${summary.runtimeJsonPath}
`;
}

async function writeRuntimeArtifacts({
  summary,
  events,
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(String(summary.targetPath || ".")),
    outputDirOverride: outputDir,
    env,
    homeDir,
  });
  const runDirectory = path.join(outputRoot, "swarms", summary.runId);
  const runtimeDirectory = path.join(runDirectory, "runtime");
  const runtimeJsonPath = path.join(runtimeDirectory, "SWARM_RUNTIME.json");
  const runtimeMarkdownPath = path.join(runtimeDirectory, "SWARM_RUNTIME.md");
  const runtimeEventsPath = path.join(runtimeDirectory, "events.ndjson");
  await fsp.mkdir(runtimeDirectory, { recursive: true });
  await fsp.writeFile(runtimeEventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf-8");

  const fullSummary = {
    ...summary,
    outputRoot,
    runDirectory,
    runtimeDirectory,
    runtimeJsonPath,
    runtimeMarkdownPath,
    runtimeEventsPath,
  };

  await fsp.writeFile(runtimeJsonPath, `${JSON.stringify(fullSummary, null, 2)}\n`, "utf-8");
  await fsp.writeFile(runtimeMarkdownPath, `${buildRuntimeMarkdown(fullSummary).trim()}\n`, "utf-8");

  return fullSummary;
}

export async function runSwarmRuntime({
  plan,
  targetPath,
  engine = "mock",
  execute = false,
  maxSteps = 20,
  startUrl = "about:blank",
  playbookActions = [],
  outputDir = "",
  env,
} = {}) {
  if (!plan || typeof plan !== "object") {
    throw new Error("plan is required.");
  }
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) {
    throw new Error("plan.assignments must include at least one assignment.");
  }

  const normalizedEngine = normalizeEngine(engine);
  const normalizedTargetPath = path.resolve(String(targetPath || plan.targetPath || "."));
  const normalizedMaxSteps = normalizeMaxSteps(maxSteps);
  const runId = createRuntimeRunId();
  const resolvedOutputRoot = await resolveOutputRoot({
    cwd: normalizedTargetPath,
    outputDirOverride: outputDir,
    env,
  });
  const runtimeRunDirectory = path.join(resolvedOutputRoot, "swarms", runId);
  const runStartedAt = Date.now();
  const events = [];
  let step = 0;

  const usage = {
    outputTokens: 0,
    toolCalls: 0,
    durationMs: 0,
    costUsd: 0,
  };
  let stop = {
    stopClass: "NONE",
    reason: "",
    blocking: false,
  };

  events.push(
    createEvent({
      runId,
      step,
      eventType: "run_start",
      agentId: "omar",
      message: `Swarm runtime started with engine=${normalizedEngine}, execute=${Boolean(execute)}`,
      metadata: {
        planRunId: normalizeString(plan.runId),
        scenario: normalizeString(plan.scenario),
      },
      usage,
    })
  );

  let browser = null;
  let page = null;
  let playwrightActions = playbookActions;

  try {
    if (normalizedEngine === "playwright" && execute) {
      const playwright = await import("playwright");
      browser = await playwright.chromium.launch({
        headless: true,
      });
      page = await browser.newPage();
      await page.goto(startUrl || "about:blank", { waitUntil: "domcontentloaded" });
      usage.toolCalls += 1;
      usage.outputTokens += estimateTokens(`goto:${startUrl || "about:blank"}`);
      step += 1;
      events.push(
        createEvent({
          runId,
          step,
          eventType: "tool_call",
          agentId: "omar",
          message: `Playwright runtime initialized at ${startUrl || "about:blank"}`,
          metadata: {
            action: "goto",
            url: startUrl || "about:blank",
          },
          usage,
        })
      );
    }

    for (const assignment of plan.assignments) {
      if (step >= normalizedMaxSteps) {
        stop = {
          stopClass: "MAX_STEPS_EXCEEDED",
          reason: `max-steps reached (${normalizedMaxSteps})`,
          blocking: true,
        };
        break;
      }

      step += 1;
      usage.outputTokens += estimateTokens(assignment.objective);
      events.push(
        createEvent({
          runId,
          step,
          eventType: "run_step",
          agentId: assignment.agentId,
          message: `Assignment started: ${assignment.objective}`,
          metadata: {
            assignmentId: assignment.assignmentId,
            role: assignment.role,
            domain: assignment.domain,
          },
          usage,
        })
      );

      if (normalizedEngine === "mock" || !execute) {
        usage.toolCalls += 1;
        usage.outputTokens += estimateTokens(`mock:${assignment.agentId}`);
        step += 1;
        events.push(
          createEvent({
            runId,
            step,
            eventType: "tool_call",
            agentId: assignment.agentId,
            message: `Mock runtime action completed for ${assignment.agentId}`,
            metadata: {
              engine: normalizedEngine,
              execute: Boolean(execute),
            },
            usage,
          })
        );
      } else if (normalizedEngine === "playwright" && execute && page) {
        if (!Array.isArray(playwrightActions) || playwrightActions.length === 0) {
          playwrightActions = [
            {
              type: "wait",
              ms: 250,
            },
            {
              type: "screenshot",
            },
          ];
        }

        for (const action of playwrightActions) {
          if (step >= normalizedMaxSteps) {
            stop = {
              stopClass: "MAX_STEPS_EXCEEDED",
              reason: `max-steps reached (${normalizedMaxSteps})`,
              blocking: true,
            };
            break;
          }
          step += 1;
          const event = await executePlaywrightAction({
            page,
            action,
            runDirectory: runtimeRunDirectory,
            usage,
            runId,
            step,
          });
          events.push(event);
        }
        if (stop.blocking) {
          break;
        }
      }

      usage.durationMs = Date.now() - runStartedAt;
      usage.costUsd = Number((usage.outputTokens * 0.000003).toFixed(6));
      const budgetStatus = evaluateBudget({
        sessionSummary: {
          costUsd: usage.costUsd,
          outputTokens: usage.outputTokens,
          noProgressStreak: 0,
          durationMs: usage.durationMs,
          toolCalls: usage.toolCalls,
        },
        maxCostUsd: Number(plan.globalBudget?.maxCostUsd || 5),
        maxOutputTokens: Number(plan.globalBudget?.maxOutputTokens || 20000),
        maxNoProgress: Number.MAX_SAFE_INTEGER,
        maxRuntimeMs: Number(plan.globalBudget?.maxRuntimeMs || 3600000),
        maxToolCalls: Number(plan.globalBudget?.maxToolCalls || 500),
        warningThresholdPercent: Number(plan.globalBudget?.warningThresholdPercent || 80),
      });
      if (budgetStatus.blocking) {
        stop = {
          stopClass: String(budgetStatus.reasons[0]?.code || "BUDGET_EXCEEDED"),
          reason: String(budgetStatus.reasons[0]?.message || "Budget exceeded."),
          blocking: true,
        };
        step += 1;
        events.push(
          createEvent({
            runId,
            step,
            eventType: "budget_stop",
            agentId: "omar",
            message: stop.reason,
            metadata: {
              reasonCodes: budgetStatus.reasons.map((reason) => reason.code),
            },
            usage,
          })
        );
        break;
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  usage.durationMs = Date.now() - runStartedAt;
  usage.costUsd = Number((usage.outputTokens * 0.000003).toFixed(6));
  const completed = !stop.blocking;
  if (completed) {
    step += 1;
    events.push(
      createEvent({
        runId,
        step,
        eventType: "run_stop",
        agentId: "omar",
        message: "Swarm runtime completed successfully.",
        metadata: {
          completed: true,
        },
        usage,
      })
    );
  } else {
    step += 1;
    events.push(
      createEvent({
        runId,
        step,
        eventType: "run_stop",
        agentId: "omar",
        message: stop.reason || "Swarm runtime stopped.",
        metadata: {
          completed: false,
          stopClass: stop.stopClass,
        },
        usage,
      })
    );
  }

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId,
    planRunId: normalizeString(plan.runId),
    targetPath: normalizedTargetPath,
    scenario: normalizeString(plan.scenario || "qa_audit"),
    engine: normalizedEngine,
    execute: Boolean(execute),
    startUrl: normalizeString(startUrl || "about:blank"),
    maxSteps: normalizedMaxSteps,
    completed,
    stop,
    usage,
    eventCount: events.length,
    selectedAgents: Array.isArray(plan.selectedAgents) ? [...plan.selectedAgents] : [],
  };

  return writeRuntimeArtifacts({
    summary,
    events,
    outputDir,
    env,
  });
}
