import fsp from "node:fs/promises";
import path from "node:path";

import pc from "picocolors";

import { collectCodebaseIngest } from "../ingest/engine.js";
import { generateSpecMarkdown, resolveSpecTemplate } from "../spec/generator.js";
import { SPEC_TEMPLATES } from "../spec/templates.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

export function registerSpecCommand(program) {
  const spec = program
    .command("spec")
    .description("Offline spec generation and template management");

  spec
    .command("list-templates")
    .description("List built-in spec templates")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify({ templates: SPEC_TEMPLATES }, null, 2));
        return;
      }

      console.log(pc.bold("Available templates"));
      for (const template of SPEC_TEMPLATES) {
        console.log(`- ${template.id}: ${template.name} - ${template.description}`);
      }
    });

  spec
    .command("show-template <templateId>")
    .description("Show details for one template")
    .option("--json", "Emit machine-readable output")
    .action(async (templateId, options, command) => {
      const template = resolveSpecTemplate(templateId);
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify({ template }, null, 2));
        return;
      }

      console.log(pc.bold(`${template.name} (${template.id})`));
      console.log(template.description);
      console.log("\nArchitecture focus:");
      template.architectureFocus.forEach((item, index) => console.log(`${index + 1}. ${item}`));
      console.log("\nSecurity checklist:");
      template.securityChecklist.forEach((item, index) => console.log(`${index + 1}. ${item}`));
    });

  spec
    .command("generate")
    .description("Generate SPEC.md from ingest + selected template")
    .option("--path <path>", "Target workspace path", ".")
    .option("--template <templateId>", "Template id (see spec list-templates)", "api-service")
    .option("--description <text>", "Optional primary goal override")
    .option("--output-file <path>", "Output file path relative to --path", "SPEC.md")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputFile = String(options.outputFile || "SPEC.md").trim() || "SPEC.md";
      const outputPath = path.resolve(targetPath, outputFile);

      const template = resolveSpecTemplate(options.template);
      const ingest = await collectCodebaseIngest({ rootPath: targetPath });
      const markdown = generateSpecMarkdown({
        template,
        description: options.description,
        ingest,
        projectPath: targetPath,
      });

      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, `${markdown.trimEnd()}\n`, "utf-8");

      if (shouldEmitJson(options, command)) {
        console.log(
          JSON.stringify(
            {
              command: "spec generate",
              template: template.id,
              targetPath,
              outputPath,
              summary: ingest.summary,
              frameworks: ingest.frameworks,
              riskSurfaces: ingest.riskSurfaces,
            },
            null,
            2
          )
        );
        return;
      }

      console.log(pc.bold("Spec generated"));
      console.log(pc.gray(`Template: ${template.id}`));
      console.log(pc.gray(`Output: ${outputPath}`));
    });
}
