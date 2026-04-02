import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  formatFindingsMarkdown,
  runDeterministicReviewPipeline,
  runLocalReviewScan,
  writeReviewReport,
} from "../review/local-review.js";
import { runAiReviewLayer } from "../review/ai-review.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function resolveModeFromOptions(options = {}, { defaultMode = "full" } = {}) {
  const explicitMode = String(options.mode || "").trim().toLowerCase();
  const diffFlag = Boolean(options.diff);
  const stagedFlag = Boolean(options.staged);

  if (diffFlag && stagedFlag) {
    throw new Error("Use only one of --diff or --staged.");
  }

  let modeFromFlags = "";
  if (diffFlag) {
    modeFromFlags = "diff";
  } else if (stagedFlag) {
    modeFromFlags = "staged";
  }

  if (explicitMode && modeFromFlags && explicitMode !== modeFromFlags) {
    throw new Error(`Conflicting mode selection: --mode ${explicitMode} with --${modeFromFlags}.`);
  }

  if (explicitMode) {
    return explicitMode;
  }
  if (modeFromFlags) {
    return modeFromFlags;
  }
  return defaultMode;
}

export function registerReviewCommand(program) {
  const review = program
    .command("review")
    .description("Run deterministic local review with optional AI reasoning layer")
    .argument("[targetPath]", "Target workspace path", ".")
    .option("--path <path>", "Target workspace path override")
    .option("--diff", "Alias for --mode diff")
    .option("--staged", "Alias for --mode staged")
    .option("--ai", "Enable AI reasoning layer over deterministic findings")
    .option("--ai-dry-run", "Run AI layer in dry-run mode (no provider call)")
    .option("--provider <name>", "AI provider override (openai|anthropic|google)")
    .option("--model <id>", "AI model override")
    .option("--api-key <key>", "Optional explicit API key override")
    .option("--session-id <id>", "AI cost/telemetry session id override")
    .option("--ai-max-findings <n>", "Max number of structured AI findings", "20")
    .option("--max-cost <usd>", "Max AI cost budget for this review session", "1.0")
    .option("--max-tokens <n>", "Max AI output token budget (0 disables)", "0")
    .option("--max-runtime-ms <n>", "Max AI runtime budget in ms (0 disables)", "0")
    .option("--max-tool-calls <n>", "Max AI tool-call budget (0 disables)", "0")
    .option("--max-no-progress <n>", "Max no-progress streak before stop", "3")
    .option("--warn-at-percent <n>", "Warning threshold percentage for enabled budgets", "80")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (targetPathArg, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(
        process.cwd(),
        String(options.path || targetPathArg || ".")
      );
      const mode = resolveModeFromOptions(options, {
        defaultMode: "full",
      });

      const deterministic = await runDeterministicReviewPipeline({
        targetPath,
        mode,
        outputDir: options.outputDir,
      });

      let aiLayer = null;
      if (options.ai) {
        aiLayer = await runAiReviewLayer({
          targetPath: deterministic.targetPath,
          mode: deterministic.mode,
          runId: deterministic.runId,
          runDirectory: deterministic.artifacts.runDirectory,
          deterministic,
          outputDir: options.outputDir,
          provider: options.provider,
          model: options.model,
          apiKey: options.apiKey,
          sessionId: options.sessionId,
          maxFindings: options.aiMaxFindings,
          maxCostUsd: options.maxCost,
          maxOutputTokens: options.maxTokens,
          maxRuntimeMs: options.maxRuntimeMs,
          maxToolCalls: options.maxToolCalls,
          maxNoProgress: options.maxNoProgress,
          warningThresholdPercent: options.warnAtPercent,
          dryRun: Boolean(options.aiDryRun),
          env: process.env,
        });
      }

      const summary = aiLayer ? aiLayer.combinedSummary : deterministic.summary;
      const blocking = Boolean(summary.blocking) || Boolean(aiLayer?.budget?.blocking);

      const payload = {
        command: "review",
        targetPath: deterministic.targetPath,
        mode: deterministic.mode,
        runId: deterministic.runId,
        runDirectory: deterministic.artifacts.runDirectory,
        reportPath: deterministic.artifacts.markdownPath,
        reportJsonPath: deterministic.artifacts.jsonPath,
        scannedFiles: deterministic.scope.scannedFiles,
        scopedFiles: deterministic.scope.scannedRelativeFiles,
        p0: summary.P0,
        p1: summary.P1,
        p2: summary.P2,
        p3: summary.P3,
        blocking,
        deterministicSummary: deterministic.summary,
        ai: aiLayer
          ? {
              enabled: true,
              dryRun: aiLayer.dryRun,
              parser: aiLayer.parser,
              summary: aiLayer.summary,
              provider: aiLayer.provider,
              model: aiLayer.model,
              findingCount: aiLayer.findings.length,
              reportPath: aiLayer.artifacts.reportMarkdownPath,
              reportJsonPath: aiLayer.artifacts.reportJsonPath,
              promptPath: aiLayer.artifacts.promptPath,
              usage: aiLayer.usage,
              pricingFound: aiLayer.pricingFound,
              budget: aiLayer.budget,
              cost: aiLayer.cost,
              telemetry: aiLayer.telemetry,
            }
          : {
              enabled: false,
            },
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Deterministic review complete"));
        console.log(pc.gray(`Run: ${deterministic.runId}`));
        console.log(pc.gray(`Mode: ${deterministic.mode}`));
        console.log(pc.gray(`Report: ${deterministic.artifacts.markdownPath}`));
        console.log(pc.gray(`JSON: ${deterministic.artifacts.jsonPath}`));
        if (aiLayer) {
          console.log(
            pc.gray(
              `AI: ${aiLayer.provider}/${aiLayer.model} findings=${aiLayer.findings.length} dry_run=${aiLayer.dryRun ? "yes" : "no"}`
            )
          );
          console.log(pc.gray(`AI report: ${aiLayer.artifacts.reportMarkdownPath}`));
        }
        console.log(`Files scanned: ${deterministic.scope.scannedFiles}`);
        console.log(
          `Findings: P0=${summary.P0} P1=${summary.P1} P2=${summary.P2} P3=${summary.P3}`
        );
      }

      if (blocking) {
        if (!emitJson) {
          console.log(pc.red("Blocking findings detected (P0/P1 > 0 or budget stop)."));
        }
        process.exitCode = 2;
      }
    });

  review
    .command("scan")
    .description("Compatibility mode: run lightweight policy scan")
    .option("--mode <mode>", "Scan mode: full, diff, or staged", "full")
    .option("--diff", "Alias for --mode diff")
    .option("--staged", "Alias for --mode staged")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const mode = resolveModeFromOptions(options, {
        defaultMode: String(options.mode || "full").trim().toLowerCase() || "full",
      });
      const scan = await runLocalReviewScan({
        targetPath,
        mode,
      });

      const report = `# Local Review Scan

Generated: ${new Date().toISOString()}
Target: ${scan.targetPath}
Mode: ${scan.mode}

Summary:
- Files scanned: ${scan.scannedFiles}
- P1 findings: ${scan.p1}
- P2 findings: ${scan.p2}

Scoped files:
${scan.scannedRelativeFiles.length > 0 ? scan.scannedRelativeFiles.map((item) => `- ${item}`).join("\n") : "- none"}

Findings:
${formatFindingsMarkdown(scan.findings)}
`;

      const reportPath = await writeReviewReport({
        targetPath: scan.targetPath,
        mode: scan.mode,
        outputDir: options.outputDir,
        reportMarkdown: report,
      });

      const payload = {
        command: "review scan",
        targetPath: scan.targetPath,
        mode: scan.mode,
        reportPath,
        scannedFiles: scan.scannedFiles,
        scopedFiles: scan.scannedRelativeFiles,
        p1: scan.p1,
        p2: scan.p2,
        blocking: scan.p1 > 0,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Local review scan complete"));
        console.log(pc.gray(`Mode: ${scan.mode}`));
        console.log(pc.gray(`Report: ${reportPath}`));
        console.log(`Files scanned: ${scan.scannedFiles}`);
        console.log(`P1 findings: ${scan.p1}`);
        console.log(`P2 findings: ${scan.p2}`);
      }

      if (scan.p1 > 0) {
        if (!emitJson) {
          console.log(pc.red("Blocking findings detected (P1 > 0)."));
        }
        process.exitCode = 2;
      }
    });
}
