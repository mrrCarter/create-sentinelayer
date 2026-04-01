import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  formatFindingsMarkdown,
  runLocalReviewScan,
  writeReviewReport,
} from "../review/local-review.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

export function registerReviewCommand(program) {
  const review = program
    .command("review")
    .description("Run deterministic local reviewer scans in full or git-diff scoped mode");

  review
    .command("scan")
    .description("Scan repository for deterministic policy findings")
    .option("--mode <mode>", "Scan mode: full or diff", "full")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const mode = String(options.mode || "full").trim().toLowerCase();
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
