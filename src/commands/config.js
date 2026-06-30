import { spawnSync } from "node:child_process";
import process from "node:process";

import pc from "picocolors";

import {
  ensureEditableConfigPath,
  findConfigSource,
  getLayer,
  listConfigKeys,
  loadConfig,
  setConfigValue,
} from "../config/service.js";

const SCOPES = "global|project|env|resolved";
const REDACTION_MARKER = "[REDACTED]";
const SENSITIVE_TOP_LEVEL_KEYS = new Set([
  "sentinelayerToken",
  "openaiApiKey",
  "anthropicApiKey",
  "googleApiKey",
]);
const SENSITIVE_KEY_RE = /(authorization|cookie|set-cookie|x-api-key|api[_-]?key|secret|password|credential|token|webhook[_-]?url)/i;

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSensitiveConfigPath(pathParts = []) {
  const lastKey = String(pathParts[pathParts.length - 1] || "");
  if (!lastKey) return false;
  if (pathParts.length === 1 && SENSITIVE_TOP_LEVEL_KEYS.has(lastKey)) return true;
  if (SENSITIVE_KEY_RE.test(lastKey)) return true;
  if (pathParts.includes("alerts") && lastKey.replace(/[_-]/g, "").toLowerCase() === "url") {
    return true;
  }
  return false;
}

function redactConfigValue(value, pathParts = [], depth = 0) {
  if (value === undefined) return undefined;
  if (isSensitiveConfigPath(pathParts)) return REDACTION_MARKER;
  if (depth > 8) return REDACTION_MARKER;
  if (Array.isArray(value)) {
    return value.map((entry) => redactConfigValue(entry, pathParts, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        redactConfigValue(inner, [...pathParts, key], depth + 1),
      ])
    );
  }
  return value;
}

function redactConfigLayer(layer = {}) {
  return redactConfigValue(layer, []);
}

function redactConfigResult(result = {}) {
  return {
    ...result,
    value: redactConfigValue(result.value, [result.key]),
  };
}

function displayValue(key, value) {
  const safeValue = redactConfigValue(value, [key]);
  if (value === undefined) {
    return "";
  }
  if (typeof safeValue === "string") {
    return safeValue;
  }
  return JSON.stringify(safeValue);
}

function assertKnownKey(key) {
  const normalized = String(key || "").trim();
  if (!listConfigKeys().includes(normalized)) {
    throw new Error(`Unknown key '${normalized}'. Allowed keys: ${listConfigKeys().join(", ")}`);
  }
  return normalized;
}

export function registerConfigCommand(program) {
  const config = program
    .command("config")
    .description("Manage layered Sentinelayer CLI configuration");

  config
    .command("list")
    .description("List configuration values")
    .option("--scope <scope>", `Config scope (${SCOPES})`, "resolved")
    .option("--path <path>", "Project root for project scope resolution")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const payload = await loadConfig({ cwd: options.path });
      const scope = String(options.scope || "resolved");
      const layer = getLayer(payload, scope);
      const emitJson = shouldEmitJson(options, command);

      if (emitJson) {
        console.log(
          JSON.stringify(
            {
              scope,
              config: redactConfigLayer(layer),
              paths: payload.paths,
            },
            null,
            2
          )
        );
        return;
      }

      const entries = Object.entries(layer).sort(([left], [right]) => left.localeCompare(right));
      console.log(pc.bold(`Config scope: ${scope}`));
      if (!entries.length) {
        console.log(pc.gray("(empty)"));
        return;
      }
      for (const [key, value] of entries) {
        console.log(`${key}: ${displayValue(key, value)}`);
      }
    });

  config
    .command("get <key>")
    .description("Read a single configuration value")
    .option("--scope <scope>", `Config scope (${SCOPES})`, "resolved")
    .option("--path <path>", "Project root for project scope resolution")
    .option("--json", "Emit machine-readable output")
    .action(async (key, options, command) => {
      const normalizedKey = assertKnownKey(key);
      const payload = await loadConfig({ cwd: options.path });
      const scope = String(options.scope || "resolved");
      const layer = getLayer(payload, scope);
      const value = layer[normalizedKey];
      const source = findConfigSource(payload, normalizedKey);
      const emitJson = shouldEmitJson(options, command);

      if (emitJson) {
        console.log(
          JSON.stringify(
            {
              key: normalizedKey,
              scope,
              value: redactConfigValue(value, [normalizedKey]),
              source,
            },
            null,
            2
          )
        );
        return;
      }

      if (value === undefined) {
        console.log(pc.yellow(`No value set for '${normalizedKey}' in scope '${scope}'.`));
        process.exitCode = 1;
        return;
      }

      console.log(displayValue(normalizedKey, value));
    });

  config
    .command("set <key> <value>")
    .description("Set a configuration value in global or project scope")
    .option("--scope <scope>", "Write scope (global|project)", "project")
    .option("--path <path>", "Project root for project scope resolution")
    .option("--json", "Emit machine-readable output")
    .action(async (key, value, options, command) => {
      const result = await setConfigValue({
        key: assertKnownKey(key),
        value,
        scope: options.scope,
        cwd: options.path,
      });

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(redactConfigResult(result), null, 2));
        return;
      }

      console.log(pc.green(`Updated ${result.key} in ${result.scope} config.`));
      console.log(pc.gray(`Path: ${result.path}`));
      console.log(`${result.key}: ${displayValue(result.key, result.value)}`);
    });

  config
    .command("edit")
    .description("Open config file for editing (uses $EDITOR or $VISUAL)")
    .option("--scope <scope>", "Edit scope (global|project)", "project")
    .option("--path <path>", "Project root for project scope resolution")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const target = await ensureEditableConfigPath({
        scope: options.scope,
        cwd: options.path,
      });

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(target, null, 2));
        return;
      }

      const editor = String(process.env.EDITOR || process.env.VISUAL || "").trim();
      if (!editor) {
        console.log(pc.yellow(`No editor configured. Set $EDITOR or open manually:`));
        console.log(target.path);
        return;
      }

      const result = spawnSync(editor, [target.path], {
        stdio: "inherit",
        shell: true,
      });
      if (result.error) {
        throw result.error;
      }
      if (typeof result.status === "number" && result.status !== 0) {
        throw new Error(`Editor exited with status ${result.status}.`);
      }
    });
}
