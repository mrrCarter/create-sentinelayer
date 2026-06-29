import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Command } from "commander";

import {
  buildCliCommandArgs,
  buildCliCommandMcpTools,
  createCliCommandMcpToolHandlers,
  executeCliCommand,
} from "../src/mcp/cli-command-tools.js";
import { createSessionMcpRuntime } from "../src/mcp/session-stdio-server.js";

function buildFakeProgram() {
  const program = new Command();
  program.name("sl");
  const session = program.command("session").description("Manage Senti sessions");
  session
    .command("say <sessionId> <message...>")
    .description("Send a session message")
    .option("--to <agent>", "Recipient agent")
    .option("--force-new", "Force a new route")
    .option("--json", "Emit JSON");
  const auth = program.command("auth").description("Manage auth");
  auth.command("logout").description("Clear local credentials");
  const config = program.command("config").description("Manage config");
  config.command("get <key>").description("Read config value");
  config.command("list").description("List config values");
  const server = program.command("mcp").description("Manage MCP");
  server.command("server").command("run").description("Run stdio server");
  return program;
}

test("Unit MCP CLI command tools: generates leaf tools from commander tree", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const names = tools.map((tool) => tool.name);

  assert.deepEqual(names, [
    "sl.auth.logout",
    "sl.config.get",
    "sl.config.list",
    "sl.mcp.server.run",
    "sl.session.say",
  ]);
  const say = tools.find((tool) => tool.name === "sl.session.say");
  assert.equal(say.title, "Sl Session Say");
  assert.deepEqual(say.inputSchema.required, ["sessionId", "message"]);
  assert.equal(say.inputSchema.properties.sessionId.type, "string");
  assert.equal(say.inputSchema.properties.message.type, "array");
  assert.equal(say.inputSchema.properties.to.type, "string");
  assert.equal(say.inputSchema.properties.forceNew.type, "boolean");
  assert.equal(say.inputSchema.properties.timeoutMs.maximum, 300000);
  assert.equal(say.security.requires_human_approval, true);
  assert.equal(say.metadata.supportsJson, true);
  assert.deepEqual(say.metadata.cliPath, ["session", "say"]);

  const logout = tools.find((tool) => tool.name === "sl.auth.logout");
  assert.equal(logout.security.runtime_blocked, true);
  assert.equal(logout.security.runtime_block_reason, "blocked_sensitive_cli_command");
  const configGet = tools.find((tool) => tool.name === "sl.config.get");
  assert.equal(configGet.security.runtime_blocked, true);
  assert.equal(configGet.security.runtime_block_reason, "blocked_sensitive_cli_command");
});

test("Unit MCP CLI command tools: maps tool input to CLI args and forces json when supported", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const say = tools.find((tool) => tool.name === "sl.session.say");

  assert.deepEqual(
    buildCliCommandArgs(say, {
      sessionId: "sess-1",
      message: ["hello", "world"],
      to: "claude",
      forceNew: true,
    }),
    ["session", "say", "sess-1", "hello", "world", "--to", "claude", "--force-new", "--json"],
  );
});

test("Unit MCP CLI command tools: handler executes bridge command and parses json stdout", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const handlers = createCliCommandMcpToolHandlers(tools, {
    targetPath: "workspace",
    executeCliCommandFn: async (args, options) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ command: args.join(" "), cwd: options.targetPath }),
      stderr: "",
    }),
  });

  const result = await handlers["sl.session.say"]({
    sessionId: "sess-1",
    message: ["hello"],
    json: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.command, "sl session say sess-1 hello");
  assert.equal(result.json.command, "session say sess-1 hello");
  assert.equal(result.json.cwd, "workspace");
});

test("Unit MCP CLI command tools: blocks recursive mcp server run bridge", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const handlers = createCliCommandMcpToolHandlers(tools, {
    executeCliCommandFn: async () => {
      throw new Error("must not execute");
    },
  });

  const result = await handlers["sl.mcp.server.run"]({});

  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocked_recursive_mcp_server_command");
});

test("Unit MCP CLI command tools: blocks sensitive auth/config commands before execution", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const handlers = createCliCommandMcpToolHandlers(tools, {
    executeCliCommandFn: async () => {
      throw new Error("must not execute");
    },
  });

  const logout = await handlers["sl.auth.logout"]({});
  const configGet = await handlers["sl.config.get"]({ key: "anthropicApiKey" });
  const configList = await handlers["sl.config.list"]({});

  assert.equal(logout.ok, false);
  assert.equal(logout.reason, "blocked_sensitive_cli_command");
  assert.equal(configGet.ok, false);
  assert.equal(configGet.reason, "blocked_sensitive_cli_command");
  assert.equal(configList.ok, false);
  assert.equal(configList.reason, "blocked_sensitive_cli_command");
});

test("Unit MCP CLI command tools: rejects unsupported tool inputs before execution", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const handlers = createCliCommandMcpToolHandlers(tools, {
    executeCliCommandFn: async () => {
      throw new Error("must not execute");
    },
  });

  const result = await handlers["sl.session.say"]({
    sessionId: "sess-1",
    message: ["hello"],
    command: "powershell.exe",
    args: ["-NoProfile"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_cli_tool_input");
  assert.equal(result.detail, "unsupported_input:command");
});

test("Unit MCP CLI command tools: rejects invalid registry command metadata before execution", async () => {
  const handlers = createCliCommandMcpToolHandlers(
    [
      {
        name: "sl.bad.command",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          bridge: "cli-command",
          cliPath: ["session", "say;rm"],
          positional: [],
          options: [],
          supportsJson: false,
        },
      },
    ],
    {
      executeCliCommandFn: async () => {
        throw new Error("must not execute");
      },
    },
  );

  const result = await handlers["sl.bad.command"]({});

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_cli_bridge_definition");
  assert.equal(result.detail, "invalid_cli_path_segment");
});

test("Unit MCP CLI command tools: env kill-switch disables generated CLI bridge execution", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const handlers = createCliCommandMcpToolHandlers(tools, {
    env: { SENTINELAYER_MCP_CLI_BRIDGE_DISABLED: "1" },
    executeCliCommandFn: async () => {
      throw new Error("must not execute");
    },
  });

  const result = await handlers["sl.session.say"]({
    sessionId: "sess-1",
    message: ["hello"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "mcp_cli_bridge_disabled");
});

test("Unit MCP CLI command tools: redacts secret-like command output", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const tokenFixture = ["VcheWKR65eHb", "1234567890abcdef"].join("");
  const handlers = createCliCommandMcpToolHandlers(tools, {
    executeCliCommandFn: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        ok: true,
        token: tokenFixture,
        accessToken: tokenFixture,
        nested: { message: `Bearer ${tokenFixture}` },
      }),
      stderr: `token=${tokenFixture}`,
    }),
  });

  const result = await handlers["sl.session.say"]({
    sessionId: "sess-1",
    message: ["hello"],
    json: false,
  });

  assert.equal(result.json.token, "[REDACTED]");
  assert.equal(result.json.accessToken, "[REDACTED]");
  assert.equal(result.json.nested.message, "Bearer [REDACTED]");
  assert.equal(result.stderr, "token=[REDACTED]");
});

test("Unit MCP CLI command tools: redacts secret-like raw output and command echo", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildFakeProgram(),
  });
  const tokenFixture = ["VcheWKR65eHb", "1234567890abcdef"].join("");
  const handlers = createCliCommandMcpToolHandlers(tools, {
    executeCliCommandFn: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `"token":"${tokenFixture}" Bearer ${tokenFixture}`,
      stderr: `api_key: '${tokenFixture}'`,
    }),
  });

  const result = await handlers["sl.session.say"]({
    sessionId: "sess-1",
    message: [`Bearer ${tokenFixture}`],
    json: false,
  });

  assert.equal(result.command, "sl session say sess-1 Bearer [REDACTED]");
  assert.equal(result.stdout, '"token":[REDACTED] Bearer [REDACTED]');
  assert.equal(result.stderr, "api_key: [REDACTED]");
});

test("Unit MCP CLI command tools: timeout resolves when child never closes", async () => {
  class HungChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new HungChild();
  const result = await executeCliCommand(["session", "listen"], {
    spawnFn: () => child,
    timeoutMs: 1,
    forceKillGraceMs: 1,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("Unit MCP session runtime: combines session tools with generated CLI bridge tools", async () => {
  const runtime = await createSessionMcpRuntime({
    targetPath: "workspace",
    buildCliCommandMcpToolsFn: async () => [
      {
        name: "sl.session.say",
        title: "sl session say",
        description: "Send a session message",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          bridge: "cli-command",
          cliPath: ["session", "say"],
          positional: [],
          options: [],
          supportsJson: true,
        },
      },
    ],
    createCliCommandMcpToolHandlersFn: (tools) => ({
      [tools[0].name]: async () => ({ ok: true }),
    }),
  });
  const toolNames = new Set(runtime.tools.map((tool) => tool.name));

  assert.equal(toolNames.has("poll_inbox"), true);
  assert.equal(toolNames.has("sl.session.say"), true);
  assert.equal(typeof runtime.handlers.poll_inbox, "function");
  assert.equal(typeof runtime.handlers["sl.session.say"], "function");
  assert.equal(runtime.commandToolCount, 1);
});
