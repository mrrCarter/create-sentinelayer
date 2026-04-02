import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import { setConfigValue } from "../config/service.js";
import {
  DEFAULT_POLICY_PACK_ID,
  resolveActivePolicyPack,
  resolvePolicyPackById,
} from "../policy/packs.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function normalizeScope(rawValue) {
  const normalized = String(rawValue || "project").trim().toLowerCase();
  if (normalized !== "project" && normalized !== "global") {
    throw new Error("scope must be project or global.");
  }
  return normalized;
}

export function registerPolicyCommand(program) {
  const policy = program.command("policy").description("Manage Sentinelayer policy packs");

  policy
    .command("list")
    .description("List built-in and plugin-provided policy packs")
    .option("--path <path>", "Workspace path for config/plugin resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const active = await resolveActivePolicyPack({
        cwd: targetPath,
        outputDir: options.outputDir,
        env: process.env,
      });

      const payload = {
        command: "policy list",
        defaultPolicyPack: DEFAULT_POLICY_PACK_ID,
        configuredPolicyPack: active.configuredId,
        activePolicyPack: active.selected ? active.selected.id : null,
        invalidManifestCount: active.listing.invalidManifestCount,
        pluginRoot: active.listing.pluginsRoot,
        packs: active.listing.packs.map((pack) => ({
          id: pack.id,
          name: pack.name,
          source: pack.source,
          description: pack.description,
          scanProfile: pack.scanProfile,
          plugin: pack.plugin || null,
        })),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Policy packs"));
      console.log(pc.gray(`Active: ${payload.activePolicyPack || "(none)"}`));
      for (const pack of payload.packs) {
        const marker = pack.id === payload.activePolicyPack ? "*" : " ";
        const source = pack.source === "plugin" ? "plugin" : "builtin";
        console.log(`${marker} ${pack.id} (${source}) - ${pack.description}`);
      }
      if (payload.invalidManifestCount > 0) {
        console.log(
          pc.yellow(
            `Detected ${payload.invalidManifestCount} invalid plugin manifest(s); run 'plugin list --json' for details.`
          )
        );
      }
    });

  policy
    .command("use <packId>")
    .description("Set active policy pack in config (project/global scope)")
    .option("--path <path>", "Workspace path for config/plugin resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--scope <scope>", "Write scope (project|global)", "project")
    .option("--json", "Emit machine-readable output")
    .action(async (packId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const scope = normalizeScope(options.scope);
      const resolution = await resolvePolicyPackById({
        packId,
        cwd: targetPath,
        outputDir: options.outputDir,
        env: process.env,
      });

      if (!resolution.selected) {
        const available = resolution.packs.map((pack) => pack.id).sort((left, right) => left.localeCompare(right));
        throw new Error(
          `Unknown policy pack '${resolution.packId}'. Available: ${available.join(", ") || "(none)"}`
        );
      }

      const writeResult = await setConfigValue({
        key: "defaultPolicyPack",
        value: resolution.selected.id,
        scope,
        cwd: targetPath,
      });

      const payload = {
        command: "policy use",
        selected: resolution.selected.id,
        source: resolution.selected.source,
        scope: writeResult.scope,
        configPath: writeResult.path,
        scanProfile: resolution.selected.scanProfile,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.green(`Policy pack set to '${resolution.selected.id}' (${resolution.selected.source}).`));
      console.log(pc.gray(`Scope: ${writeResult.scope}`));
      console.log(pc.gray(`Config: ${writeResult.path}`));
    });
}
