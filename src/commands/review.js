import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  formatFindingsMarkdown,
  runDeterministicReviewPipeline,
  runLocalReviewScan,
  writeReviewReport,
} from "../review/local-review.js";

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
    .description("Run layered deterministic local review in full, diff, or staged mode")
    .argument("[targetPath]", "Target workspace path", ".")
    .option("--path <path>", "Target workspace path override")
    .option("--diff", "Alias for --mode diff")
    .option("--staged", "Alias for --mode staged")
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
        p0: deterministic.summary.P0,
        p1: deterministic.summary.P1,
        p2: deterministic.summary.P2,
        p3: deterministic.summary.P3,
        blocking: deterministic.summary.blocking,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Deterministic review complete"));
        console.log(pc.gray(`Run: ${deterministic.runId}`));
        console.log(pc.gray(`Mode: ${deterministic.mode}`));
        console.log(pc.gray(`Report: ${deterministic.artifacts.markdownPath}`));
        console.log(pc.gray(`JSON: ${deterministic.artifacts.jsonPath}`));
        console.log(`Files scanned: ${deterministic.scope.scannedFiles}`);
        console.log(
          `Findings: P0=${deterministic.summary.P0} P1=${deterministic.summary.P1} P2=${deterministic.summary.P2} P3=${deterministic.summary.P3}`
        );
      }

      if (deterministic.summary.blocking) {
        if (!emitJson) {
          console.log(pc.red("Blocking findings detected (P0/P1 > 0)."));
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
