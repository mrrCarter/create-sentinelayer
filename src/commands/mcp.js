import path from "node:path";
import process from "node:process";

import pc from "picocolors";
import { ZodError } from "zod";

import fs from "node:fs/promises";

import { DEFAULT_REQUEST_TIMEOUT_MS, SentinelayerApiError } from "../auth/http.js";
import {
  buildAidenIdProvisioningAdapterTemplate,
  buildHostedSentiSessionConnectorContract,
  buildAidenIdRegistryTemplate,
  buildMcpToolRegistrySchema,
  buildMcpServerConfigTemplate,
  buildSentinelayerSessionRegistryTemplate,
  buildVsCodeMcpBridgeTemplate,
  readJsonFile,
  resolveDefaultAidenIdAdapterContractPath,
  resolveDefaultHostedSentiSessionConnectorContractPath,
  resolveDefaultMcpOutputPath,
  resolveDefaultMcpServerConfigPath,
  resolveDefaultVsCodeBridgePath,
  validateAidenIdAdapterContract,
  validateHostedSentiSessionConnectorContract,
  stringifyJson,
  validateMcpServerConfig,
  validateMcpToolRegistry,
  writeJsonFile,
} from "../mcp/registry.js";
import { requestHostedMcpAccessToken } from "../mcp/token-service.js";
import { buildSentinelayerCliRegistryTemplate } from "../mcp/cli-registry.js";
import { runMcpStdioServer } from "../mcp/session-stdio-server.js";
import { runMcpDoctorProbes } from "../mcp/doctor.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { resolveOutputRoot } from "../config/service.js";

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

function formatApiError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
  }
  const requestId = error.requestId ? ` request_id=${error.requestId}` : "";
  return `${error.message} [${error.code}] status=${error.status}${requestId}`;
}

export async function resolveMcpDoctorApiBaseUrl({
  explicitApiUrl = "",
  cwd = process.cwd(),
  env = process.env,
  resolveActiveAuthSessionImpl = resolveActiveAuthSession,
} = {}) {
  const directApiUrl = String(explicitApiUrl || "").trim();
  if (directApiUrl) {
    return directApiUrl;
  }

  // Probes are unauthenticated, but the API base URL can live in the CLI auth
  // config. Read it without token rotation so doctor remains side-effect-free.
  try {
    const session = await resolveActiveAuthSessionImpl({
      cwd,
      env,
      autoRotate: false,
    });
    return String((session && session.apiUrl) || "").trim();
  } catch {
    return "";
  }
}

export function registerMcpCommand(program) {
  const mcp = program
    .command("mcp")
    .description("Manage local MCP registries, stdio servers, and guarded CLI bridge metadata")
    .addHelpText(
      "after",
      `
Examples:
  sl mcp list --json
  sl mcp registry init-session --force
  sl mcp server init --id sentinelayer-session --registry-file .sentinelayer/mcp/tool-registry.session-tools.json
  sl mcp server run --path .
  sl mcp registry init-cli --json

Notes:
  Local stdio MCP works for clients that can spawn the CLI process.
  Hosted Claude/ChatGPT connectors require the separate HTTPS/OAuth hosted connector contract.
  Generated CLI bridge tools are metadata only until a bridge host enforces auth, approval, and runtime policy.

Docs: https://github.com/mrrCarter/create-sentinelayer/blob/main/docs/mcp.md`,
    );

  mcp
    .command("list")
    .description("List all known MCP registries, adapters, and server configs in this workspace")
    .option("--path <path>", "Workspace path", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: undefined,
        env: process.env,
      });
      const mcpDir = path.join(outputRoot, "mcp");

      const entries = [];
      try {
        const files = await fs.readdir(mcpDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          try {
            const content = JSON.parse(await fs.readFile(path.join(mcpDir, file), "utf-8"));
            entries.push({
              file,
              path: path.join(mcpDir, file),
              type: content.schemaVersion ? "registry" : content.transport ? "adapter" : content.command ? "server" : "unknown",
              toolCount: Array.isArray(content.tools) ? content.tools.length : 0,
              name: content.name || content.registryName || file,
            });
          } catch {
            entries.push({ file, path: path.join(mcpDir, file), type: "invalid", toolCount: 0, name: file });
          }
        }
      } catch {
        /* mcp directory does not exist — empty listing */
      }

      const result = { command: "mcp list", mcpDir, entries };
      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(pc.bold("MCP Registries & Adapters"));
      console.log(pc.gray(`Directory: ${mcpDir}`));
      if (entries.length === 0) {
        console.log(pc.gray("No MCP artifacts found. Run 'sl mcp schema write' or 'sl mcp registry init-aidenid' to create one."));
        return;
      }
      for (const entry of entries) {
        console.log(`- ${entry.name} [${entry.type}] (${entry.toolCount} tools) — ${entry.path}`);
      }
    });

  const token = mcp.command("token").description("Mint hosted MCP resource tokens");

  token
    .command("mint")
    .description("Mint a short-lived bearer token for the hosted Sentinelayer MCP resource")
    .option(
      "--scope <scopes>",
      "Space- or comma-separated MCP scopes (API default: sessions:read)"
    )
    .option("--ttl-seconds <seconds>", "Token lifetime in seconds (API default and maximum are server-configured)")
    .option("--timeout-ms <ms>", "Sentinelayer API request timeout in milliseconds", String(DEFAULT_REQUEST_TIMEOUT_MS))
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--no-auto-rotate", "Disable stored CLI token rotation before minting")
    .option("--json", "Emit machine-readable output, including the minted access token")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      let result;
      try {
        result = await requestHostedMcpAccessToken({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          autoRotate: options.autoRotate !== false,
          scope: options.scope,
          ttlSeconds: options.ttlSeconds,
          timeoutMs: options.timeoutMs,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "mcp token mint",
        apiUrl: result.apiUrl,
        authSource: result.authSource,
        rotated: result.rotated,
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        expiresIn: result.expiresIn,
        expiresAt: result.expiresAt,
        issuer: result.issuer,
        audience: result.audience,
        scope: result.scope,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.green("Minted hosted MCP bearer credential"));
      console.log(pc.gray(`API: ${payload.apiUrl}`));
      console.log(`Expires in: ${payload.expiresIn}s`);
      if (payload.expiresAt) {
        console.log(`Expires at: ${payload.expiresAt}`);
      }
      console.log(`Issuer: ${payload.issuer}`);
      console.log(`Audience: ${payload.audience}`);
      console.log(`Scope: ${payload.scope}`);
      console.log(pc.gray("Secret value hidden in text output; use --json when you need the bearer value."));
    });

  mcp
    .command("doctor")
    .description(
      "Diagnose hosted MCP auth: probe the OAuth discovery chain (PRM, AS metadata, JWKS) and verify unauthenticated /mcp is rejected"
    )
    .option(
      "--api-url <url>",
      "Sentinelayer API base URL to probe (default: resolved from your CLI auth session)"
    )
    .option("--timeout-ms <ms>", "Per-probe request timeout in milliseconds", String(DEFAULT_REQUEST_TIMEOUT_MS))
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const parsedTimeout = Number(options.timeoutMs);
      const timeoutMs =
        Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_REQUEST_TIMEOUT_MS;

      const apiBaseUrl = await resolveMcpDoctorApiBaseUrl({
        explicitApiUrl: options.apiUrl,
        cwd: process.cwd(),
        env: process.env,
      });
      if (!apiBaseUrl) {
        throw new Error(
          "Could not resolve the Sentinelayer API URL. Pass --api-url <url>, or run `sl auth login` first."
        );
      }

      const result = await runMcpDoctorProbes({ apiBaseUrl, timeoutMs });

      if (emitJson) {
        console.log(JSON.stringify({ command: "mcp doctor", ...result }, null, 2));
      } else {
        console.log(pc.bold(`MCP auth doctor — ${result.apiBaseUrl}`));
        for (const probe of result.probes) {
          const mark =
            probe.verdict === "PASS"
              ? pc.green("PASS")
              : probe.verdict === "WARN"
                ? pc.yellow("WARN")
                : pc.red("FAIL");
          console.log(`  [${mark}] ${probe.label}  (HTTP ${probe.status})`);
          console.log(pc.gray(`         ${probe.url}`));
          if (probe.detail) {
            console.log(pc.gray(`         ${probe.detail}`));
          }
        }
        console.log(
          result.ok
            ? pc.green("All critical MCP auth probes passed.")
            : pc.red("One or more MCP auth probes FAILED — remote agents may not authenticate correctly.")
        );
      }

      if (!result.ok) {
        process.exitCode = 1;
      }
    });

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
    .command("init-aidenid-adapter")
    .description("Write an AIdenID provisioning adapter contract bound to the MCP registry template")
    .option(
      "--registry-file <path>",
      "Registry file path referenced by adapter contract",
      ".sentinelayer/mcp/tool-registry.aidenid-template.json"
    )
    .option("--path <path>", "Destination file path override")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--force", "Overwrite destination file if it already exists")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const defaultPath = await resolveDefaultAidenIdAdapterContractPath({
        cwd: process.cwd(),
        outputDir: options.outputDir,
        env: process.env,
      });
      const outputPath = normalizeOutputPath(options.path, defaultPath);
      const template = buildAidenIdProvisioningAdapterTemplate({
        registryFile: options.registryFile,
      });
      validateAidenIdAdapterContract(template);
      const writtenPath = await writeJsonFile(outputPath, template, { force: Boolean(options.force) });
      const payload = {
        command: "mcp registry init-aidenid-adapter",
        outputPath: writtenPath,
        bindingCount: template.tool_bindings.length,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote AIdenID adapter contract template: ${writtenPath}`));
      console.log(pc.gray("Next: validate with registry cross-check before runtime wiring."));
    });

  registry
    .command("init-session")
    .description("Write the built-in SentinelLayer session MCP tool registry")
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
      const outputPath = normalizeOutputPath(options.path, defaultPath.replace(".schema", ".session-tools"));
      const template = buildSentinelayerSessionRegistryTemplate();
      validateMcpToolRegistry(template);
      const writtenPath = await writeJsonFile(outputPath, template, { force: Boolean(options.force) });
      const payload = {
        command: "mcp registry init-session",
        outputPath: writtenPath,
        toolCount: template.tools.length,
        tools: template.tools.map((tool) => tool.name),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote SentinelLayer session MCP registry template: ${writtenPath}`));
      console.log(pc.gray("Next: run 'sl mcp server init --id sentinelayer-session --registry-file <path>'."));
    });

  registry
    .command("init-hosted-session-connector")
    .description("Write the hosted Senti session MCP connector contract")
    .option(
      "--registry-file <path>",
      "Local session registry file referenced by hosted connector contract",
      ".sentinelayer/mcp/tool-registry.session-tools.json"
    )
    .option("--path <path>", "Destination file path override")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--force", "Overwrite destination file if it already exists")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const defaultPath = await resolveDefaultHostedSentiSessionConnectorContractPath({
        cwd: process.cwd(),
        outputDir: options.outputDir,
        env: process.env,
      });
      const outputPath = normalizeOutputPath(options.path, defaultPath);
      const template = buildHostedSentiSessionConnectorContract({
        localRegistryFile: options.registryFile,
      });
      validateHostedSentiSessionConnectorContract(template);
      const writtenPath = await writeJsonFile(outputPath, template, { force: Boolean(options.force) });
      const payload = {
        command: "mcp registry init-hosted-session-connector",
        outputPath: writtenPath,
        localRegistryFile: template.local_registry_file,
        toolCount: template.tools.length,
        tools: template.tools.map((tool) => tool.tool_name),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote hosted Senti session connector contract: ${writtenPath}`));
      console.log(pc.gray("This is a hosted connector contract, not a local stdio runtime claim."));
    });

  registry
    .command("init-cli")
    .description("Write guarded sl.* CLI bridge metadata for bridge-capable MCP hosts")
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
      const outputPath = normalizeOutputPath(options.path, defaultPath.replace(".schema", ".cli-tools"));
      const template = await buildSentinelayerCliRegistryTemplate();
      validateMcpToolRegistry(template);
      const writtenPath = await writeJsonFile(outputPath, template, { force: Boolean(options.force) });
      const payload = {
        command: "mcp registry init-cli",
        outputPath: writtenPath,
        toolCount: template.tools.length,
        tools: template.tools.map((tool) => tool.name),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Wrote SentinelLayer CLI MCP registry template: ${writtenPath}`));
      console.log(pc.gray(`${template.tools.length} CLI leaf commands exposed as bridge tools.`));
      console.log(pc.gray("Execution requires a bridge-capable MCP host with auth, approval, and runtime policy."));
      console.log(pc.gray("Sensitive token, export, and identity-mutation commands are runtime-blocked."));
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

  registry
    .command("validate-hosted-session-connector")
    .description("Validate a hosted Senti session MCP connector contract")
    .requiredOption("--file <path>", "Hosted connector contract JSON file to validate")
    .option("--registry-file <path>", "Optional local session registry JSON file for cross-check")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const inputPath = path.resolve(process.cwd(), String(options.file || "").trim());
      const loaded = await readJsonFile(inputPath);
      const registryFile = String(options.registryFile || "").trim();
      const loadedRegistry = registryFile
        ? await readJsonFile(path.resolve(process.cwd(), registryFile))
        : null;

      let parsed;
      try {
        parsed = validateHostedSentiSessionConnectorContract(loaded.data, {
          registryPayload: loadedRegistry ? loadedRegistry.data : undefined,
        });
      } catch (error) {
        const payload = {
          command: "mcp registry validate-hosted-session-connector",
          valid: false,
          filePath: loaded.path,
          registryFilePath: loadedRegistry ? loadedRegistry.path : null,
          error: zodIssueSummary(error),
        };
        if (shouldEmitJson(options, command)) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(pc.red(`Hosted Senti session connector contract invalid: ${payload.error}`));
          console.log(pc.gray(`File: ${loaded.path}`));
          if (payload.registryFilePath) {
            console.log(pc.gray(`Registry: ${payload.registryFilePath}`));
          }
        }
        process.exitCode = 2;
        return;
      }

      const payload = {
        command: "mcp registry validate-hosted-session-connector",
        valid: true,
        filePath: loaded.path,
        registryFilePath: loadedRegistry ? loadedRegistry.path : null,
        connector: parsed.connector,
        toolCount: parsed.tools.length,
        releaseGateCount: parsed.release_gates.length,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`Hosted Senti session connector contract valid (${parsed.tools.length} tools)`));
      console.log(pc.gray(`File: ${loaded.path}`));
      if (payload.registryFilePath) {
        console.log(pc.gray(`Registry: ${payload.registryFilePath}`));
      }
    });

  registry
    .command("validate-aidenid-adapter")
    .description(
      "Validate an AIdenID adapter contract and optionally cross-check tool bindings against an MCP registry file"
    )
    .requiredOption("--file <path>", "AIdenID adapter contract JSON file to validate")
    .option("--registry-file <path>", "Optional MCP registry JSON file for tool binding cross-check")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const inputPath = path.resolve(process.cwd(), String(options.file || "").trim());
      const loaded = await readJsonFile(inputPath);
      const registryFile = String(options.registryFile || "").trim();
      const loadedRegistry = registryFile
        ? await readJsonFile(path.resolve(process.cwd(), registryFile))
        : null;

      let parsed;
      try {
        parsed = validateAidenIdAdapterContract(loaded.data, {
          registryPayload: loadedRegistry ? loadedRegistry.data : undefined,
        });
      } catch (error) {
        const payload = {
          command: "mcp registry validate-aidenid-adapter",
          valid: false,
          filePath: loaded.path,
          registryFilePath: loadedRegistry ? loadedRegistry.path : null,
          error: zodIssueSummary(error),
        };
        if (shouldEmitJson(options, command)) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(pc.red(`AIdenID adapter contract invalid: ${payload.error}`));
          console.log(pc.gray(`File: ${loaded.path}`));
          if (payload.registryFilePath) {
            console.log(pc.gray(`Registry: ${payload.registryFilePath}`));
          }
        }
        process.exitCode = 2;
        return;
      }

      const payload = {
        command: "mcp registry validate-aidenid-adapter",
        valid: true,
        filePath: loaded.path,
        registryFilePath: loadedRegistry ? loadedRegistry.path : null,
        provider: parsed.provider,
        bindingCount: parsed.tool_bindings.length,
        tools: parsed.tool_bindings.map((binding) => binding.tool_name),
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.green(`AIdenID adapter contract valid (${parsed.tool_bindings.length} bindings)`));
      console.log(pc.gray(`File: ${loaded.path}`));
      if (payload.registryFilePath) {
        console.log(pc.gray(`Registry cross-check: ${payload.registryFilePath}`));
      }
      for (const toolName of payload.tools) {
        console.log(`- ${toolName}`);
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

  server
    .command("run")
    .description("Run the SentinelLayer MCP stdio server")
    .option("--config <path>", "MCP server config JSON to validate before startup")
    .option("--path <path>", "Workspace path used for session auth and local caches", ".")
    .option("--framing <mode>", "stdio framing: newline or content-length", "newline")
    .action(async (options) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const configPath = String(options.config || "").trim();
      if (configPath) {
        const loaded = await readJsonFile(path.resolve(process.cwd(), configPath));
        const parsed = validateMcpServerConfig(loaded.data);
        if (parsed.transport.mode !== "stdio") {
          throw new Error("mcp server run requires a stdio server config.");
        }
      }
      const framing = String(options.framing || "newline").trim().toLowerCase();
      if (!["newline", "content-length"].includes(framing)) {
        throw new Error("framing must be 'newline' or 'content-length'.");
      }
      await runMcpStdioServer({
        targetPath,
        framing,
      });
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
