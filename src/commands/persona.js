import process from "node:process";

import { PERSONA_MODES } from "../agents/mode.js";
import {
  SUPPORTED_PERSONA_IDS,
  runPersona,
} from "../agents/run-persona.js";
import { buildLegacyArgs } from "./legacy-args.js";

export function registerPersonaCommand(program, invokeLegacy) {
  const persona = program
    .command("persona")
    .description("Run persona-scoped domain-tool sweeps or orchestrator reports");

  persona
    .command("orchestrator")
    .description("Generate mode-specific orchestrator report")
    .option("--mode <mode>", "Mode: builder|reviewer|hardener", "builder")
    .option("--path <path>", "Target repository path")
    .option("--output-dir <path>", "Artifact root for report output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const legacyArgs = buildLegacyArgs([
        "/persona",
        "orchestrator",
        "--mode",
        String(options.mode || "builder"),
      ], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });

  persona
    .command("run <personaId>")
    .description(
      `Run a single persona's domain tools over the repo and emit findings. Supported ids: ${SUPPORTED_PERSONA_IDS.join(", ")}.`
    )
    .option(
      "--mode <mode>",
      `Persona mode: ${PERSONA_MODES.join("|")}. Audit emits findings; codegen attaches allowed-tools + prompt-suffix plan so callers can drive the LLM edit loop.`,
      "audit"
    )
    .option("--path <path>", "Repository root to scan (default: cwd)", ".")
    .option(
      "--files <csv>",
      "Optional comma-separated list of files to focus the sweep. Empty = whole repo."
    )
    .option(
      "--json",
      "Always-on for this subcommand; kept for interface parity. Output is a single-line JSON object on stdout.",
      true
    )
    .action(async (personaId, options) => {
      try {
        const result = await runPersona({
          personaId,
          mode: options.mode,
          rootPath: options.path,
          files: options.files,
        });
        process.stdout.write(JSON.stringify(result));
        process.stdout.write("\n");
        process.exitCode = 0;
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        process.stderr.write(`persona run failed: ${message}\n`);
        process.exitCode = 2;
      }
    });
}
