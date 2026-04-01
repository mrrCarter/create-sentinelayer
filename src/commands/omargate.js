import { buildLegacyArgs } from "./legacy-args.js";

export function registerOmarGateCommand(program, invokeLegacy) {
  const omargate = program
    .command("omargate")
    .description("Run local Omar Gate checks");

  omargate
    .command("deep")
    .description("Run local credential/policy scan")
    .option("--path <path>", "Target repository path")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const legacyArgs = buildLegacyArgs(["/omargate", "deep"], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });
}
