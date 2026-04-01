import path from "node:path";

import pc from "picocolors";

import { formatIngestSummary, generateCodebaseIngest } from "../ingest/engine.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

export function registerIngestCommand(program) {
  const ingest = program
    .command("ingest")
    .description("Run deterministic codebase ingest and mapping");

  ingest
    .command("map")
    .description("Generate CODEBASE_INGEST.json with stack/risk hints")
    .option("--path <path>", "Target repository path", ".")
    .option("--output-file <path>", "Explicit output file path relative to --path")
    .option("--output-dir <path>", "Artifact root used when output file is not provided")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const result = await generateCodebaseIngest({
        rootPath: targetPath,
        outputFile: options.outputFile,
        outputDir: options.outputDir,
      });

      const emitJson = shouldEmitJson(options, command);
      if (emitJson) {
        console.log(
          JSON.stringify(
            {
              command: "ingest map",
              targetPath,
              outputPath: result.outputPath,
              summary: result.ingest.summary,
              frameworks: result.ingest.frameworks,
              entryPoints: result.ingest.entryPoints,
              riskSurfaces: result.ingest.riskSurfaces,
            },
            null,
            2
          )
        );
        return;
      }

      console.log(pc.bold("Codebase ingest completed"));
      console.log(pc.gray(`Output: ${result.outputPath}`));
      console.log(formatIngestSummary(result.ingest));
    });
}
