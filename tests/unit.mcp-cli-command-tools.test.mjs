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
import { buildCliProgram } from "../src/cli.js";
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

function buildSensitiveBridgeProgram() {
  const program = new Command();
  program.name("sl");
  const mcp = program.command("mcp").description("Manage MCP");
  mcp.command("token").command("mint").description("Mint hosted MCP bearer token");
  const scan = program.command("scan").description("Security & review");
  scan
    .command("setup-secrets")
    .description("Set up GitHub secrets for Omar Gate")
    .option("--repo <slug>", "Repo slug override");
  const session = program.command("session").description("Manage Senti sessions");
  session.command("export <sessionId>").description("Export full transcript");
  session.command("download <sessionId>").description("Download transcript markdown");
  const daemon = program.command("daemon").description("Daemon controls");
  const control = daemon.command("control").description("Operator control plane");
  control.command("stop").description("Stop/quarantine work item");
  const omargate = program.command("omargate").description("Omar Gate");
  omargate.command("investor-dd").description("Run investor-grade due diligence");
  const review = program.command("review").description("Review reports");
  review.command("show").description("Show full report");
  review.command("export").description("Export full report");
  const ai = program.command("ai").description("AIdenID");
  ai.command("provision-email").description("Provision an AIdenID email");
  const identity = ai.command("identity").description("Identity lifecycle");
  identity.command("provision").description("Provision identity");
  identity.command("revoke").description("Revoke identity");
  identity.command("kill-all").description("Kill all identities");
  identity.command("create-child").description("Create a child identity");
  identity.command("revoke-children").description("Revoke child identities");
  identity.command("events").description("List inbound identity events");
  identity.command("latest").description("Show latest extraction");
  identity.command("wait-for-otp").description("Poll latest extraction");
  // governance sub-trees (blocked by prefix, incl. read-only leaves to keep it complete)
  const domain = identity.command("domain").description("Domain governance");
  domain.command("create").description("Create domain");
  domain.command("verify").description("Verify domain");
  const targetGroup = identity.command("target").description("Target governance");
  targetGroup.command("create").description("Create target");
  const siteGroup = identity.command("site").description("Callback domain");
  siteGroup.command("create").description("Create site");
  const legalHold = identity.command("legal-hold").description("Legal hold");
  legalHold.command("set").description("Set legal hold");
  return program;
}

test("Unit MCP CLI command tools: blocks token/exfil/identity-mutation commands from the bridge", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildSensitiveBridgeProgram(),
  });
  const expectedBlocked = [
    "sl.mcp.token.mint",
    "sl.scan.setup-secrets",
    "sl.session.export",
    "sl.session.download",
    "sl.daemon.control.stop",
    "sl.omargate.investor-dd",
    "sl.review.show",
    "sl.review.export",
    "sl.ai.provision-email",
    "sl.ai.identity.provision",
    "sl.ai.identity.revoke",
    "sl.ai.identity.kill-all",
    "sl.ai.identity.create-child",
    "sl.ai.identity.revoke-children",
    "sl.ai.identity.events",
    "sl.ai.identity.latest",
    "sl.ai.identity.wait-for-otp",
    // governance sub-trees blocked by prefix (domain/target/site/legal-hold)
    "sl.ai.identity.domain.create",
    "sl.ai.identity.domain.verify",
    "sl.ai.identity.target.create",
    "sl.ai.identity.site.create",
    "sl.ai.identity.legal-hold.set",
  ];
  for (const name of expectedBlocked) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `expected bridge tool ${name} to exist`);
    assert.equal(tool.security.runtime_blocked, true, `${name} should be runtime_blocked`);
    assert.equal(
      tool.security.runtime_block_reason,
      "blocked_sensitive_cli_command",
      `${name} should carry the sensitive block reason`,
    );
  }

  const handlers = createCliCommandMcpToolHandlers(tools, {
    executeCliCommandFn: async () => {
      throw new Error("must not execute sensitive bridge command");
    },
  });
  const setupSecrets = await handlers["sl.scan.setup-secrets"]({});
  assert.equal(setupSecrets.ok, false);
  assert.equal(setupSecrets.reason, "blocked_sensitive_cli_command");
  const mcpTokenMint = await handlers["sl.mcp.token.mint"]({});
  assert.equal(mcpTokenMint.ok, false);
  assert.equal(mcpTokenMint.reason, "blocked_sensitive_cli_command");
  const sessionExport = await handlers["sl.session.export"]({});
  assert.equal(sessionExport.ok, false);
  assert.equal(sessionExport.reason, "blocked_sensitive_cli_command");
  const investorDd = await handlers["sl.omargate.investor-dd"]({});
  assert.equal(investorDd.ok, false);
  assert.equal(investorDd.reason, "blocked_sensitive_cli_command");
  const identityRevoke = await handlers["sl.ai.identity.revoke"]({});
  assert.equal(identityRevoke.ok, false);
  assert.equal(identityRevoke.reason, "blocked_sensitive_cli_command");
  const domainCreate = await handlers["sl.ai.identity.domain.create"]({});
  assert.equal(domainCreate.ok, false, "prefix-blocked governance command must not execute");
  assert.equal(domainCreate.reason, "blocked_sensitive_cli_command");
  const waitForOtp = await handlers["sl.ai.identity.wait-for-otp"]({});
  assert.equal(waitForOtp.ok, false, "OTP extraction command must not execute");
  assert.equal(waitForOtp.reason, "blocked_sensitive_cli_command");
});

test("Unit MCP CLI command tools: blocks sensitive AIdenID commands in the real CLI tree", async () => {
  const tools = await buildCliCommandMcpTools({
    buildProgramFn: async () => buildCliProgram({ invokeLegacy: async () => {} }),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const expectedBlocked = [
    "sl.mcp.token.mint",
    "sl.ai.provision-email",
    "sl.ai.identity.provision",
    "sl.ai.identity.revoke",
    "sl.ai.identity.kill-all",
    "sl.ai.identity.create-child",
    "sl.ai.identity.revoke-children",
    "sl.ai.identity.events",
    "sl.ai.identity.latest",
    "sl.ai.identity.wait-for-otp",
    "sl.ai.identity.domain.create",
    "sl.ai.identity.domain.verify",
    "sl.ai.identity.domain.freeze",
    "sl.ai.identity.target.create",
    "sl.ai.identity.target.verify",
    "sl.ai.identity.target.show",
    "sl.ai.identity.site.create",
    "sl.ai.identity.site.list",
    "sl.ai.identity.legal-hold.status",
    "sl.daemon.control.stop",
    "sl.omargate.investor-dd",
    "sl.review.show",
    "sl.review.export",
  ];
  for (const name of expectedBlocked) {
    const tool = byName.get(name);
    assert.ok(tool, `expected real CLI bridge tool ${name}`);
    assert.equal(tool.security.runtime_blocked, true, `${name} should be runtime_blocked`);
    assert.equal(tool.security.runtime_block_reason, "blocked_sensitive_cli_command");
  }

  for (const name of [
    "sl.ai.identity.list",
    "sl.ai.identity.show",
    "sl.ai.identity.audit",
    "sl.ai.identity.lineage",
  ]) {
    const tool = byName.get(name);
    assert.ok(tool, `expected real CLI bridge tool ${name}`);
    assert.equal(tool.security.runtime_blocked, undefined, `${name} should stay bridge-callable`);
  }
});

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

test("Unit MCP CLI command tools: rejects untrusted registry command metadata before execution", async () => {
  const handlers = createCliCommandMcpToolHandlers(
    [
      {
        name: "sl.session.say",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          bridge: "cli-command",
          cliPath: ["session", "say"],
          positional: [],
          options: [],
          supportsJson: false,
        },
      },
      {
        name: "sl.session.read",
        inputSchema: { type: "object", properties: {} },
        metadata: {
          bridge: "cli-command",
          generated_from: "commander",
          execution: "bridge",
          cliPath: ["session", "say"],
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

  const untrusted = await handlers["sl.session.say"]({});
  assert.equal(untrusted.ok, false);
  assert.equal(untrusted.reason, "invalid_cli_bridge_definition");
  assert.equal(untrusted.detail, "untrusted_cli_bridge_definition");

  const mismatched = await handlers["sl.session.read"]({});
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, "invalid_cli_bridge_definition");
  assert.equal(mismatched.detail, "cli_path_name_mismatch");
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
