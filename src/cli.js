import process from "node:process";
import { Command } from "commander";

import { CLI_VERSION, runLegacyCliWithErrorHandling } from "./legacy-cli.js";
import { registerInitCommand } from "./commands/init.js";
import { registerOmarGateCommand } from "./commands/omargate.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerPersonaCommand } from "./commands/persona.js";
import { registerApplyCommand } from "./commands/apply.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerIngestCommand } from "./commands/ingest.js";
import { registerSpecCommand } from "./commands/spec.js";
import { registerPromptCommand } from "./commands/prompt.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerGuideCommand } from "./commands/guide.js";

const COMMAND_SET = new Set([
  "init",
  "omargate",
  "audit",
  "persona",
  "apply",
  "config",
  "ingest",
  "spec",
  "prompt",
  "scan",
  "guide",
]);

function shouldBypassCommander(rawArgs) {
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    return true;
  }

  const first = String(rawArgs[0] || "").trim();
  if (!first) {
    return true;
  }

  if (first.startsWith("/")) {
    return true;
  }

  if (first === "--help" || first === "-h" || first === "--version" || first === "-v") {
    return true;
  }

  if (first.startsWith("-")) {
    return true;
  }

  return !COMMAND_SET.has(first);
}

export function buildCliProgram({ invokeLegacy = runLegacyCliWithErrorHandling } = {}) {
  const program = new Command();

  program
    .name("create-sentinelayer")
    .description("Sentinelayer CLI")
    .version(CLI_VERSION)
    .option("--verbose", "Verbose execution logs")
    .option("--json", "Emit machine-readable output when supported")
    .showHelpAfterError();

  registerInitCommand(program, invokeLegacy);
  registerOmarGateCommand(program, invokeLegacy);
  registerAuditCommand(program, invokeLegacy);
  registerPersonaCommand(program, invokeLegacy);
  registerApplyCommand(program, invokeLegacy);
  registerConfigCommand(program);
  registerIngestCommand(program);
  registerSpecCommand(program);
  registerPromptCommand(program);
  registerScanCommand(program);
  registerGuideCommand(program);

  return program;
}

export async function runCli(rawArgs = process.argv.slice(2)) {
  if (shouldBypassCommander(rawArgs)) {
    await runLegacyCliWithErrorHandling(rawArgs);
    return;
  }

  const program = buildCliProgram({ invokeLegacy: runLegacyCliWithErrorHandling });
  await program.parseAsync(["node", "create-sentinelayer", ...rawArgs]);
}
