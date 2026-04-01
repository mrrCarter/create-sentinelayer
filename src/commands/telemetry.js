import path from "node:path";

import pc from "picocolors";

import {
  appendRunEvent,
  loadRunEvents,
  summarizeRunEvents,
  RUN_EVENT_TYPES,
  STOP_CLASSES,
} from "../telemetry/ledger.js";

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

function parseReasonCodes(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return [];
  }
  return String(rawValue)
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function parseMetadata(rawValue) {
  if (!rawValue) {
    return {};
  }
  const parsed = JSON.parse(String(rawValue));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadataJson must parse to an object.");
  }
  return parsed;
}

async function runShow({ targetPath, outputDir, emitJson }) {
  const { filePath, events } = await loadRunEvents({
    targetPath,
    outputDirOverride: outputDir,
  });
  const summary = summarizeRunEvents(events);
  const payload = {
    command: "telemetry show",
    targetPath,
    filePath,
    summary,
  };

  if (emitJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(pc.bold("Telemetry summary"));
  console.log(pc.gray(`File: ${filePath}`));
  console.log(
    pc.gray(
      `Events=${summary.eventCount}, Sessions=${summary.sessionCount}, Runs=${summary.runCount}`
    )
  );
  console.log(
    pc.gray(
      `Usage totals: input=${summary.usageTotals.inputTokens}, output=${summary.usageTotals.outputTokens}, cost=$${summary.usageTotals.costUsd.toFixed(6)}, durationMs=${summary.usageTotals.durationMs}, toolCalls=${summary.usageTotals.toolCalls}`
    )
  );
}

export function registerTelemetryCommand(program) {
  const telemetry = program
    .command("telemetry")
    .description("Track run events, usage telemetry, and stop-class outcomes");

  telemetry
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional output dir override for telemetry files")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      await runShow({
        targetPath,
        outputDir: options.outputDir,
        emitJson: shouldEmitJson(options, command),
      });
    });

  telemetry
    .command("show")
    .description("Show telemetry summary from the local run-event ledger")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional output dir override for telemetry files")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      await runShow({
        targetPath,
        outputDir: options.outputDir,
        emitJson: shouldEmitJson(options, command),
      });
    });

  telemetry
    .command("record")
    .description("Record a telemetry event in the local run-event ledger")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional output dir override for telemetry files")
    .option("--session-id <id>", "Session identifier", "default")
    .option("--run-id <id>", "Run identifier", "default")
    .option(
      "--event-type <type>",
      `Event type (${RUN_EVENT_TYPES.join(", ")})`,
      "run_step"
    )
    .option("--input-tokens <n>", "Input token count", "0")
    .option("--output-tokens <n>", "Output token count", "0")
    .option("--cache-read-tokens <n>", "Cache read token count", "0")
    .option("--cache-write-tokens <n>", "Cache write token count", "0")
    .option("--cost-usd <amount>", "Usage cost in USD", "0")
    .option("--duration-ms <n>", "Event duration in milliseconds", "0")
    .option("--tool-calls <n>", "Tool calls consumed by this event", "0")
    .option(
      "--stop-class <class>",
      `Stop class (${STOP_CLASSES.join(", ")})`,
      "NONE"
    )
    .option("--blocking", "Mark the stop state as blocking")
    .option("--reason-codes <codes>", "Comma-separated stop reason codes")
    .option("--metadata-json <json>", "Optional metadata object as JSON string")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const reasonCodes = parseReasonCodes(options.reasonCodes);
      const stopClass = String(options.stopClass || "NONE").trim().toUpperCase() || "NONE";
      const stop =
        stopClass !== "NONE" || options.blocking || reasonCodes.length > 0
          ? {
              stopClass,
              blocking: Boolean(options.blocking),
              reasonCodes,
            }
          : null;

      const appended = await appendRunEvent(
        {
          targetPath,
          outputDirOverride: options.outputDir,
        },
        {
          sessionId: options.sessionId,
          runId: options.runId,
          eventType: String(options.eventType || "run_step").trim(),
          usage: {
            inputTokens: parseNonNegativeNumber(options.inputTokens, "inputTokens"),
            outputTokens: parseNonNegativeNumber(options.outputTokens, "outputTokens"),
            cacheReadTokens: parseNonNegativeNumber(options.cacheReadTokens, "cacheReadTokens"),
            cacheWriteTokens: parseNonNegativeNumber(options.cacheWriteTokens, "cacheWriteTokens"),
            costUsd: parseNonNegativeNumber(options.costUsd, "costUsd"),
            durationMs: parseNonNegativeNumber(options.durationMs, "durationMs"),
            toolCalls: parseNonNegativeNumber(options.toolCalls, "toolCalls"),
          },
          stop,
          metadata: parseMetadata(options.metadataJson),
        }
      );

      const payload = {
        command: "telemetry record",
        targetPath,
        filePath: appended.filePath,
        event: appended.event,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Telemetry event recorded"));
        console.log(pc.gray(`File: ${appended.filePath}`));
        console.log(
          pc.gray(
            `Event=${appended.event.eventType}, session=${appended.event.sessionId}, run=${appended.event.runId}, stopClass=${appended.event.stop?.stopClass || "NONE"}`
          )
        );
      }

      if (appended.event.stop?.blocking) {
        process.exitCode = 2;
      }
    });
}

