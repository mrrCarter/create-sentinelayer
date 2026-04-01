import fsp from "node:fs/promises";
import path from "node:path";

import pc from "picocolors";

import {
  createMultiProviderApiClient,
  resolveModel,
  resolveProvider,
} from "../ai/client.js";
import { loadConfig } from "../config/service.js";
import { evaluateBudget } from "../cost/budget.js";
import { appendCostEntry, summarizeCostHistory } from "../cost/history.js";
import { estimateModelCost } from "../cost/tracker.js";
import { collectCodebaseIngest } from "../ingest/engine.js";
import { generateSpecMarkdown, resolveSpecTemplate } from "../spec/generator.js";
import { SPEC_TEMPLATES } from "../spec/templates.js";
import { appendRunEvent, deriveStopClassFromBudget } from "../telemetry/ledger.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function parseNonNegativeNumber(rawValue, field) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function parsePercent(rawValue, field) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${field} must be between 0 and 100.`);
  }
  return normalized;
}

function estimateTokenCount(text) {
  const normalized = String(text || "");
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function resolveConfiguredApiKey(provider, resolvedConfig = {}) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "openai") {
    return String(resolvedConfig.openaiApiKey || "").trim();
  }
  if (normalizedProvider === "anthropic") {
    return String(resolvedConfig.anthropicApiKey || "").trim();
  }
  if (normalizedProvider === "google") {
    return String(resolvedConfig.googleApiKey || "").trim();
  }
  return "";
}

function buildAiSpecPrompt({
  baseSpecMarkdown,
  template,
  description,
  ingest,
} = {}) {
  const summary = ingest?.summary || {};
  const frameworkSummary =
    Array.isArray(ingest?.frameworks) && ingest.frameworks.length > 0
      ? ingest.frameworks.join(", ")
      : "none";
  const riskSummary =
    Array.isArray(ingest?.riskSurfaces) && ingest.riskSurfaces.length > 0
      ? ingest.riskSurfaces.slice(0, 10).map((item) => item.surface).join(", ")
      : "code_quality";

  return [
    "You are a senior software architect improving a deterministic SPEC document.",
    "Return only markdown. Do not include code fences around the full response.",
    "Maintain the section structure and keep language concrete and implementation-ready.",
    "Preserve deterministic constraints and include explicit security/reliability controls.",
    "",
    `Template: ${template?.id || "api-service"}`,
    `Goal override: ${String(description || "").trim() || "none"}`,
    `Files scanned: ${summary.filesScanned || 0}`,
    `Total LOC: ${summary.totalLoc || 0}`,
    `Framework hints: ${frameworkSummary}`,
    `Risk surfaces: ${riskSummary}`,
    "",
    "Source SPEC markdown:",
    baseSpecMarkdown,
  ].join("\n");
}

function maybeEstimateModelCost({ modelId, inputTokens, outputTokens }) {
  try {
    return {
      costUsd: estimateModelCost({
        modelId,
        inputTokens,
        outputTokens,
      }),
      pricingFound: true,
    };
  } catch {
    return {
      costUsd: 0,
      pricingFound: false,
    };
  }
}

function printAiSummary(ai) {
  console.log(pc.bold("AI enhancement"));
  console.log(pc.gray(`Provider: ${ai.provider}, Model: ${ai.model}`));
  console.log(
    pc.gray(
      `Input tokens=${ai.usage.inputTokens}, Output tokens=${ai.usage.outputTokens}, Cost=$${ai.usage.costUsd.toFixed(6)}, DurationMs=${ai.usage.durationMs}`
    )
  );
  if (!ai.pricingFound) {
    console.log(pc.yellow("Model pricing missing from local table; cost recorded as 0."));
  }
  if (ai.budget.blocking) {
    console.log(pc.red("AI budget guardrail triggered:"));
    for (const reason of ai.budget.reasons) {
      console.log(`- ${reason.code}: ${reason.message}`);
    }
  } else if (ai.budget.warnings.length > 0) {
    console.log(pc.yellow("AI budget warning threshold reached:"));
    for (const warning of ai.budget.warnings) {
      console.log(`- ${warning.code}: ${warning.message}`);
    }
  }
}

async function maybeEnhanceSpecWithAi({
  enabled,
  options,
  targetPath,
  template,
  description,
  ingest,
  baseSpecMarkdown,
} = {}) {
  if (!enabled) {
    return {
      markdown: baseSpecMarkdown,
      ai: null,
    };
  }

  const config = await loadConfig({ cwd: targetPath });
  const resolvedProvider = resolveProvider({
    provider: options.provider,
    configProvider: config.resolved.defaultModelProvider,
    env: process.env,
  });
  const resolvedModel = resolveModel({
    provider: resolvedProvider,
    model: options.model,
    configModel: config.resolved.defaultModelId,
  });
  const explicitApiKey = String(options.apiKey || "").trim();
  const configuredApiKey = resolveConfiguredApiKey(resolvedProvider, config.resolved);

  const prompt = buildAiSpecPrompt({
    baseSpecMarkdown,
    template,
    description,
    ingest,
  });

  const startedAtMs = Date.now();
  const client = createMultiProviderApiClient();
  const result = await client.invoke({
    provider: resolvedProvider,
    model: resolvedModel,
    prompt,
    apiKey: explicitApiKey || configuredApiKey,
    env: process.env,
    stream: false,
  });
  const durationMs = Math.max(0, Date.now() - startedAtMs);

  const normalizedText = String(result.text || "").trim();
  const enhancedMarkdown = normalizedText || baseSpecMarkdown;

  const inputTokens = estimateTokenCount(prompt);
  const outputTokens = estimateTokenCount(enhancedMarkdown);
  const modelCost = maybeEstimateModelCost({
    modelId: result.model,
    inputTokens,
    outputTokens,
  });

  const sessionId = String(options.sessionId || "spec-generate-ai").trim() || "spec-generate-ai";
  const appendedCost = await appendCostEntry(
    {
      targetPath,
      outputDirOverride: options.outputDir,
    },
    {
      sessionId,
      provider: result.provider,
      model: result.model,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs,
      toolCalls: 1,
      costUsd: modelCost.costUsd,
      progressScore: normalizedText ? 1 : 0,
    }
  );

  const costSummary = summarizeCostHistory(appendedCost.history);
  const sessionSummary = costSummary.sessions.find((item) => item.sessionId === sessionId) || {
    sessionId,
    invocationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    toolCalls: 0,
    costUsd: 0,
    noProgressStreak: 0,
  };

  const budget = evaluateBudget({
    sessionSummary,
    maxCostUsd: parseNonNegativeNumber(options.maxCost, "maxCost"),
    maxOutputTokens: parseNonNegativeNumber(options.maxTokens, "maxTokens"),
    maxNoProgress: parseNonNegativeNumber(options.maxNoProgress, "maxNoProgress"),
    maxRuntimeMs: parseNonNegativeNumber(options.maxRuntimeMs, "maxRuntimeMs"),
    maxToolCalls: parseNonNegativeNumber(options.maxToolCalls, "maxToolCalls"),
    warningThresholdPercent: parsePercent(options.warnAtPercent, "warnAtPercent"),
  });

  const usageTelemetry = await appendRunEvent(
    {
      targetPath,
      outputDirOverride: options.outputDir,
    },
    {
      sessionId,
      runId: sessionId,
      eventType: "usage",
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: modelCost.costUsd,
        durationMs,
        toolCalls: 1,
      },
      metadata: {
        sourceCommand: "spec generate --ai",
        provider: result.provider,
        model: result.model,
        invocationId: appendedCost.entry.invocationId,
      },
    }
  );

  let stopTelemetry = null;
  if (budget.blocking) {
    stopTelemetry = await appendRunEvent(
      {
        targetPath,
        outputDirOverride: options.outputDir,
      },
      {
        sessionId,
        runId: sessionId,
        eventType: "run_stop",
        usage: {
          inputTokens: sessionSummary.inputTokens,
          outputTokens: sessionSummary.outputTokens,
          cacheReadTokens: sessionSummary.cacheReadTokens,
          cacheWriteTokens: sessionSummary.cacheWriteTokens,
          costUsd: sessionSummary.costUsd,
          durationMs: sessionSummary.durationMs,
          toolCalls: sessionSummary.toolCalls,
        },
        stop: {
          stopClass: deriveStopClassFromBudget(budget),
          blocking: true,
          reasonCodes: budget.reasons.map((reason) => reason.code),
        },
        metadata: {
          sourceCommand: "spec generate --ai",
          provider: result.provider,
          model: result.model,
          invocationId: appendedCost.entry.invocationId,
        },
      }
    );
  }

  return {
    markdown: enhancedMarkdown,
    ai: {
      enabled: true,
      provider: result.provider,
      model: result.model,
      pricingFound: modelCost.pricingFound,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: modelCost.costUsd,
        durationMs,
        toolCalls: 1,
      },
      budget,
      cost: {
        filePath: appendedCost.filePath,
        invocationId: appendedCost.entry.invocationId,
        sessionId,
      },
      telemetry: {
        filePath: usageTelemetry.filePath,
        usageEventId: usageTelemetry.event.eventId,
        stopEventId: stopTelemetry?.event?.eventId || null,
      },
    },
  };
}

export function registerSpecCommand(program) {
  const spec = program
    .command("spec")
    .description("Offline spec generation and template management");

  spec
    .command("list-templates")
    .description("List built-in spec templates")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify({ templates: SPEC_TEMPLATES }, null, 2));
        return;
      }

      console.log(pc.bold("Available templates"));
      for (const template of SPEC_TEMPLATES) {
        console.log(`- ${template.id}: ${template.name} - ${template.description}`);
      }
    });

  spec
    .command("show-template <templateId>")
    .description("Show details for one template")
    .option("--json", "Emit machine-readable output")
    .action(async (templateId, options, command) => {
      const template = resolveSpecTemplate(templateId);
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify({ template }, null, 2));
        return;
      }

      console.log(pc.bold(`${template.name} (${template.id})`));
      console.log(template.description);
      console.log("\nArchitecture focus:");
      template.architectureFocus.forEach((item, index) => console.log(`${index + 1}. ${item}`));
      console.log("\nSecurity checklist:");
      template.securityChecklist.forEach((item, index) => console.log(`${index + 1}. ${item}`));
    });

  spec
    .command("generate")
    .description("Generate SPEC.md from ingest + selected template")
    .option("--path <path>", "Target workspace path", ".")
    .option("--template <templateId>", "Template id (see spec list-templates)", "api-service")
    .option("--description <text>", "Optional primary goal override")
    .option("--output-file <path>", "Output file path relative to --path", "SPEC.md")
    .option("--output-dir <path>", "Optional output dir override for cost/telemetry artifacts")
    .option("--ai", "Enable AI-enhanced markdown refinement after deterministic spec generation")
    .option("--provider <name>", "AI provider override (openai|anthropic|google)")
    .option("--model <id>", "AI model override")
    .option("--api-key <key>", "Optional explicit API key override for --ai mode")
    .option("--session-id <id>", "Cost/telemetry session id for --ai mode", "spec-generate-ai")
    .option("--max-cost <usd>", "Max AI cost budget per session", "1")
    .option("--max-tokens <n>", "Max output token budget per session (0 = disabled)", "0")
    .option("--max-runtime-ms <n>", "Max runtime budget per session in milliseconds (0 = disabled)", "0")
    .option("--max-tool-calls <n>", "Max tool-call budget per session (0 = disabled)", "0")
    .option("--max-no-progress <n>", "Max consecutive no-progress events before stop", "3")
    .option("--warn-at-percent <n>", "Warning threshold percentage for enabled budgets", "80")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputFile = String(options.outputFile || "SPEC.md").trim() || "SPEC.md";
      const outputPath = path.resolve(targetPath, outputFile);

      const template = resolveSpecTemplate(options.template);
      const ingest = await collectCodebaseIngest({ rootPath: targetPath });
      const deterministicMarkdown = generateSpecMarkdown({
        template,
        description: options.description,
        ingest,
        projectPath: targetPath,
      });

      const aiResult = await maybeEnhanceSpecWithAi({
        enabled: Boolean(options.ai),
        options,
        targetPath,
        template,
        description: options.description,
        ingest,
        baseSpecMarkdown: deterministicMarkdown,
      });

      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, `${aiResult.markdown.trimEnd()}\n`, "utf-8");

      const payload = {
        command: "spec generate",
        template: template.id,
        targetPath,
        outputPath,
        summary: ingest.summary,
        frameworks: ingest.frameworks,
        riskSurfaces: ingest.riskSurfaces,
        ai: aiResult.ai,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Spec generated"));
        console.log(pc.gray(`Template: ${template.id}`));
        console.log(pc.gray(`Output: ${outputPath}`));
        if (aiResult.ai) {
          printAiSummary(aiResult.ai);
        }
      }

      if (aiResult.ai?.budget?.blocking) {
        process.exitCode = 2;
      }
    });
}

