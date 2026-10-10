import "./setup-env.mjs";
// The MCP server enforces each tool's approval flag. Every CLI bridge tool requires human
// approval, and no server-validated, argument-bound approval exists yet, so the dispatcher refuses
// all of them, before any handler, spawn or file read. These tests drive the real stdio server
// (`sl mcp server run`) over JSON-RPC, with a preload that records any file opened by the server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCliCommandMcpTools, createCliCommandMcpToolHandlers } from "../src/mcp/cli-command-tools.js";
import { MCP_HUMAN_APPROVAL_REQUIRED, handleMcpJsonRpcMessage } from "../src/mcp/session-stdio-server.js";
import { writeStoredSession } from "../src/auth/session-store.js";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const CANARY = "bridge-canary-content-0000";

// Records every path containing FS_SPY_MATCH that the process opens or reads.
const FS_SPY = `
const fs = require("fs");
const match = process.env.FS_SPY_MATCH;
const log = process.env.FS_SPY_LOG;
const note = (p) => { try { if (String(p).includes(match)) fs.appendFileSync(log, String(p) + "\\n"); } catch {} };
for (const name of ["openSync", "readFileSync", "createReadStream"]) {
  const original = fs[name];
  fs[name] = function (p, ...rest) { note(p); return original.call(this, p, ...rest); };
}
for (const name of ["open", "readFile"]) {
  const original = fs[name];
  fs[name] = function (p, ...rest) { note(p); return original.call(this, p, ...rest); };
  const originalPromise = fs.promises[name];
  fs.promises[name] = function (p, ...rest) { note(p); return originalPromise.call(this, p, ...rest); };
}
require("module").syncBuiltinESMExports(); // named ESM imports of fs see the wrappers too
`;

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-bridge-approval-"));
  const home = path.join(root, "home");
  const ws = path.join(root, "workspace");
  await fsp.mkdir(path.join(home, ".sentinelayer"), { recursive: true });
  await fsp.mkdir(ws, { recursive: true });
  // canaries outside the workspace: a temp file and one under ~/.sentinelayer
  const outside = path.join(root, "canary-outside.txt");
  const homeCanary = path.join(home, ".sentinelayer", "canary-home.txt");
  await fsp.writeFile(outside, CANARY);
  await fsp.writeFile(homeCanary, CANARY);
  await writeStoredSession(
    { apiUrl: "http://127.0.0.1:9", token: "bridge-user-token-0000", tokenExpiresAt: new Date(Date.now() + 86400_000).toISOString() },
    { homeDir: home },
  );
  const spy = path.join(root, "fs-spy.cjs");
  const spyLog = path.join(root, "fs-spy.log");
  await fsp.writeFile(spy, FS_SPY);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_API_URL: "http://127.0.0.1:9",
    NODE_OPTIONS: `--require="${spy.split(path.sep).join("/")}"`,
    FS_SPY_MATCH: "canary",
    FS_SPY_LOG: spyLog,
  };
  for (const name of ["SENTINELAYER_TOKEN", "SENTINELAYER_API_TOKEN", "SENTINELAYER_MCP_BRIDGE"]) delete env[name];
  return {
    root,
    ws,
    outside,
    homeCanary,
    env,
    opened: () => (fs.existsSync(spyLog) ? fs.readFileSync(spyLog, "utf8").trim().split("\n").filter(Boolean) : []),
    close: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

// Starts `sl mcp server run`, sends the messages, and returns every response by id plus raw stdout.
async function rpc(fx, messages) {
  const child = spawn(process.execPath, [CLI, "mcp", "server", "run", "--path", fx.ws], {
    cwd: fx.ws,
    env: fx.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const wanted = new Set(messages.filter((m) => m.id !== undefined).map((m) => m.id));
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  const deadline = Date.now() + 120_000;
  const responses = new Map();
  while (Date.now() < deadline) {
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.id !== undefined) responses.set(parsed.id, parsed);
      } catch {
        // partial line
      }
    }
    if ([...wanted].every((id) => responses.has(id))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.stdin.end();
  await new Promise((resolve) => child.on("close", resolve));
  return { responses, stdout, stderr };
}

// A refused call is a JSON-RPC error, never a result: code -32001, data.reason human_approval_required.
const refusedForApproval = (response) =>
  response?.result === undefined &&
  response?.error?.code === MCP_HUMAN_APPROVAL_REQUIRED.code &&
  response?.error?.data?.reason === "human_approval_required";

test("census: every CLI tool in the registry is refused through a real tools/call, and none is advertised", async () => {
  const fx = await fixture();
  try {
    const registry = (await buildCliCommandMcpTools()).filter((tool) => tool.security?.requires_human_approval !== false);
    assert.ok(registry.length >= 150, `the registry holds the CLI tools (${registry.length})`);
    const calls = registry.map((tool, index) => ({
      jsonrpc: "2.0",
      id: 100 + index,
      method: "tools/call",
      params: { name: tool.name, arguments: {} },
    }));
    const run = await rpc(fx, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ...calls,
    ]);
    const listed = run.responses.get(2).result.tools.map((tool) => tool.name);
    assert.deepEqual(listed.filter((name) => name.startsWith("sl.")), [], "no always-refused tool is advertised");
    for (const name of ["poll_inbox", "send_message", "session_lock", "memory.recall"]) {
      assert.ok(listed.includes(name), `session tool ${name} is still listed`);
    }
    const notRefused = registry
      .filter((tool, index) => !refusedForApproval(run.responses.get(100 + index)))
      .map((tool) => tool.name);
    assert.deepEqual(notRefused, [], "every CLI tool is refused with the approval error");
  } finally {
    await fx.close();
  }
});

test("a refused call says why, exactly, and session wake codex is refused even as a dry run without reading any file", async () => {
  const fx = await fixture();
  try {
    const base = { sessionId: "6b0f8c1e-3c2a-4d5e-8f90-a1b2c3d4e5f6", codexSession: "codex-1", dryRun: true, json: true };
    const run = await rpc(fx, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sl.session.wake.codex", arguments: { ...base, messageFile: fx.outside } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sl.session.wake.codex", arguments: { ...base, messageFile: fx.homeCanary } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "sl.session.wake.codex", arguments: { ...base, messageFile: "../canary-outside.txt" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "sl.init", arguments: { projectName: "x", nonInteractive: true, interviewFile: fx.outside } } },
    ]);
    assert.deepEqual(run.responses.get(2), {
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32001,
        message:
          "Human approval is required for sl.session.wake.codex. It is not available over the MCP bridge in this version; run `sl session wake codex` in a terminal instead.",
        data: { reason: "human_approval_required", tool: "sl.session.wake.codex" },
      },
    });
    for (const id of [3, 4, 5]) assert.ok(refusedForApproval(run.responses.get(id)), `call ${id}`);
    assert.match(run.responses.get(5).error.message, /run `sl init` in a terminal instead\.$/);
    assert.equal(run.stdout.includes(CANARY), false, "the canary's content never appears");
    assert.deepEqual(fx.opened(), [], "no canary file was opened");
  } finally {
    await fx.close();
  }
});

test("the dispatcher enforces the flag itself: a flagged tool's handler never runs, an unflagged one does", async () => {
  let ran = 0;
  const handlers = {
    "x.flagged": async () => {
      ran += 1;
      return { ok: true, content: CANARY };
    },
    "x.unpublished": async () => {
      ran += 1;
      return { ok: true };
    },
    "x.plain": async () => ({ ok: true, value: 1 }),
  };
  const tools = [
    { name: "x.flagged", security: { requires_human_approval: true } },
    { name: "x.plain", security: { requires_human_approval: false } },
  ];
  const call = (name) =>
    handleMcpJsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, { handlers, tools });
  assert.ok(refusedForApproval(await call("x.flagged")));
  assert.equal(JSON.parse((await call("x.unpublished")).result.content[0].text).reason, "unknown_tool");
  assert.equal(ran, 0, "neither handler ran");
  assert.equal(JSON.parse((await call("x.plain")).result.content[0].text).ok, true);
  const listed = await handleMcpJsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { handlers, tools });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["x.plain"], "a refused tool is not advertised");
});

test("the CLI tool handlers refuse too, without an approval validator, and run nothing", async () => {
  const executed = [];
  const handlers = createCliCommandMcpToolHandlers(await buildCliCommandMcpTools(), {
    executeCliCommandFn: async (args) => {
      executed.push(args);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
    },
  });
  for (const name of ["sl.session.say", "sl.init", "sl.daemon.watchdog.run", "sl.review.scan"]) {
    const result = await handlers[name]({});
    assert.equal(result.reason, "approval_required", name);
  }
  assert.deepEqual(executed, []);
});

test("past the approval gate, a path input stays inside the workspace; an in-workspace path still runs", async () => {
  const fx = await fixture();
  try {
    await fsp.mkdir(path.join(fx.ws, "docs"), { recursive: true });
    let linked = false;
    try {
      fs.symlinkSync(path.dirname(fx.outside), path.join(fx.ws, "escape"), "junction");
      linked = true;
    } catch {
      // symlinks unavailable here; the other cases still run
    }
    const executed = [];
    const handlers = createCliCommandMcpToolHandlers(await buildCliCommandMcpTools(), {
      targetPath: fx.ws,
      env: fx.env,
      approve: () => true,
      executeCliCommandFn: async (args) => {
        executed.push(args);
        return { exitCode: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });
    const say = (input) => handlers["sl.session.say"]({ sessionId: "s-1", message: ["hi"], json: true, ...input });

    // absolute paths are refused even inside the workspace
    for (const value of [fx.outside, path.dirname(fx.outside), fx.ws, "../", "docs/../../x", ...(linked ? ["escape/canary-outside.txt"] : [])]) {
      const result = await say({ path: value });
      assert.equal(result.reason, "path_outside_workspace", value);
      assert.equal(result.detail, "path", value);
    }
    const interview = await handlers["sl.init"]({ projectName: "x", nonInteractive: true, interviewFile: fx.outside });
    assert.equal(interview.reason, "path_outside_workspace");
    assert.equal(interview.detail, "interviewFile");
    assert.deepEqual(executed, [], "nothing ran for a path outside the workspace");

    for (const value of [".", "docs", "docs/new-file.md"]) {
      const result = await say({ path: value });
      assert.equal(result.ok, true, `${value}: ${JSON.stringify(result)}`);
    }
    assert.equal(executed.length, 3, "in-workspace paths still run");
    assert.deepEqual(fx.opened(), []);
  } finally {
    await fx.close();
  }
});
