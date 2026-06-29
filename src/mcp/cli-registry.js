import { buildCliProgram } from "../cli.js";
import { MCP_TOOL_REGISTRY_SCHEMA_VERSION } from "./registry.js";

const CLI_TOOL_PREFIX = "sl";
const CLI_TOOL_TIMEOUT_MS = 60_000;
const CLI_TOOL_MAX_CALLS_PER_RUN = 5;

function normalizeDescription(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function toTitle(value) {
  return String(value || "")
    .split(/[\s_.:-]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function optionPropertyName(option) {
  if (typeof option.attributeName === "function") {
    return option.attributeName();
  }
  const long = String(option.long || option.flags || "")
    .split(/[ ,|]+/g)
    .find((part) => part.startsWith("--"));
  return String(long || "")
    .replace(/^--no-/, "")
    .replace(/^--/, "")
    .replace(/-([a-zA-Z0-9])/g, (_, char) => char.toUpperCase());
}

function schemaForArgument(argument) {
  const description = normalizeDescription(argument.description, "");
  if (argument.variadic) {
    return {
      type: "array",
      items: { type: "string" },
      ...(description ? { description } : {}),
    };
  }
  return {
    type: "string",
    ...(description ? { description } : {}),
  };
}

function optionTakesValue(option) {
  return Boolean(option.required || option.optional || option.variadic);
}

function schemaForOption(option) {
  const description = normalizeDescription(option.description, "");
  let schema;
  if (option.variadic) {
    schema = {
      type: "array",
      items: { type: "string" },
    };
  } else if (optionTakesValue(option)) {
    schema = { type: "string" };
  } else {
    schema = { type: "boolean" };
  }

  if (description) {
    schema.description = description;
  }
  if (
    option.defaultValue !== undefined &&
    ["string", "number", "boolean"].includes(typeof option.defaultValue)
  ) {
    schema.default = option.defaultValue;
  }
  return schema;
}

function summarizeArgument(argument) {
  return {
    name: argument.name(),
    required: Boolean(argument.required),
    variadic: Boolean(argument.variadic),
  };
}

function summarizeOption(option) {
  return {
    name: optionPropertyName(option),
    flags: option.flags,
    required: Boolean(option.mandatory),
    takes_value: optionTakesValue(option),
    variadic: Boolean(option.variadic),
    negated: Boolean(option.negate),
  };
}

function isHiddenCommand(command) {
  return Boolean(command.hidden);
}

function commandPath(command) {
  const names = [];
  let current = command;
  while (current && current.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names;
}

function collectLeafCommands(command, { includeHidden = false } = {}) {
  const leaves = [];
  for (const child of command.commands || []) {
    if (!includeHidden && isHiddenCommand(child)) {
      continue;
    }
    if (child.commands && child.commands.length > 0) {
      leaves.push(...collectLeafCommands(child, { includeHidden }));
      continue;
    }
    leaves.push(child);
  }
  return leaves;
}

function buildToolInputSchema(command) {
  const properties = {};
  const required = [];

  for (const argument of command.registeredArguments || []) {
    const name = argument.name();
    properties[name] = schemaForArgument(argument);
    if (argument.required) {
      required.push(name);
    }
  }

  for (const option of command.options || []) {
    const name = optionPropertyName(option);
    if (!name || properties[name]) {
      continue;
    }
    properties[name] = schemaForOption(option);
    if (option.mandatory) {
      required.push(name);
    }
  }

  return {
    type: "object",
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
  };
}

function buildCliTool(command) {
  const pathParts = commandPath(command);
  const commandName = pathParts.join(" ");
  const dottedName = pathParts.join(".");
  const toolName = `${CLI_TOOL_PREFIX}.${dottedName}`;
  return {
    name: toolName,
    title: toTitle(toolName),
    description: normalizeDescription(
      command.description(),
      `Run sentinelayer-cli ${commandName}.`
    ),
    input_schema: buildToolInputSchema(command),
    transport: {
      type: "bridge",
      method: "POST",
      url: `sentinelayer://cli/${dottedName}`,
      timeout_ms: CLI_TOOL_TIMEOUT_MS,
      auth: { mode: "none" },
    },
    budgets: {
      max_calls_per_run: CLI_TOOL_MAX_CALLS_PER_RUN,
      max_runtime_ms: CLI_TOOL_TIMEOUT_MS,
    },
    security: {
      requires_human_approval: true,
      kill_switch: "enabled",
      scopes: ["cli:execute"],
    },
    metadata: {
      provider: "sentinelayer",
      adapter: "sentinelayer-cli",
      command: commandName,
      argv: pathParts,
      generated_from: "commander",
      execution: "bridge",
      arguments: (command.registeredArguments || []).map(summarizeArgument),
      options: (command.options || []).map(summarizeOption),
    },
  };
}

/**
 * Build an MCP tool registry for the installed SentinelLayer CLI command tree.
 *
 * The generated registry is intentionally execution-policy-first: every tool is
 * marked as requiring human approval because this is the full CLI surface.
 *
 * @param {{ generatedAt?: string, program?: import("commander").Command, includeHidden?: boolean }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function buildSentinelayerCliRegistryTemplate({
  generatedAt = new Date().toISOString(),
  program = null,
  includeHidden = false,
} = {}) {
  const cliProgram =
    program ||
    (await buildCliProgram({
      invokeLegacy: async () => {},
    }));
  const tools = collectLeafCommands(cliProgram, { includeHidden }).map(buildCliTool);
  return {
    version: MCP_TOOL_REGISTRY_SCHEMA_VERSION,
    generated_at: generatedAt,
    tools,
  };
}

export const __cliRegistryInternals = Object.freeze({
  collectLeafCommands,
  buildToolInputSchema,
  optionPropertyName,
});
