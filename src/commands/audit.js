import { buildLegacyArgs } from "./legacy-args.js";

export function registerAuditCommand(program, invokeLegacy) {
  program
    .command("audit")
    .description("Run local readiness + policy audit")
    .option("--path <path>", "Target repository path")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const legacyArgs = buildLegacyArgs(["/audit"], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });
}
