import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import pc from "picocolors";

import { SentinelayerApiError } from "../auth/http.js";
import {
  getRuntimeRunStatus,
  listRuntimeRunEvents,
  resolveActiveAuthSession,
} from "../auth/service.js";
import { resolveOutputRoot } from "../config/service.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function parsePositiveNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function parseNonNegativeNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "run";
}

function stableTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function stringifyValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function summarizePayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }

  const preferredKeys = [
    "summary",
    "message",
    "reason",
    "code",
    "tool_name",
    "tool",
    "command",
    "status",
    "gate_status",
    "decision",
    "stage",
  ];
  for (const key of preferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      continue;
    }
    const rawValue = stringifyValue(payload[key]).trim();
    if (!rawValue) {
      continue;
    }
    return `${key}=${rawValue}`;
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length <= 180) {
    return serialized;
  }
  return `${serialized.slice(0, 177)}...`;
}

function formatRunEvent(event = {}) {
  const ts = formatTimestamp(event.ts);
  const type = String(event.type || "event").trim() || "event";
  const actor = String(event.actor || "runtime").trim() || "runtime";
  const summary = summarizePayload(event.payload || {});
  const usage = [];
  const durationMs = Number(event.duration_ms || 0);
  if (Number.isFinite(durationMs) && durationMs > 0) {
    usage.push(`duration_ms=${Math.round(durationMs)}`);
  }
  const tokenUsage = Number(event.token_usage || 0);
  if (Number.isFinite(tokenUsage) && tokenUsage > 0) {
    usage.push(`tokens=${Math.round(tokenUsage)}`);
  }
  const costUsd = Number(event.cost_usd || 0);
  if (Number.isFinite(costUsd) && costUsd > 0) {
    usage.push(`cost_usd=${costUsd.toFixed(6)}`);
  }
  const usageSuffix = usage.length > 0 ? ` [${usage.join(" ")}]` : "";
  return `[${ts}] ${type} (${actor})${summary ? ` ${summary}` : ""}${usageSuffix}`;
}

function formatApiError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
  }
  const requestId = error.requestId ? ` request_id=${error.requestId}` : "";
  return `${error.message} [${error.code}] status=${error.status}${requestId}`;
}

function normalizeHistoryEntry(raw = {}, filePath = "") {
  return {
    command: String(raw.command || "watch run-events").trim() || "watch run-events",
    runId: String(raw.runId || "").trim(),
    apiUrl: String(raw.apiUrl || "").trim(),
    tokenSource: String(raw.tokenSource || "").trim(),
    status: String(raw.status || "unknown").trim().toLowerCase(),
    terminal: Boolean(raw.terminal),
    stopReason: String(raw.stopReason || "unknown").trim(),
    startedAt: String(raw.startedAt || "").trim(),
    endedAt: String(raw.endedAt || "").trim(),
    durationMs: Number(raw.durationMs || 0),
    eventCount: Number(raw.eventCount || 0),
    lastEventId: raw.lastEventId ? String(raw.lastEventId) : null,
    summaryPath: filePath,
    eventsPath:
      raw.artifacts && typeof raw.artifacts === "object" && raw.artifacts.eventsPath
        ? String(raw.artifacts.eventsPath)
        : null,
    watchDir:
      raw.artifacts && typeof raw.artifacts === "object" && raw.artifacts.watchDir
        ? String(raw.artifacts.watchDir)
        : null,
  };
}

function sortHistoryEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const leftEpoch = Date.parse(String(left.endedAt || left.startedAt || "")) || 0;
    const rightEpoch = Date.parse(String(right.endedAt || right.startedAt || "")) || 0;
    return rightEpoch - leftEpoch;
  });
}

async function collectWatchHistory({
  targetPath,
  outputDir,
  runId = "",
  limit = 20,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: targetPath,
    outputDirOverride: outputDir,
    env: process.env,
  });
  const baseDir = path.join(outputRoot, "observability", "runtime-watch");
  const normalizedRunId = String(runId || "").trim();

  let runDirs = [];
  if (normalizedRunId) {
    runDirs = [sanitizePathSegment(normalizedRunId)];
  } else {
    try {
      const entries = await fsp.readdir(baseDir, { withFileTypes: true });
      runDirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return {
          outputRoot,
          baseDir,
          entries: [],
        };
      }
      throw error;
    }
  }

  const history = [];
  for (const runDirName of runDirs) {
    const runDirPath = path.join(baseDir, runDirName);
    let files = [];
    try {
      files = await fsp.readdir(runDirPath, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const summaryFiles = files
      .filter((entry) => entry.isFile() && entry.name.startsWith("summary-") && entry.name.endsWith(".json"))
      .map((entry) => path.join(runDirPath, entry.name));

    for (const filePath of summaryFiles) {
      try {
        const rawText = await fsp.readFile(filePath, "utf-8");
        const parsed = JSON.parse(rawText);
        history.push(normalizeHistoryEntry(parsed, filePath));
      } catch {
        // Skip malformed summary artifacts so one corrupt file does not block history listing.
      }
    }
  }

  const sorted = sortHistoryEntries(history);
  return {
    outputRoot,
    baseDir,
    entries: sorted.slice(0, Math.max(1, Math.round(Number(limit || 20)))),
  };
}

async function resolveWatchArtifacts({
  targetPath,
  outputDir,
  runId,
  enabled,
} = {}) {
  if (!enabled) {
    return null;
  }
  const outputRoot = await resolveOutputRoot({
    cwd: targetPath,
    outputDirOverride: outputDir,
    env: process.env,
  });
  const watchStamp = stableTimestampForFile();
  const watchDir = path.join(
    outputRoot,
    "observability",
    "runtime-watch",
    sanitizePathSegment(runId)
  );
  await fsp.mkdir(watchDir, { recursive: true });
  return {
    watchDir,
    eventsPath: path.join(watchDir, `events-${watchStamp}.ndjson`),
    summaryPath: path.join(watchDir, `summary-${watchStamp}.json`),
  };
}

export function registerWatchCommand(program) {
  const watch = program
    .command("watch")
    .description("Stream runtime execution events and persist reproducible watch artifacts");

  watch
    .command("history")
    .description("List persisted runtime watch summaries from local observability artifacts")
    .option("--run-id <id>", "Filter by runtime run id")
    .option("--path <path>", "Workspace path for config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--limit <n>", "Maximum summaries to return", "20")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const limit = parsePositiveNumber(options.limit, "limit", 20);
      const history = await collectWatchHistory({
        targetPath,
        outputDir: options.outputDir,
        runId: options.runId,
        limit,
      });

      const payload = {
        command: "watch history",
        baseDir: history.baseDir,
        entryCount: history.entries.length,
        entries: history.entries,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Runtime watch history"));
      console.log(pc.gray(`Base dir: ${history.baseDir}`));
      if (!history.entries.length) {
        console.log(pc.gray("(no watch artifacts found)"));
        return;
      }

      for (const entry of history.entries) {
        console.log(
          `${entry.runId || "unknown-run"} | status=${entry.status} | events=${entry.eventCount} | stop=${entry.stopReason} | ended=${entry.endedAt || "unknown"}`
        );
        if (entry.summaryPath) {
          console.log(pc.gray(`  summary: ${entry.summaryPath}`));
        }
      }
    });

  watch
    .command("run-events")
    .alias("runtime")
    .description("Poll runtime events for a run until terminal status or idle timeout")
    .requiredOption("--run-id <id>", "Runtime run identifier")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--path <path>", "Workspace path for config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--poll-seconds <seconds>", "Event polling interval in seconds", "2")
    .option("--max-idle-seconds <seconds>", "Stop if no events arrive for this long (0 disables)", "0")
    .option("--no-save-artifacts", "Disable writing watch logs to local observability artifacts")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const runId = String(options.runId || "").trim();
      if (!runId) {
        throw new Error("runId is required.");
      }

      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const pollSeconds = parsePositiveNumber(options.pollSeconds, "pollSeconds", 2);
      const maxIdleSeconds = parseNonNegativeNumber(options.maxIdleSeconds, "maxIdleSeconds", 0);
      const pollMs = Math.max(250, Math.round(pollSeconds * 1000));
      const maxIdleMs = maxIdleSeconds > 0 ? Math.round(maxIdleSeconds * 1000) : 0;
      const artifactPaths = await resolveWatchArtifacts({
        targetPath,
        outputDir: options.outputDir,
        runId,
        enabled: Boolean(options.saveArtifacts),
      });

      let session;
      try {
        session = await resolveActiveAuthSession({
          cwd: targetPath,
          env: process.env,
          explicitApiUrl: options.apiUrl,
          autoRotate: true,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      if (!session || !session.token) {
        throw new Error("No active auth token found. Run `sl auth login` first.");
      }

      const startedAtEpoch = Date.now();
      const startedAt = new Date(startedAtEpoch).toISOString();
      let lastActivityEpoch = Date.now();
      let afterEventId = null;
      let eventCount = 0;
      let latestStatus;
      let stopReason;
      let terminal = false;

      if (!emitJson) {
        console.log(pc.bold(`Watching runtime events: ${runId}`));
        console.log(pc.gray(`API: ${session.apiUrl}`));
        console.log(pc.gray(`Token source: ${session.source}`));
        if (artifactPaths) {
          console.log(pc.gray(`Artifact dir: ${artifactPaths.watchDir}`));
        }
      }

      try {
        while (true) {
          const response = await listRuntimeRunEvents({
            apiUrl: session.apiUrl,
            authToken: session.token,
            runId,
            afterEventId,
          });
          const events = Array.isArray(response?.events) ? response.events : [];

          for (const event of events) {
            const eventId = String(event?.event_id || "").trim();
            if (eventId) {
              afterEventId = eventId;
            }
            lastActivityEpoch = Date.now();
            eventCount += 1;

            if (artifactPaths?.eventsPath) {
              await fsp.appendFile(artifactPaths.eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
            }

            if (emitJson) {
              console.log(
                JSON.stringify({
                  stream: "runtime_event",
                  runId,
                  event,
                })
              );
            } else {
              console.log(formatRunEvent(event));
            }
          }

          const statusResponse = await getRuntimeRunStatus({
            apiUrl: session.apiUrl,
            authToken: session.token,
            runId,
          });
          latestStatus = String(statusResponse?.status || "unknown").trim().toLowerCase();
          terminal = TERMINAL_RUN_STATUSES.has(latestStatus);
          if (terminal && events.length === 0) {
            stopReason = "terminal";
            break;
          }

          if (maxIdleMs > 0 && Date.now() - lastActivityEpoch >= maxIdleMs) {
            stopReason = "idle_timeout";
            break;
          }

          await sleep(pollMs);
        }
      } catch (error) {
        if (error instanceof SentinelayerApiError && (error.status === 401 || error.status === 403)) {
          throw new Error("Authentication failed while watching runtime events. Run `sl auth login`.");
        }
        throw new Error(formatApiError(error));
      }

      const endedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - startedAtEpoch);
      const summary = {
        command: "watch run-events",
        runId,
        apiUrl: session.apiUrl,
        tokenSource: session.source,
        status: latestStatus ?? "unknown",
        terminal,
        stopReason: stopReason ?? "unknown",
        startedAt,
        endedAt,
        durationMs,
        eventCount,
        lastEventId: afterEventId,
        artifacts: artifactPaths
          ? {
              watchDir: artifactPaths.watchDir,
              eventsPath: artifactPaths.eventsPath,
              summaryPath: artifactPaths.summaryPath,
            }
          : null,
      };

      if (artifactPaths?.summaryPath) {
        await fsp.writeFile(artifactPaths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
      }

      if (emitJson) {
        console.log(
          JSON.stringify(
            {
              stream: "runtime_watch_summary",
              ...summary,
            },
            null,
            2
          )
        );
      } else {
        console.log(pc.bold("Watch complete"));
        console.log(pc.gray(`Status: ${latestStatus}`));
        console.log(pc.gray(`Events: ${eventCount}`));
        console.log(pc.gray(`Duration: ${durationMs}ms`));
        if (artifactPaths?.summaryPath) {
          console.log(pc.gray(`Summary artifact: ${artifactPaths.summaryPath}`));
        }
        if (stopReason === "idle_timeout") {
          console.log(pc.yellow("Stopped due to max idle timeout before terminal run status."));
        }
      }

      if (stopReason === "idle_timeout" && !terminal) {
        process.exitCode = 2;
      }
    });
}
