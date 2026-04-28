import { buildLegacyArgs } from "./legacy-args.js";

export function registerOmarGateCommand(program, invokeLegacy) {
  const omargate = program
    .command("omargate")
    .description("Run local Omar Gate security analysis (deterministic + AI persona swarm)");

  omargate
    .command("deep")
    .description("Run full Omar Gate deep scan with 22-rule deterministic + multi-persona AI analysis")
    .option("--path <path>", "Target repository path")
    .option("--output-dir <path>", "Artifact root for report output")
    .option("--no-ai", "Skip AI review layer (deterministic only)")
    .option("--ai-dry-run", "Run AI layer in dry-run mode (no LLM call)")
    .option("--scan-mode <mode>", "Scan depth: baseline (1 persona), deep (13), full-depth (13)")
    .option("--max-parallel <n>", "Max concurrent persona calls (default: 4)")
    .option("--model <id>", "LLM model override (default: gpt-5.3-codex)")
    .option("--provider <name>", "LLM provider: sentinelayer, openai, anthropic")
    .option("--max-cost <usd>", "Maximum AI layer cost in USD (default: 5.0)")
    .option("--persona <csv>", "Only run these personas (comma-separated IDs); unknown IDs are dropped + warned")
    .option("--skip-persona <csv>", "Skip these personas (comma-separated IDs)")
    .option("--stream", "Emit NDJSON events to stdout as personas run")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const legacyArgs = buildLegacyArgs(["/omargate", "deep"], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });

  // Investor-DD mode (docs/INVESTOR_DD_ARCHITECTURE.md). Per-file agentic
  // review across all 13 personas with deterministic file routing,
  // reproducibility chain per finding, Senti session streaming, and a
  // final report shipped via email + dashboard card. Trades runtime +
  // cost for depth — budgets default to 45min / $25 vs deep's 2min / $5.
  omargate
    .command("investor-dd")
    .description("Investor-grade due-diligence audit: per-file agentic review + reproducibility chain + email/dashboard report")
    .option("--path <path>", "Target repository path")
    .option("--output-dir <path>", "Artifact root for report output")
    .option("--max-cost <usd>", "Maximum LLM cost in USD (default: 25.0)")
    .option("--max-runtime-minutes <n>", "Maximum wall-clock runtime (default: 45)")
    .option("--max-parallel <n>", "Max concurrent persona loops (default: 3)")
    .option("--model <id>", "LLM model override (default: gpt-5.3-codex)")
    .option("--provider <name>", "LLM provider: sentinelayer, openai, anthropic")
    .option("--persona <csv>", "Only run these personas (comma-separated IDs)")
    .option("--skip-persona <csv>", "Skip these personas (comma-separated IDs)")
    .option("--stream", "Emit NDJSON events to stdout as personas work file-by-file")
    .option("--notify-email <addr>", "Send final report to this email (default: account email)")
    .option("--notify-session <session-id>", "Stream progress into this Senti session (default: auto-start)")
    .option("--no-email", "Skip email dispatch")
    .option("--no-dashboard", "Skip dashboard card persistence")
    .option("--devtestbot-base-url <url>", "Approved absolute URL for devTestBot browser lanes")
    .option("--devtestbot-scope <scope>", "devTestBot runtime scope (default: orchestrator decides)")
    .option("--no-devtestbot", "Skip the automated devTestBot phase")
    .option("--dry-run", "Validate config + emit plan.json; skip LLM calls")
    .option("--json", "Emit machine-readable final output")
    .action(async (options, command) => {
      const legacyArgs = buildLegacyArgs(["/omargate", "investor-dd"], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });
}
