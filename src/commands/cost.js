import path from "node:path";

import pc from "picocolors";

import { evaluateBudget } from "../cost/budget.js";
import {
  appendCostEntry,
  loadCostHistory,
  summarizeCostHistory,
} from "../cost/history.js";
import { estimateModelCost } from "../cost/tracker.js";
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

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function printSessionSummary(session) {
  console.log(pc.bold(`Session: ${session.sessionId}`));
  console.log(
    pc.gray(
      `Invocations=${session.invocationCount}, Input=${session.inputTokens}, Output=${session.outputTokens}, Cost=${formatUsd(
        session.costUsd
      )}`
    )
  );
  console.log(
    pc.gray(
      `Cache(read/write)=${session.cacheReadTokens}/${session.cacheWriteTokens}, RuntimeMs=${session.durationMs}, ToolCalls=${session.toolCalls}, No-progress streak=${session.noProgressStreak}`
    )
  );
}

async function runShow({ targetPath, outputDir, emitJson }) {
  const { filePath, history } = await loadCostHistory({
    targetPath,
    outputDirOverride: outputDir,
  });
  const summary = summarizeCostHistory(history);

  const payload = {
    command: "cost show",
    targetPath,
    filePath,
    summary,
  };

  if (emitJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(pc.bold("Cost history summary"));
  console.log(pc.gray(`File: ${filePath}`));
  console.log(
    pc.gray(
      `Sessions=${summary.sessionCount}, Invocations=${summary.invocationCount}, Total cost=${formatUsd(
        summary.costUsd
      )}`
    )
  );
  for (const session of summary.sessions) {
    printSessionSummary(session);
  }
}

export function registerCostCommand(program) {
  const cost = program.command("cost").description("Track cost usage and enforce budget governors");

  cost
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional output dir override for cost history")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      await runShow({
        targetPath,
        outputDir: options.outputDir,
        emitJson: shouldEmitJson(options, command),
      });
    });

  cost
    .command("show")
    .description("Show project/session cost usage summary")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional output dir override for cost history")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      await runShow({
        targetPath,
        outputDir: options.outputDir,
        emitJson: shouldEmitJson(options, command),
      });
    });

  cost
    .command("record")
    .description("Record one invocation usage event and evaluate budget limits")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional output dir override for cost history")
    .option("--session-id <id>", "Session identifier", "default")
    .option("--provider <name>", "Provider name", "openai")
    .option("--model <id>", "Model identifier", "gpt-5.3-codex")
    .option("--input-tokens <n>", "Input token count", "0")
    .option("--output-tokens <n>", "Output token count", "0")
    .option("--cache-read-tokens <n>", "Cache read token count", "0")
    .option("--cache-write-tokens <n>", "Cache write token count", "0")
    .option("--duration-ms <n>", "Invocation runtime in milliseconds", "0")
    .option("--tool-calls <n>", "Invocation tool-call count", "0")
    .option("--cost-usd <amount>", "Optional explicit cost override in USD")
    .option("--progress-score <n>", "Progress score (<=0 increments no-progress streak)", "1")
    .option("--max-cost <usd>", "Max cost budget per session", "1")
    .option("--max-tokens <n>", "Max output token budget per session (0 = disabled)", "0")
    .option("--max-runtime-ms <n>", "Max runtime budget per session in milliseconds (0 = disabled)", "0")
    .option("--max-tool-calls <n>", "Max tool-call budget per session (0 = disabled)", "0")
    .option("--max-no-progress <n>", "Max consecutive no-progress events before stop", "3")
    .option("--warn-at-percent <n>", "Warning threshold percentage for enabled budgets", "80")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const provider = String(options.provider || "openai").trim().toLowerCase();
      const model = String(options.model || "").trim();
      const inputTokens = parseNonNegativeNumber(options.inputTokens, "inputTokens");
      const outputTokens = parseNonNegativeNumber(options.outputTokens, "outputTokens");
      const cacheReadTokens = parseNonNegativeNumber(options.cacheReadTokens, "cacheReadTokens");
      const cacheWriteTokens = parseNonNegativeNumber(options.cacheWriteTokens, "cacheWriteTokens");
      const durationMs = parseNonNegativeNumber(options.durationMs, "durationMs");
      const toolCalls = parseNonNegativeNumber(options.toolCalls, "toolCalls");
      const progressScore = Number(options.progressScore || 0);

      const costUsd =
        options.costUsd !== undefined && options.costUsd !== null
          ? parseNonNegativeNumber(options.costUsd, "costUsd")
          : estimateModelCost({
              modelId: model,
              inputTokens,
              outputTokens,
            });

      const appended = await appendCostEntry(
        {
          targetPath,
          outputDirOverride: options.outputDir,
        },
        {
          sessionId: options.sessionId,
          provider,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          durationMs,
          toolCalls,
          costUsd,
          progressScore,
        }
      );

      const summary = summarizeCostHistory(appended.history);
      const sessionSummary = summary.sessions.find((item) => item.sessionId === options.sessionId) || {
        sessionId: options.sessionId,
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
          sessionId: options.sessionId,
          runId: options.sessionId,
          eventType: "usage",
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            durationMs,
            toolCalls,
            costUsd,
          },
          metadata: {
            sourceCommand: "cost record",
            provider,
            model,
            invocationId: appended.entry.invocationId,
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
            sessionId: options.sessionId,
            runId: options.sessionId,
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
              sourceCommand: "cost record",
              provider,
              model,
              invocationId: appended.entry.invocationId,
            },
          }
        );
      }

      const payload = {
        command: "cost record",
        targetPath,
        filePath: appended.filePath,
        entry: appended.entry,
        session: sessionSummary,
        budget,
        telemetry: {
          filePath: usageTelemetry.filePath,
          usageEventId: usageTelemetry.event.eventId,
          stopEventId: stopTelemetry?.event?.eventId || null,
        },
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Cost entry recorded"));
        console.log(pc.gray(`File: ${appended.filePath}`));
        console.log(pc.gray(`Telemetry file: ${usageTelemetry.filePath}`));
        printSessionSummary(sessionSummary);
        if (budget.blocking) {
          console.log(pc.red("Budget guardrail triggered:"));
          for (const reason of budget.reasons) {
            console.log(`- ${reason.code}: ${reason.message}`);
          }
        } else if (budget.warnings.length > 0) {
          console.log(pc.yellow("Budget warning threshold reached:"));
          for (const warning of budget.warnings) {
            console.log(`- ${warning.code}: ${warning.message}`);
          }
        } else {
          console.log(pc.green("Budget status: within limits."));
        }
      }

      if (budget.blocking) {
        process.exitCode = 2;
      }
    });
}
