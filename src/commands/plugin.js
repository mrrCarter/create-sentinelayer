import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  buildPluginManifestTemplate,
  computePluginLoadOrder,
  listPluginManifests,
  normalizePluginId,
  normalizePluginLoadStage,
  normalizePluginPackType,
  PLUGIN_LOAD_STAGES,
  PLUGIN_PACK_TYPES,
  readJsonFile,
  resolveDefaultPluginManifestPath,
  summarizePluginValidationError,
  validatePluginManifest,
  writeJsonFile,
} from "../plugin/manifest.js";

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

export function registerPluginCommand(program) {
  const plugin = program
    .command("plugin")
    .description("Manage Sentinelayer plugin manifests and extension-pack contracts");

  plugin
    .command("init")
    .description("Initialize a deterministic plugin manifest scaffold")
    .requiredOption("--id <plugin-id>", "Unique plugin id (lowercase)")
    .option(
      "--pack-type <type>",
      `Pack boundary type (${PLUGIN_PACK_TYPES.join("|")})`,
      "plugin"
    )
    .option(
      "--stage <stage>",
      `Load-order stage (${PLUGIN_LOAD_STAGES.join("|")})`,
      "scan"
    )
    .option("--path <path>", "Destination file path override")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--force", "Overwrite destination file if it already exists")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const pluginId = normalizePluginId(options.id);
      const packType = normalizePluginPackType(options.packType);
      const stage = normalizePluginLoadStage(options.stage);
      const defaultPath = await resolveDefaultPluginManifestPath({
        cwd: process.cwd(),
        outputDir: options.outputDir,
        env: process.env,
        pluginId,
      });
      const outputPath = normalizeOutputPath(options.path, defaultPath);
      const template = buildPluginManifestTemplate({
        pluginId,
        packType,
        stage,
      });
      const manifest = validatePluginManifest(template);
      const writtenPath = await writeJsonFile(outputPath, manifest, { force: Boolean(options.force) });

      const payload = {
        command: "plugin init",
        pluginId,
        packType: manifest.pack_type,
        stage: manifest.load_order.stage,
        outputPath: writtenPath,
        schemaVersion: manifest.schema_version,
        kind: manifest.kind,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.green(`Wrote plugin manifest: ${writtenPath}`));
      console.log(pc.gray(`Plugin id: ${pluginId}`));
      console.log(pc.gray(`Pack type: ${manifest.pack_type}`));
      console.log(pc.gray(`Stage: ${manifest.load_order.stage}`));
      console.log(pc.gray("Next: edit capabilities/security/load_order and validate before use."));
    });

  plugin
    .command("validate")
    .description("Validate a plugin manifest against Sentinelayer contract")
    .requiredOption("--file <path>", "Manifest file to validate")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const inputPath = path.resolve(process.cwd(), String(options.file || "").trim());
      const loaded = await readJsonFile(inputPath);
      try {
        const manifest = validatePluginManifest(loaded.data);
        const payload = {
          command: "plugin validate",
          valid: true,
          filePath: loaded.path,
          pluginId: manifest.id,
          version: manifest.version,
          packType: manifest.pack_type,
          stage: manifest.load_order.stage,
        };
        if (shouldEmitJson(options, command)) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        console.log(pc.green(`Manifest valid (${manifest.id}@${manifest.version})`));
        console.log(pc.gray(`File: ${loaded.path}`));
      } catch (error) {
        const payload = {
          command: "plugin validate",
          valid: false,
          filePath: loaded.path,
          error: summarizePluginValidationError(error),
        };
        if (shouldEmitJson(options, command)) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(pc.red(`Manifest invalid: ${payload.error}`));
          console.log(pc.gray(`File: ${loaded.path}`));
        }
        process.exitCode = 2;
      }
    });

  plugin
    .command("list")
    .description("List plugin manifests discovered under local artifact root")
    .option("--path <path>", "Workspace path for config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const listing = await listPluginManifests({
        cwd: targetPath,
        outputDir: options.outputDir,
        env: process.env,
      });

      const payload = {
        command: "plugin list",
        pluginsRoot: listing.pluginsRoot,
        pluginCount: listing.plugins.length,
        invalidCount: listing.invalid.length,
        plugins: listing.plugins,
        invalid: listing.invalid,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Plugin manifests"));
        console.log(pc.gray(`Root: ${listing.pluginsRoot}`));
        if (!listing.plugins.length && !listing.invalid.length) {
          console.log(pc.gray("(no plugin manifests found)"));
          return;
        }

        for (const pluginEntry of listing.plugins) {
          console.log(
            `${pluginEntry.id}@${pluginEntry.version} | type=${pluginEntry.packType} | stage=${pluginEntry.stage} | commands=${pluginEntry.commandCount} | templates=${pluginEntry.templateCount} | policies=${pluginEntry.policyCount}`
          );
          console.log(pc.gray(`  ${pluginEntry.path}`));
        }

        for (const invalidEntry of listing.invalid) {
          console.log(pc.yellow(`invalid manifest: ${invalidEntry.path}`));
          console.log(pc.gray(`  ${invalidEntry.error}`));
        }
      }

      if (listing.invalid.length > 0) {
        process.exitCode = 2;
      }
    });

  plugin
    .command("order")
    .description("Resolve deterministic plugin load order by stage")
    .option("--path <path>", "Workspace path for config resolution", ".")
    .option(
      "--stage <stage>",
      `Optional single-stage filter (${PLUGIN_LOAD_STAGES.join("|")})`
    )
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const stage = options.stage ? normalizePluginLoadStage(options.stage) : "";
      const ordering = await computePluginLoadOrder({
        cwd: targetPath,
        outputDir: options.outputDir,
        env: process.env,
        stage,
      });

      const payload = {
        command: "plugin order",
        pluginsRoot: ordering.pluginsRoot,
        invalidCount: ordering.invalidCount,
        hasBlockingIssues: ordering.hasBlockingIssues,
        stages: ordering.stages,
        invalid: ordering.invalid,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Plugin load order"));
        console.log(pc.gray(`Root: ${ordering.pluginsRoot}`));
        for (const stageEntry of ordering.stages) {
          console.log(
            `${stageEntry.stage}: plugins=${stageEntry.pluginCount} cycle=${stageEntry.cycleDetected ? "yes" : "no"}`
          );
          if (stageEntry.order.length > 0) {
            console.log(pc.gray(`  order: ${stageEntry.order.join(" -> ")}`));
          }
          if (stageEntry.unresolvedReferences.length > 0) {
            for (const unresolved of stageEntry.unresolvedReferences) {
              console.log(
                pc.yellow(
                  `  unresolved ${unresolved.relation}: ${unresolved.pluginId} -> ${unresolved.dependencyId}`
                )
              );
            }
          }
          if (stageEntry.cycleNodes.length > 0) {
            console.log(pc.red(`  cycle nodes: ${stageEntry.cycleNodes.join(", ")}`));
          }
        }
        if (ordering.invalid.length > 0) {
          for (const invalidEntry of ordering.invalid) {
            console.log(pc.yellow(`invalid manifest: ${invalidEntry.path}`));
            console.log(pc.gray(`  ${invalidEntry.error}`));
          }
        }
      }

      if (ordering.hasBlockingIssues) {
        process.exitCode = 2;
      }
    });
}
