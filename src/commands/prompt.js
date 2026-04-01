import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import pc from "picocolors";

import {
  defaultPromptFileName,
  generateExecutionPrompt,
  resolvePromptTarget,
  SUPPORTED_PROMPT_TARGETS,
} from "../prompt/generator.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function resolveSpecPath(targetPath, explicitSpecFile) {
  const explicit = String(explicitSpecFile || "").trim();
  if (explicit) {
    return path.resolve(targetPath, explicit);
  }

  const candidates = [path.join(targetPath, "SPEC.md"), path.join(targetPath, "docs", "spec.md")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("No spec file found. Provide --spec-file or generate SPEC.md first.");
  }
  return found;
}

async function buildPromptOutput({ targetPath, specFile, agent, outputFile }) {
  const resolvedSpecPath = resolveSpecPath(targetPath, specFile);
  const specMarkdown = await fsp.readFile(resolvedSpecPath, "utf-8");
  const resolvedAgent = resolvePromptTarget(agent);
  const promptMarkdown = generateExecutionPrompt({
    specMarkdown,
    target: resolvedAgent,
    projectPath: targetPath,
  });

  const outputName = String(outputFile || "").trim() || defaultPromptFileName(resolvedAgent);
  const outputPath = path.resolve(targetPath, outputName);

  return {
    agent: resolvedAgent,
    specPath: resolvedSpecPath,
    promptMarkdown,
    outputPath,
  };
}

export function registerPromptCommand(program) {
  const prompt = program
    .command("prompt")
    .description("Generate agent execution prompts from SPEC content");

  prompt
    .command("generate")
    .description("Generate prompt markdown file from spec")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option("--agent <target>", `Prompt target (${SUPPORTED_PROMPT_TARGETS.join("|")})`, "generic")
    .option("--output-file <path>", "Output prompt file path relative to --path")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const result = await buildPromptOutput({
        targetPath,
        specFile: options.specFile,
        agent: options.agent,
        outputFile: options.outputFile,
      });

      await fsp.mkdir(path.dirname(result.outputPath), { recursive: true });
      await fsp.writeFile(result.outputPath, `${result.promptMarkdown.trimEnd()}\n`, "utf-8");

      if (shouldEmitJson(options, command)) {
        console.log(
          JSON.stringify(
            {
              command: "prompt generate",
              agent: result.agent,
              specPath: result.specPath,
              outputPath: result.outputPath,
            },
            null,
            2
          )
        );
        return;
      }

      console.log(pc.bold("Prompt generated"));
      console.log(pc.gray(`Agent: ${result.agent}`));
      console.log(pc.gray(`Spec: ${result.specPath}`));
      console.log(pc.gray(`Output: ${result.outputPath}`));
    });

  prompt
    .command("preview")
    .description("Render generated prompt in terminal without writing file")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option("--agent <target>", `Prompt target (${SUPPORTED_PROMPT_TARGETS.join("|")})`, "generic")
    .option("--max-lines <n>", "Maximum lines to print (0 = unlimited)", "0")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const result = await buildPromptOutput({
        targetPath,
        specFile: options.specFile,
        agent: options.agent,
      });

      const maxLines = Number.parseInt(String(options.maxLines || "0"), 10);
      const lines = result.promptMarkdown.split(/\r?\n/);
      const outputLines = Number.isFinite(maxLines) && maxLines > 0 ? lines.slice(0, maxLines) : lines;

      if (shouldEmitJson(options, command)) {
        console.log(
          JSON.stringify(
            {
              command: "prompt preview",
              agent: result.agent,
              specPath: result.specPath,
              lineCount: outputLines.length,
              preview: outputLines.join("\n"),
            },
            null,
            2
          )
        );
        return;
      }

      console.log(outputLines.join("\n"));
    });
}
