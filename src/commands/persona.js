import { buildLegacyArgs } from "./legacy-args.js";

export function registerPersonaCommand(program, invokeLegacy) {
  const persona = program
    .command("persona")
    .description("Generate orchestrator persona context");

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
}
