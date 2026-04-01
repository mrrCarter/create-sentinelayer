import { buildLegacyArgs } from "./legacy-args.js";

export function registerApplyCommand(program, invokeLegacy) {
  program
    .command("apply")
    .description("Parse a todo plan into deterministic execution order")
    .requiredOption("--plan <path>", "Path to plan markdown")
    .option("--path <path>", "Target repository path")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const planPath = String(options.plan || "").trim();
      const legacyArgs = buildLegacyArgs(["/apply", "--plan", planPath], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });
}
