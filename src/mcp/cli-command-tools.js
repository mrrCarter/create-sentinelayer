import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { buildSentinelayerCliRegistryTemplate } from "./cli-registry.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_CLI_BIN = fileURLToPath(new URL("../../bin/sl.js", import.meta.url));
const CLI_TOOL_NAME_PREFIX = "sl.";
const BRIDGE_DISABLED_ENV = "SENTINELAYER_MCP_CLI_BRIDGE_DISABLED";
const CLI_PATH_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const CLI_OPTION_FLAG_RE = /^--?[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const BLOCKED_COMMAND_PATHS = new Set(["mcp.server.run"]);
const SENSITIVE_COMMAND_PATHS = new Set([
  "auth.login",
  "auth.logout",
  "auth.revoke",
  "config.edit",
  "config.get",
  "config.list",
  "config.set",
  "policy.use",
  "session.admin-kill",
  "session.admin-kill-all",
  "session.cleanup",
  "session.daemon",
  "session.kill",
  "session.listen",
  "session.provision-emails",
  // Token-handling (same class as auth.*): writes the live SentinelLayer token into a
  // caller-specified GitHub repo's secrets — a token-misplacement/exfil vector via the bridge.
  "scan.setup-secrets",
  // Bulk session-content exfil (same rationale that blocks config.*): full transcript dumps
  // can carry arbitrary sensitive content that output-redaction does not mask. `session read`
  // (normal recent-message reads) stays available for legitimate agent use.
  "session.export",
  "session.download",
  // Identity/state mutation (same class as session.kill): create/revoke AIdenIDs + provision
  // emails (cost + side effects) should not be driven by an untrusted LLM via the bridge.
  "ai.identity.provision",
  "ai.identity.revoke",
  "ai.provision-email",
]);
const REDACTION_MARKER = "[REDACTED]";

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function normalizePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.floor(normalized);
}

function normalizePropertyName(value, fallbackValue) {
  const normalized = normalizeString(value)
    .replace(/^--?/, "")
    .replace(/^no-/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/-([a-zA-Z0-9])/g, (_, chr) => chr.toUpperCase())
    .replace(/^_+|_+$/g, "");
  return normalized || fallbackValue;
}

function normalizeToolName(value) {
  const name = normalizeString(value);
  if (!name) return "";
  return name.startsWith(CLI_TOOL_NAME_PREFIX) ? name : `${CLI_TOOL_NAME_PREFIX}${name}`;
}

function registryToolNameToCliPath(toolName) {
  const name = normalizeToolName(toolName);
  const withoutPrefix = name.startsWith(CLI_TOOL_NAME_PREFIX)
    ? name.slice(CLI_TOOL_NAME_PREFIX.length)
    : name;
  return withoutPrefix.split(".").map(normalizeString).filter(Boolean);
}

function optionFlagFromFlags(flags) {
  const text = normalizeString(flags);
  const long = text.match(/--[a-zA-Z0-9][a-zA-Z0-9-]*/);
  if (long) return long[0];
  const short = text.match(/-[a-zA-Z0-9]\b/);
  return short ? short[0] : "";
}

function normalizePositionalSpec(argument = {}, index = 0) {
  return {
    name: normalizePropertyName(argument.name, `arg${index + 1}`),
    required: Boolean(argument.required),
    variadic: Boolean(argument.variadic),
  };
}

function normalizeOptionSpec(option = {}, index = 0) {
  const flag = normalizeString(option.flag || option.long || option.short || optionFlagFromFlags(option.flags));
  const name = normalizePropertyName(option.name || flag, `option${index + 1}`);
  const expectsValue = Boolean(option.expectsValue ?? option.takes_value ?? option.required);
  return {
    name,
    flag,
    negate: Boolean(option.negate ?? option.negated),
    expectsValue,
    variadic: Boolean(option.variadic),
    json: name === "json" || flag === "--json",
  };
}

function normalizeInputSchema(tool = {}) {
  const schema = tool.inputSchema || tool.input_schema || {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
  return {
    ...schema,
    properties: {
      ...(schema.properties || {}),
      timeoutMs: schema.properties?.timeoutMs || {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS,
        description: "MCP bridge execution timeout in milliseconds.",
      },
    },
  };
}

function blockedReasonForCommandPath(commandPathKey) {
  if (BLOCKED_COMMAND_PATHS.has(commandPathKey)) {
    return "blocked_recursive_mcp_server_command";
  }
  if (SENSITIVE_COMMAND_PATHS.has(commandPathKey)) {
    return "blocked_sensitive_cli_command";
  }
  return "";
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBridgeDisabled(env = process.env) {
  const value = normalizeString(env?.[BRIDGE_DISABLED_ENV]).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function validateCliPathSegments(cliPath = []) {
  if (!Array.isArray(cliPath) || cliPath.length === 0) {
    return "missing_cli_path";
  }
  for (const segment of cliPath) {
    if (!CLI_PATH_SEGMENT_RE.test(normalizeString(segment))) {
      return "invalid_cli_path_segment";
    }
  }
  return "";
}

function validateCliOptionSpecs(optionSpecs = []) {
  for (const option of optionSpecs) {
    if (!CLI_OPTION_FLAG_RE.test(normalizeString(option.flag))) {
      return "invalid_cli_option_flag";
    }
  }
  return "";
}

function validateBridgeToolDefinition(tool = {}) {
  const metadata = tool.metadata || {};
  return validateCliPathSegments(metadata.cliPath) || validateCliOptionSpecs(metadata.options);
}

function isAllowedInputValue(value) {
  if (value === undefined || value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) {
    return value.every((item) => ["string", "number", "boolean"].includes(typeof item));
  }
  return false;
}

function validateBridgeToolInput(tool = {}, input = {}) {
  if (!isPlainObject(input)) {
    return "input_must_be_object";
  }
  const properties = new Set(Object.keys(tool.inputSchema?.properties || {}));
  properties.add("timeout_ms");
  for (const [key, value] of Object.entries(input)) {
    if (!properties.has(key)) {
      return `unsupported_input:${key}`;
    }
    if (!isAllowedInputValue(value)) {
      return `unsupported_input_type:${key}`;
    }
  }
  return "";
}

function normalizeRegistryTool(tool = {}) {
  const metadata = tool.metadata || {};
  const cliPath = Array.isArray(metadata.cliPath)
    ? metadata.cliPath.map(normalizeString).filter(Boolean)
    : Array.isArray(metadata.argv)
      ? metadata.argv.map(normalizeString).filter(Boolean)
      : registryToolNameToCliPath(tool.name);
  const commandPathKey = cliPath.join(".");
  const positionalSource = Array.isArray(metadata.positional)
    ? metadata.positional
    : Array.isArray(metadata.arguments)
      ? metadata.arguments
      : [];
  const optionSource = Array.isArray(metadata.options) ? metadata.options : [];
  const options = optionSource.map(normalizeOptionSpec).filter((option) => option.flag);
  const name = normalizeToolName(tool.name || commandPathKey);
  const blockedReason = blockedReasonForCommandPath(commandPathKey);
  const security = {
    ...(tool.security || {}),
    ...(blockedReason ? { runtime_blocked: true, runtime_block_reason: blockedReason } : {}),
  };

  return {
    name,
    title: tool.title || `sl ${cliPath.join(" ")}`.trim(),
    description: tool.description || `Run SentinelLayer CLI command sl ${cliPath.join(" ")}.`,
    inputSchema: normalizeInputSchema(tool),
    security,
    annotations: {
      ...(tool.annotations || {}),
      destructiveHint: Boolean(security.requires_human_approval),
      readOnlyHint: security.requires_human_approval ? false : undefined,
    },
    metadata: {
      ...metadata,
      bridge: "cli-command",
      cliPath,
      positional: positionalSource.map(normalizePositionalSpec),
      options,
      supportsJson: options.some((option) => option.json),
      blocked: Boolean(metadata.blocked) || Boolean(blockedReason),
      blockedReason: metadata.blockedReason || blockedReason,
    },
  };
}

export async function buildCliCommandMcpTools({
  buildRegistryTemplateFn = buildSentinelayerCliRegistryTemplate,
  buildProgramFn = null,
  generatedAt = "1970-01-01T00:00:00.000Z",
  program = null,
  includeHidden = false,
} = {}) {
  const registry = await buildRegistryTemplateFn({
    generatedAt,
    program: program || (buildProgramFn ? await buildProgramFn() : null),
    includeHidden,
  });
  return (Array.isArray(registry?.tools) ? registry.tools : [])
    .map(normalizeRegistryTool)
    .filter((tool) => tool.name && tool.metadata.cliPath.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function appendPositionalArgs(args, positionalSpecs = [], input = {}) {
  for (const spec of positionalSpecs) {
    const value = input[spec.name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (spec.variadic) {
      const items = Array.isArray(value) ? value : [value];
      args.push(...items.map((item) => String(item)));
      continue;
    }
    args.push(String(value));
  }
}

function appendOptionArgs(args, optionSpecs = [], input = {}) {
  for (const spec of optionSpecs) {
    if (spec.json) {
      continue;
    }
    const value = input[spec.name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (spec.negate) {
      if (value === false) {
        args.push(spec.flag);
      }
      continue;
    }
    if (!spec.expectsValue) {
      if (value === true) {
        args.push(spec.flag);
      }
      continue;
    }
    const values = spec.variadic && Array.isArray(value) ? value : [value];
    for (const item of values) {
      args.push(spec.flag, String(item));
    }
  }
}

export function buildCliCommandArgs(tool = {}, input = {}) {
  const metadata = tool.metadata || {};
  const args = Array.isArray(metadata.cliPath) ? [...metadata.cliPath] : [];
  appendPositionalArgs(args, metadata.positional, input);
  appendOptionArgs(args, metadata.options, input);
  if (metadata.supportsJson && input.json !== false) {
    args.push("--json");
  }
  return args;
}

export function executeCliCommand(
  args,
  {
    targetPath = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    forceKillGraceMs = 2_000,
    spawnFn = spawn,
    nodePath = process.execPath,
    binPath = DEFAULT_CLI_BIN,
    env = process.env,
  } = {},
) {
  return new Promise((resolve) => {
    const child = spawnFn(nodePath, [binPath, ...args], {
      cwd: path.resolve(targetPath),
      env: { ...env, SENTINELAYER_MCP_BRIDGE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer = null;
    function finish(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(payload);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill failures; close/error will resolve.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Resolve below even if the process handle refuses the signal.
        }
        finish({
          exitCode: null,
          signal: "SIGKILL",
          timedOut: true,
          stdout,
          stderr: stderr || "process_timeout",
        });
      }, Math.max(1, normalizePositiveInteger(forceKillGraceMs, 2_000)));
    }, Math.max(1, Math.min(MAX_TIMEOUT_MS, normalizePositiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS))));

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr: stderr || normalizeString(error?.message),
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function redactBridgeText(value) {
  return String(value == null ? "" : value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, `Bearer ${REDACTION_MARKER}`)
    .replace(
      /(["']?\b(?:token|api[_-]?key|secret|password)\b["']?\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi,
      `$1${REDACTION_MARKER}`,
    );
}

function redactBridgeValue(value, depth = 0) {
  if (depth > 8) return REDACTION_MARKER;
  if (typeof value === "string") return redactBridgeText(value);
  if (Array.isArray(value)) return value.map((entry) => redactBridgeValue(entry, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (/(authorization|cookie|set-cookie|x-api-key|api[_-]?key|secret|password|token)/i.test(key)) {
        out[key] = REDACTION_MARKER;
        continue;
      }
      out[key] = redactBridgeValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

function parseJsonOutput(stdout) {
  const text = normalizeString(stdout);
  if (!text) return null;
  try {
    return redactBridgeValue(JSON.parse(text));
  } catch {
    return null;
  }
}

export function createCliCommandMcpToolHandlers(
  tools = [],
  {
    targetPath = process.cwd(),
    executeCliCommandFn = executeCliCommand,
    env = process.env,
  } = {},
) {
  const handlers = {};
  for (const tool of tools) {
    if (tool?.metadata?.bridge !== "cli-command") continue;
    const definitionError = validateBridgeToolDefinition(tool);
    handlers[tool.name] = async (input = {}) => {
      if (isBridgeDisabled(env)) {
        return {
          ok: false,
          reason: "mcp_cli_bridge_disabled",
          tool: tool.name,
        };
      }
      if (definitionError) {
        return {
          ok: false,
          reason: "invalid_cli_bridge_definition",
          detail: definitionError,
          tool: tool.name,
        };
      }
      const inputError = validateBridgeToolInput(tool, input);
      if (inputError) {
        return {
          ok: false,
          reason: "invalid_cli_tool_input",
          detail: inputError,
          tool: tool.name,
        };
      }
      if (tool.metadata.blocked) {
        return {
          ok: false,
          reason: tool.metadata.blockedReason || "blocked_cli_command",
          tool: tool.name,
        };
      }
      const timeoutMs = normalizePositiveInteger(input.timeoutMs || input.timeout_ms, DEFAULT_TIMEOUT_MS);
      const args = buildCliCommandArgs(tool, input);
      const execution = await executeCliCommandFn(args, {
        targetPath,
        timeoutMs,
        env,
      });
      const json = parseJsonOutput(execution.stdout);
      const safeStdout = json ? undefined : redactBridgeText(execution.stdout);
      const safeStderr = redactBridgeText(execution.stderr);
      const safeCommand = redactBridgeText(`sl ${args.join(" ")}`);
      return {
        ok: execution.exitCode === 0 && !execution.timedOut,
        reason: execution.timedOut
          ? "timeout"
          : execution.exitCode === 0
            ? ""
            : "cli_command_failed",
        tool: tool.name,
        command: safeCommand,
        exitCode: execution.exitCode,
        signal: execution.signal,
        timedOut: Boolean(execution.timedOut),
        json,
        stdout: safeStdout || undefined,
        stderr: normalizeString(safeStderr) || undefined,
      };
    };
  }
  return handlers;
}
