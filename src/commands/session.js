import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import { createSession, DEFAULT_TTL_SECONDS } from "../session/store.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function parsePositiveInteger(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.floor(normalized);
}

export function registerSessionCommand(program) {
  const session = program
    .command("session")
    .description("Persistent multi-agent session stream controls");

  session
    .command("start")
    .description("Create a new persistent session with metadata + NDJSON stream")
    .option("--path <path>", "Workspace path for the session", ".")
    .option(
      "--ttl-seconds <seconds>",
      `Session time-to-live in seconds (default ${DEFAULT_TTL_SECONDS})`,
      String(DEFAULT_TTL_SECONDS)
    )
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const ttlSeconds = parsePositiveInteger(options.ttlSeconds, "ttl-seconds", DEFAULT_TTL_SECONDS);
      const startedAt = Date.now();
      const created = await createSession({
        targetPath,
        ttlSeconds,
      });
      const durationMs = Date.now() - startedAt;

      const payload = {
        command: "session start",
        targetPath,
        durationMs,
        sessionId: created.sessionId,
        sessionDir: created.sessionDir,
        metadataPath: created.metadataPath,
        streamPath: created.streamPath,
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        elapsedTimer: created.elapsedTimer,
        renewalCount: created.renewalCount,
        status: created.status,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Session created"));
      console.log(pc.gray(`Session: ${created.sessionId}`));
      console.log(pc.gray(`Stream: ${created.streamPath}`));
      console.log(pc.gray(`Created in ${durationMs}ms`));
      console.log(
        `status=${created.status} created_at=${created.createdAt} expires_at=${created.expiresAt} ttl_seconds=${ttlSeconds}`
      );
    });
}
