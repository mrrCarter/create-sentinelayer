import "./setup-env.mjs";
// SENTINELAYER_MCP_CLI_BRIDGE_DISABLED acts in the CLI bridge handler. Over MCP it changes nothing
// in this version, because the dispatcher refuses every sl.* call for human approval before any
// handler runs (tests/e2e.test.mjs runs the real server both ways). The switch is defence in depth
// for the handler and for approved execution in a future version, so it is tested here, on the
// real generated handler past an injected approval, running the real CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { buildCliCommandMcpTools, createCliCommandMcpToolHandlers, executeCliCommand } from "../src/mcp/cli-command-tools.js";
import { writeStoredSession } from "../src/auth/session-store.js";
import { SESSION_MCP_TOOLS, createSessionMcpRuntime, runMcpStdioServer } from "../src/mcp/session-stdio-server.js";

test("over MCP, the real server refuses an sl.* call before any handler runs, with the switch off or on", async () => {
  const saved = process.env.SENTINELAYER_MCP_CLI_BRIDGE_DISABLED;
  const refusals = [];
  try {
    for (const switchValue of ["", "1"]) {
      process.env.SENTINELAYER_MCP_CLI_BRIDGE_DISABLED = switchValue;
      const runtime = await createSessionMcpRuntime({ targetPath: os.tmpdir() });
      const invoked = [];
      const handlers = Object.fromEntries(
        Object.entries(runtime.handlers).map(([name, handler]) => [
          name,
          async (...args) => {
            invoked.push(name);
            return handler(...args);
          },
        ]),
      );
      const input = new PassThrough();
      const output = new PassThrough();
      let written = "";
      output.on("data", (chunk) => (written += chunk.toString("utf8")));
      const server = runMcpStdioServer({ stdin: input, stdout: output, handlers, tools: runtime.tools });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sl.session.list", arguments: {} } })}\n`);
      input.end();
      await server;
      const responses = new Map(written.trim().split(/\r?\n/).map((line) => JSON.parse(line)).map((r) => [r.id, r]));
      assert.deepEqual(
        responses.get(1).result.tools.map((tool) => tool.name).sort(),
        SESSION_MCP_TOOLS.map((tool) => tool.name).sort(),
        "exactly the native session tools are listed",
      );
      assert.equal(responses.get(1).result.tools.length, 13);
      assert.equal(responses.get(2).result, undefined);
      assert.equal(responses.get(2).error.code, -32001);
      assert.deepEqual(invoked, [], `no handler ran (switch "${switchValue}")`);
      refusals.push(responses.get(2).error);
    }
    assert.deepEqual(refusals[0], refusals[1], "the same refusal with the switch off and on");
  } finally {
    if (saved === undefined) delete process.env.SENTINELAYER_MCP_CLI_BRIDGE_DISABLED;
    else process.env.SENTINELAYER_MCP_CLI_BRIDGE_DISABLED = saved;
  }
});

test("the real generated handler runs the command once with the kill switch off, and not at all with it on", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-bridge-kill-switch-"));
  const home = path.join(root, "home");
  const ws = path.join(root, "workspace");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(ws, { recursive: true });
  const api = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  await writeStoredSession(
    { apiUrl, token: "kill-switch-token-0000", tokenExpiresAt: new Date(Date.now() + 86400_000).toISOString() },
    { homeDir: home },
  );
  const baseEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_API_URL: apiUrl,
  };
  delete baseEnv.SENTINELAYER_TOKEN;
  const tools = await buildCliCommandMcpTools(); // the real CLI tree

  const runWith = async (switchValue) => {
    const executions = [];
    const handlers = createCliCommandMcpToolHandlers(tools, {
      targetPath: ws,
      env: { ...baseEnv, SENTINELAYER_MCP_CLI_BRIDGE_DISABLED: switchValue },
      approve: () => true, // past the approval gate, so only the switch decides
      executeCliCommandFn: (args, options) => {
        executions.push(args);
        return executeCliCommand(args, options); // the real spawn of the CLI
      },
    });
    const result = await handlers["sl.daemon.watchdog.status"]({ path: ".", timeoutMs: 60_000 });
    return { result, executions };
  };

  try {
    const off = await runWith("");
    assert.equal(off.executions.length, 1, "with the switch off, the command runs exactly once");
    assert.equal(off.result.ok, true, String(off.result.stderr));
    assert.equal(off.result.json?.command, "daemon watchdog status");

    const on = await runWith("1");
    assert.equal(on.result.ok, false);
    assert.equal(on.result.reason, "mcp_cli_bridge_disabled");
    assert.deepEqual(on.executions, [], "with the switch on, nothing runs");
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
});
