import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import pc from "picocolors";

import {
  createMultiProviderApiClient,
  resolveApiKey,
  resolveModel,
  resolveProvider,
} from "../ai/client.js";
import { enrichGuideTickets } from "../guide/enrich.js";
import {
  defaultGuideExportFileName,
  generateBuildGuide,
  renderGuideExport,
  SUPPORTED_GUIDE_EXPORT_FORMATS,
} from "../guide/generator.js";
import { renderTerminalMarkdown } from "../ui/markdown.js";

// Optionally split each phase into per-PR tickets with an LLM. Best-effort:
// any failure leaves the deterministic tickets untouched. Returns the number
// of phases enriched (0 when disabled or unavailable).
async function maybeEnrichGuide(guideDoc, options) {
  if (!options || !options.enrich) return 0;
  try {
    const provider = resolveProvider({ provider: options.provider });
    const model = resolveModel({ provider, model: options.model });
    const apiKey = resolveApiKey({ provider, explicitApiKey: options.apiKey });
    if (!apiKey) {
      console.error(
        pc.yellow(`! --enrich skipped: no API key for provider '${provider}'. Set the provider key or pass --api-key.`)
      );
      return 0;
    }
    const limits = {};
    if (options.maxPhases) limits.maxPhases = Number(options.maxPhases);
    if (options.maxPrsPerPhase) limits.maxTicketsPerPhase = Number(options.maxPrsPerPhase);
    const { tickets, enrichedPhases } = await enrichGuideTickets({
      guide: guideDoc,
      client: createMultiProviderApiClient(),
      provider,
      model,
      apiKey,
      limits,
    });
    if (enrichedPhases > 0) guideDoc.tickets = tickets;
    return enrichedPhases;
  } catch (error) {
    console.error(pc.yellow(`! --enrich failed, using deterministic tickets: ${error?.message || error}`));
    return 0;
  }
}

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

function resolveExportFormat(rawFormat) {
  const normalized = String(rawFormat || "").trim().toLowerCase();
  if (!SUPPORTED_GUIDE_EXPORT_FORMATS.includes(normalized)) {
    throw new Error(
      `Unsupported export format '${rawFormat}'. Use one of: ${SUPPORTED_GUIDE_EXPORT_FORMATS.join(", ")}`
    );
  }
  return normalized;
}

export function registerGuideCommand(program) {
  const guide = program.command("guide").description("Generate and export phase-by-phase build guides");

  guide
    .command("generate")
    .description("Generate BUILD_GUIDE.md from SPEC content")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option("--output-file <path>", "Output guide path relative to --path", "BUILD_GUIDE.md")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputPath = path.resolve(targetPath, String(options.outputFile || "BUILD_GUIDE.md").trim());
      const specPath = resolveSpecPath(targetPath, options.specFile);
      const specMarkdown = await fsp.readFile(specPath, "utf-8");

      const guideDoc = generateBuildGuide({
        specMarkdown,
        projectPath: targetPath,
        specPath,
      });

      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, `${guideDoc.markdown.trimEnd()}\n`, "utf-8");

      const payload = {
        command: "guide generate",
        targetPath,
        specPath,
        outputPath,
        phases: guideDoc.phases.map((phase) => ({
          title: phase.title,
          effort: phase.effort.label,
          dependencies: phase.dependencies,
        })),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Build guide generated"));
      console.log(pc.gray(`Spec: ${specPath}`));
      console.log(pc.gray(`Output: ${outputPath}`));
      console.log(pc.gray(`Phases: ${guideDoc.phases.length}`));
    });

  guide
    .command("export")
    .description("Export build-guide phases into issue tracker-friendly format")
    .requiredOption(
      "--format <type>",
      `Export format (${SUPPORTED_GUIDE_EXPORT_FORMATS.join("|")})`
    )
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option("--output-file <path>", "Output export file path relative to --path")
    .option("--enrich", "Split each phase into per-PR tickets with an LLM (opt-in, capped)")
    .option("--provider <provider>", "LLM provider for --enrich (openai|anthropic|google)")
    .option("--model <model>", "LLM model for --enrich")
    .option("--api-key <key>", "Explicit API key for --enrich (else from env)")
    .option("--max-phases <n>", "Cap how many phases --enrich expands")
    .option("--max-prs-per-phase <n>", "Cap PRs per phase for --enrich")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const format = resolveExportFormat(options.format);
      const outputName =
        String(options.outputFile || "").trim() || defaultGuideExportFileName(format);
      const outputPath = path.resolve(targetPath, outputName);
      const specPath = resolveSpecPath(targetPath, options.specFile);
      const specMarkdown = await fsp.readFile(specPath, "utf-8");

      const guideDoc = generateBuildGuide({
        specMarkdown,
        projectPath: targetPath,
        specPath,
      });
      const enrichedPhases = await maybeEnrichGuide(guideDoc, options);
      const exportBody = renderGuideExport({ format, guide: guideDoc });

      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.writeFile(outputPath, `${exportBody.trimEnd()}\n`, "utf-8");

      const payload = {
        command: "guide export",
        format,
        targetPath,
        specPath,
        outputPath,
        issueCount: guideDoc.tickets.length,
        enrichedPhases,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Build guide export generated"));
      console.log(pc.gray(`Format: ${format}`));
      console.log(pc.gray(`Output: ${outputPath}`));
      console.log(pc.gray(`Issues: ${guideDoc.tickets.length}`));
      if (enrichedPhases > 0) {
        console.log(pc.gray(`LLM-enriched phases: ${enrichedPhases}`));
      }
    });

  guide
    .command("show")
    .description("Render an existing BUILD_GUIDE artifact in terminal markdown")
    .option("--path <path>", "Target workspace path", ".")
    .option("--file <path>", "Guide file path relative to --path", "BUILD_GUIDE.md")
    .option("--plain", "Disable terminal markdown styling")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const guidePath = path.resolve(targetPath, String(options.file || "BUILD_GUIDE.md").trim());
      if (!fs.existsSync(guidePath)) {
        throw new Error(`Guide artifact not found: ${guidePath}`);
      }

      const markdown = await fsp.readFile(guidePath, "utf-8");
      const payload = {
        command: "guide show",
        guidePath,
        lineCount: markdown.split(/\r?\n/).length,
        preview: markdown,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(renderTerminalMarkdown(markdown, { plain: Boolean(options.plain) }));
    });
}

