import { buildLegacyArgs } from "./legacy-args.js";

export function registerOmarGateCommand(program, invokeLegacy) {
  const omargate = program
    .command("omargate")
    .description("Run local Omar Gate security analysis (deterministic + AI)");

  omargate
    .command("deep")
    .description("Run full Omar Gate deep scan with 22-rule deterministic + AI analysis")
    .option("--path <path>", "Target repository path")
    .option("--output-dir <path>", "Artifact root for report output")
    .option("--no-ai", "Skip AI review layer (deterministic only)")
    .option("--ai-dry-run", "Run AI layer in dry-run mode (no LLM call)")
    .option("--model <id>", "LLM model override (default: gpt-5.3-codex)")
    .option("--provider <name>", "LLM provider: sentinelayer, openai, anthropic, google")
    .option("--max-cost <usd>", "Maximum AI layer cost in USD (default: 1.0)")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const legacyArgs = buildLegacyArgs(["/omargate", "deep"], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });
}
