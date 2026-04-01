import path from "node:path";
import process from "node:process";

import pc from "picocolors";
import { ZodError } from "zod";

import {
  buildAidenIdRegistryTemplate,
  buildMcpToolRegistrySchema,
  buildMcpServerConfigTemplate,
  buildVsCodeMcpBridgeTemplate,
  readJsonFile,
  resolveDefaultMcpOutputPath,
  resolveDefaultMcpServerConfigPath,
  resolveDefaultVsCodeBridgePath,
  stringifyJson,
  validateMcpServerConfig,
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

  const server = mcp.command("server").description("Manage MCP server runtime configuration");

  server
    .command("init")
    .description("Write a deterministic MCP server configuration scaffold")
    .requiredOption("--id <server-id>", "Server id (lowercase)")
    .option(
      "--registry-file <path>",
      "Registry file path referenced by server config",
      ".sentinelayer/mcp/tool-registry.aidenid-template.json"
    )
    .option("--path <path>", "Destination file path override")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--force", "Overwrite destination file if it already exists")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const serverId = String(options.id || "")
        .trim()
        .toLowerCase();
      const defaultPath = await resolveDefaultMcpServerConfigPath({
        cwd: process.cwd(),
        outputDir: options.outputDir,
        env: process.env,
        serverId,
      });
      const outputPath = normalizeOutputPath(options.path, defaultPath);
      const template = buildMcpServerConfigTemplate({
        serverId,
        registryFile: options.registryFile,
      });
      const config = validateMcpServerConfig(template);
      const writtenPath = await writeJsonFile(outputPath, config, { force: Boolean(options.force) });

      const payload = {
        command: "mcp server init",
        serverId: config.server_id,
        outputPath: writtenPath,
        registryFile: config.registry_file,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote MCP server config: ${writtenPath}`));
      console.log(pc.gray(`server_id: ${config.server_id}`));
    });

  server
    .command("validate")
    .description("Validate an MCP server config payload")
    .requiredOption("--file <path>", "Server config JSON to validate")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const inputPath = path.resolve(process.cwd(), String(options.file || "").trim());
      const loaded = await readJsonFile(inputPath);
      let parsed;
      try {
        parsed = validateMcpServerConfig(loaded.data);
      } catch (error) {
        const payload = {
          command: "mcp server validate",
          valid: false,
          filePath: loaded.path,
          error: zodIssueSummary(error),
        };
        if (shouldEmitJson(options, command)) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(pc.red(`Server config invalid: ${payload.error}`));
          console.log(pc.gray(`File: ${loaded.path}`));
        }
        process.exitCode = 2;
        return;
      }

      const payload = {
        command: "mcp server validate",
        valid: true,
        filePath: loaded.path,
        serverId: parsed.server_id,
        transportMode: parsed.transport.mode,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Server config valid (${parsed.server_id})`));
      console.log(pc.gray(`File: ${loaded.path}`));
    });

  const bridge = mcp.command("bridge").description("Generate MCP bridge configuration wrappers");

  bridge
    .command("init-vscode")
    .description("Write a VS Code MCP bridge config bound to a server config file")
    .requiredOption("--server-id <server-id>", "Server id to register")
    .requiredOption("--server-config <path>", "Path to MCP server config file")
    .option("--path <path>", "Destination VS Code config path override")
    .option("--force", "Overwrite destination file if it already exists")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const serverId = String(options.serverId || "")
        .trim()
        .toLowerCase();
      const outputPath = normalizeOutputPath(
        options.path,
        resolveDefaultVsCodeBridgePath({ cwd: process.cwd() })
      );
      const bridgePayload = buildVsCodeMcpBridgeTemplate({
        serverId,
        serverConfigFile: String(options.serverConfig || "").trim(),
      });
      const writtenPath = await writeJsonFile(outputPath, bridgePayload, { force: Boolean(options.force) });

      const payload = {
        command: "mcp bridge init-vscode",
        serverId,
        serverConfig: String(options.serverConfig || "").trim(),
        outputPath: writtenPath,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote VS Code MCP bridge config: ${writtenPath}`));
    });
}
