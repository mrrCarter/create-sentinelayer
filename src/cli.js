import process from "node:process";
import { Command } from "commander";

import { CLI_VERSION, runLegacyCliWithErrorHandling } from "./legacy-cli.js";

const COMMAND_REGISTRARS = {
  init: {
    loader: () => import("./commands/init.js"),
    exportName: "registerInitCommand",
    needsLegacy: true,
  },
  omargate: {
    loader: () => import("./commands/omargate.js"),
    exportName: "registerOmarGateCommand",
    needsLegacy: true,
  },
  audit: {
    loader: () => import("./commands/audit.js"),
    exportName: "registerAuditCommand",
    needsLegacy: true,
  },
  persona: {
    loader: () => import("./commands/persona.js"),
    exportName: "registerPersonaCommand",
    needsLegacy: true,
  },
  apply: {
    loader: () => import("./commands/apply.js"),
    exportName: "registerApplyCommand",
    needsLegacy: true,
  },
  config: {
    loader: () => import("./commands/config.js"),
    exportName: "registerConfigCommand",
    needsLegacy: false,
  },
  ingest: {
    loader: () => import("./commands/ingest.js"),
    exportName: "registerIngestCommand",
    needsLegacy: false,
  },
  spec: {
    loader: () => import("./commands/spec.js"),
    exportName: "registerSpecCommand",
    needsLegacy: false,
  },
  prompt: {
    loader: () => import("./commands/prompt.js"),
    exportName: "registerPromptCommand",
    needsLegacy: false,
  },
  scan: {
    loader: () => import("./commands/scan.js"),
    exportName: "registerScanCommand",
    needsLegacy: false,
  },
  guide: {
    loader: () => import("./commands/guide.js"),
    exportName: "registerGuideCommand",
    needsLegacy: false,
  },
  cost: {
    loader: () => import("./commands/cost.js"),
    exportName: "registerCostCommand",
    needsLegacy: false,
  },
  telemetry: {
    loader: () => import("./commands/telemetry.js"),
    exportName: "registerTelemetryCommand",
    needsLegacy: false,
  },
  auth: {
    loader: () => import("./commands/auth.js"),
    exportName: "registerAuthCommand",
    needsLegacy: false,
  },
  watch: {
    loader: () => import("./commands/watch.js"),
    exportName: "registerWatchCommand",
    needsLegacy: false,
  },
  mcp: {
    loader: () => import("./commands/mcp.js"),
    exportName: "registerMcpCommand",
    needsLegacy: false,
  },
  plugin: {
    loader: () => import("./commands/plugin.js"),
    exportName: "registerPluginCommand",
    needsLegacy: false,
  },
  ai: {
    loader: () => import("./commands/ai.js"),
    exportName: "registerAiCommand",
    needsLegacy: false,
  },
  review: {
    loader: () => import("./commands/review.js"),
    exportName: "registerReviewCommand",
    needsLegacy: false,
  },
  chat: {
    loader: () => import("./commands/chat.js"),
    exportName: "registerChatCommand",
    needsLegacy: false,
  },
  policy: {
    loader: () => import("./commands/policy.js"),
    exportName: "registerPolicyCommand",
    needsLegacy: false,
  },
  swarm: {
    loader: () => import("./commands/swarm.js"),
    exportName: "registerSwarmCommand",
    needsLegacy: false,
  },
  daemon: {
    loader: () => import("./commands/daemon.js"),
    exportName: "registerDaemonCommand",
    needsLegacy: false,
  },
  session: {
    loader: () => import("./commands/session.js"),
    exportName: "registerSessionCommand",
    needsLegacy: false,
  },
};

const COMMAND_SET = new Set(Object.keys(COMMAND_REGISTRARS));

// Map slash-prefixed commands to their Commander equivalents.
// /omargate → omargate, /audit → audit local, etc.
// Only remap /omargate to Commander. The others (/audit, /persona, /apply)
// stay on the legacy path for backward compatibility (different output format).
const SLASH_TO_COMMANDER = {
  "/omargate": "omargate",
};

function normalizeSlashArgs(rawArgs) {
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) return rawArgs;
  const first = String(rawArgs[0] || "").trim();

  // Direct slash match: /omargate → omargate
  const mapped = SLASH_TO_COMMANDER[first];
  if (mapped) {
    return [mapped, ...rawArgs.slice(1)];
  }

  // Windows Git Bash path mangling fix: /omargate gets converted to
  // "C:/Program Files/Git/omargate" by MSYS. Detect and recover.
  for (const [slash, cmd] of Object.entries(SLASH_TO_COMMANDER)) {
    const suffix = slash.slice(1); // "omargate" from "/omargate"
    if (first.endsWith("/" + suffix) || first.endsWith("\\" + suffix)) {
      return [cmd, ...rawArgs.slice(1)];
    }
  }

  return rawArgs;
}

function shouldBypassCommander(rawArgs) {
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    return true;
  }

  const first = String(rawArgs[0] || "").trim();
  if (!first) {
    return true;
  }

  // Slash commands are now handled by normalizeSlashArgs before this check
  if (first.startsWith("/") && !SLASH_TO_COMMANDER[first]) {
    return true;
  }

  if (first === "--help" || first === "-h" || first === "help" || first === "--version" || first === "-v") {
    return true;
  }

  if (first.startsWith("-")) {
    return true;
  }

  const resolved = SLASH_TO_COMMANDER[first] || first;
  return !COMMAND_SET.has(resolved);
}

async function registerCommands(program, { invokeLegacy, onlyCommand } = {}) {
  const commandNames =
    onlyCommand && COMMAND_REGISTRARS[onlyCommand]
      ? [onlyCommand]
      : Object.keys(COMMAND_REGISTRARS);

  for (const commandName of commandNames) {
    const descriptor = COMMAND_REGISTRARS[commandName];
    const loaded = await descriptor.loader();
    const registerFn = loaded[descriptor.exportName];
    if (typeof registerFn !== "function") {
      throw new Error(
        `Command registrar '${descriptor.exportName}' was not exported by '${commandName}' loader.`
      );
    }
    if (descriptor.needsLegacy) {
      registerFn(program, invokeLegacy);
    } else {
      registerFn(program);
    }
  }
}

export async function buildCliProgram({
  invokeLegacy = runLegacyCliWithErrorHandling,
  onlyCommand = null,
} = {}) {
  const program = new Command();

  program
    .name("sentinelayer-cli")
    .description("Sentinelayer CLI")
    .version(CLI_VERSION)
    .option("--verbose", "Verbose execution logs")
    .option("--quiet", "Suppress progress indicators and terminal notifications")
    .option("--json", "Emit machine-readable output when supported")
    .showHelpAfterError();

  await registerCommands(program, {
    invokeLegacy,
    onlyCommand: onlyCommand && COMMAND_SET.has(onlyCommand) ? onlyCommand : null,
  });

  return program;
}

export async function runCli(rawArgs = process.argv.slice(2)) {
  // Normalize slash commands (/omargate → omargate, /audit → audit, etc.)
  const normalizedArgs = normalizeSlashArgs(rawArgs);

  // Auth gate — require login for all commands except auth/help/version/config
  const { checkAuthGate, printAuthRequired } = await import("./auth/gate.js");
  const authResult = await checkAuthGate(normalizedArgs);
  if (!authResult.authenticated) {
    printAuthRequired(authResult.failureReason);
    return;
  }

  if (shouldBypassCommander(normalizedArgs)) {
    await runLegacyCliWithErrorHandling(normalizedArgs);
    return;
  }

  const program = await buildCliProgram({
    invokeLegacy: runLegacyCliWithErrorHandling,
    onlyCommand: normalizedArgs[0],
  });
  await program.parseAsync(["node", "sentinelayer-cli", ...normalizedArgs]);
}

