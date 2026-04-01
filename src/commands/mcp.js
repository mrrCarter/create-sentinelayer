import path from "node:path";
import process from "node:process";

import pc from "picocolors";
import { ZodError } from "zod";

import {
  buildAidenIdRegistryTemplate,
  buildMcpToolRegistrySchema,
  readJsonFile,
  resolveDefaultMcpOutputPath,
  stringifyJson,
  validateMcpToolRegistry,
  writeJsonFile,
} from "../mcp/registry.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function normalizeOutputPath(rawValue, fallbackPath) {
  const candidate = String(rawValue || "").trim();
  if (!candidate) {
    return fallbackPath;
  }
  return path.resolve(process.cwd(), candidate);
}

function zodIssueSummary(error) {
  if (!(error instanceof ZodError)) {
    return String(error instanceof Error ? error.message : error);
  }
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

export function registerMcpCommand(program) {
  const mcp = program.command("mcp").description("Manage Sentinelayer MCP registry schemas and adapters");

  const schema = mcp.command("schema").description("Inspect or materialize MCP tool-registry schema");
  schema
    .command("show")
    .description("Print the canonical MCP tool registry JSON schema")
    .option("--json", "Emit machine-readable output")
    .action((options, command) => {
      const schemaPayload = buildMcpToolRegistrySchema();
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify({ command: "mcp schema show", schema: schemaPayload }, null, 2));
        return;
      }
      console.log(stringifyJson(schemaPayload));
    });

  schema
    .command("write")
    .description("Write the canonical MCP tool registry JSON schema to disk")
    .option("--path <path>", "Destination file path override")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--force", "Overwrite destination file if it already exists")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const defaultPath = await resolveDefaultMcpOutputPath({
        cwd: process.cwd(),
        outputDir: options.outputDir,
        env: process.env,
      });
      const outputPath = normalizeOutputPath(options.path, defaultPath);
      const schemaPayload = buildMcpToolRegistrySchema();
      const writtenPath = await writeJsonFile(outputPath, schemaPayload, { force: Boolean(options.force) });

      const payload = {
        command: "mcp schema write",
        outputPath: writtenPath,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote MCP schema: ${writtenPath}`));
    });

  const registry = mcp.command("registry").description("Manage MCP tool registry payloads");

  registry
    .command("init-aidenid")
    .description("Write an AIdenID provisioning adapter template registry")
    .option("--path <path>", "Destination file path override")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--force", "Overwrite destination file if it already exists")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const defaultPath = await resolveDefaultMcpOutputPath({
        cwd: process.cwd(),
        outputDir: options.outputDir,
        env: process.env,
      });
      const outputPath = normalizeOutputPath(options.path, defaultPath.replace(".schema", ".aidenid-template"));
      const template = buildAidenIdRegistryTemplate();
      validateMcpToolRegistry(template);
      const writtenPath = await writeJsonFile(outputPath, template, { force: Boolean(options.force) });
      const payload = {
        command: "mcp registry init-aidenid",
        outputPath: writtenPath,
        toolCount: template.tools.length,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote AIdenID MCP registry template: ${writtenPath}`));
      console.log(pc.gray("Next: customize transport.url/auth and validate before runtime use."));
    });

  registry
    .command("validate")
    .description("Validate an MCP tool registry JSON payload against Sentinelayer contract")
    .requiredOption("--file <path>", "Registry JSON file to validate")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const inputPath = path.resolve(process.cwd(), String(options.file || "").trim());
      const loaded = await readJsonFile(inputPath);
      let toolNames = [];
      try {
        const parsed = validateMcpToolRegistry(loaded.data);
        toolNames = parsed.tools.map((tool) => tool.name);
      } catch (error) {
        const payload = {
          command: "mcp registry validate",
          valid: false,
          filePath: loaded.path,
          error: zodIssueSummary(error),
        };
        if (shouldEmitJson(options, command)) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(pc.red(`Registry invalid: ${payload.error}`));
          console.log(pc.gray(`File: ${loaded.path}`));
        }
        process.exitCode = 2;
        return;
      }

      const payload = {
        command: "mcp registry validate",
        valid: true,
        filePath: loaded.path,
        toolCount: toolNames.length,
        tools: toolNames,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Registry valid (${toolNames.length} tools)`));
      console.log(pc.gray(`File: ${loaded.path}`));
      for (const name of toolNames) {
        console.log(`- ${name}`);
      }
    });
}
