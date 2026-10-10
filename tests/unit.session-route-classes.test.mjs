import "./setup-env.mjs";
// The ONE route classification (src/session/route-classes.js) must cover every local MCP
// session tool and every `sl session` command the MCP CLI bridge can invoke, derived from the
// real handlers and command tree so it cannot go stale. Also checks the preAction guard for
// bridged commands, on Commander-parsed values, for the routes the end-to-end bridge tests
// cannot reach: owner and unclassified commands, and sessions named outside the first operand.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCliCommandMcpTools } from "../src/mcp/cli-command-tools.js";
import { createSessionMcpToolHandlers } from "../src/mcp/session-stdio-server.js";
import { buildCliProgram } from "../src/cli.js";
import { LEGACY_DATA_PLANE_TOOLS, SESSION_ROUTE_CLASSES } from "../src/session/route-classes.js";
import { admittedAgentScope } from "../src/auth/admission-scope.js";
import { assertDispatchMatchesScope, resolveAgentAdmissionTarget } from "../src/session/admission-auth.js";
import { admissionCredentialPath } from "../src/session/admission.js";

const CLASSES = new Set(["legacy-data-plane", "control", "owner", "exempt-local"]);

async function realRoutes() {
  const mcp = Object.keys(createSessionMcpToolHandlers({ targetPath: os.tmpdir() })).map((name) => `mcp:${name}`);
  const tools = await buildCliCommandMcpTools({ buildProgramFn: async () => buildCliProgram({ invokeLegacy: async () => {} }) });
  const session = tools.filter((tool) => tool.name.startsWith("sl.session."));
  const toRoute = (tool) => `cli:${tool.name.slice("sl.".length).split(".").join(" ")}`;
  return {
    mcp,
    invokable: session.filter((tool) => !tool.security.runtime_blocked).map(toRoute),
    allSession: session.map(toRoute),
  };
}

test("every MCP session tool and every bridge-invokable session command has exactly one class", async () => {
  const { mcp, invokable } = await realRoutes();
  const missing = [...mcp, ...invokable].filter((route) => !Object.hasOwn(SESSION_ROUTE_CLASSES, route));
  assert.deepEqual(missing, [], "classify every new tool or command in src/session/route-classes.js");
  for (const [route, routeClass] of Object.entries(SESSION_ROUTE_CLASSES)) {
    assert.ok(CLASSES.has(routeClass), `${route}: unknown class ${routeClass}`);
  }
});

test("the classification names no tool or command that does not exist", async () => {
  const { mcp, allSession } = await realRoutes();
  const known = new Set([...mcp, ...allSession]);
  assert.deepEqual(Object.keys(SESSION_ROUTE_CLASSES).filter((route) => !known.has(route)), []);
});

test("the legacy data-plane list is exactly posting, replying, reading, message actions, reactions and attention", () => {
  assert.deepEqual([...LEGACY_DATA_PLANE_TOOLS].sort(), [
    "cli:session action",
    "cli:session comment",
    "cli:session history",
    "cli:session observe",
    "cli:session pins",
    "cli:session post-agent",
    "cli:session react",
    "cli:session read",
    "cli:session reply",
    "cli:session say",
    "cli:session search",
    "mcp:attention_request",
    "mcp:poll_inbox",
    "mcp:read_history",
    "mcp:send_message",
    "mcp:session_action",
    "mcp:session_react",
    "mcp:session_reply",
  ]);
  for (const route of LEGACY_DATA_PLANE_TOOLS) {
    assert.doesNotMatch(route, /lock|lease|guard|ticket|access/, `${route} is not data-plane`);
  }
});

const SID = "6b0f8c1e-3c2a-4d5e-8f90-a1b2c3d4e5f6";
const BRIDGE_ENV = { SENTINELAYER_MCP_BRIDGE: "1", SENTINELAYER_AGENT_ID: "bridge-agent" };

async function withStoredAdmission(fn) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-route-classes-"));
  const file = admissionCredentialPath(SID, "bridge-agent", { homeDir });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, "{}");
  try {
    await fn(homeDir);
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
}

async function withEmptyHome(fn) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-route-classes-empty-"));
  try {
    await fn(homeDir);
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
}

// An action as Commander hands it to preAction: its command path, its options (and which of
// them were given on the command line) and its parsed operands.
function parsedAction(names, { args = [], opts = {}, sources = {} } = {}) {
  let parent = { name: () => "sl", parent: null };
  let node = null;
  for (const name of names) {
    node = { name: () => name, parent };
    parent = node;
  }
  node.opts = () => opts;
  node.getOptionValueSource = (key) => sources[key];
  node.processedArgs = args;
  return node;
}

// Running inside SID's admission scope, as runCli runs a command it bound to that admission.
const bound = (fn) =>
  admittedAgentScope.run({ sessionId: SID, agentId: "bridge-agent", admissionId: "adm-route", expiresAt: 0 }, fn);
const guard = (action, homeDir, env = BRIDGE_ENV) => assertDispatchMatchesScope(action, { env, homeDir });

test("a bridged owner command is refused in an agent context, with or without a stored admission", async () => {
  const approve = parsedAction(["session", "access", "approve"], { args: [SID, "adm-1"] });
  await withEmptyHome((homeDir) => assert.rejects(guard(approve, homeDir), /owner actions are not available/));
  await withStoredAdmission((homeDir) =>
    assert.rejects(
      bound(() => guard(approve, homeDir)),
      /owner actions are not available/,
    ),
  );
});

test("a bridged unclassified command is refused when its session stores no admission", async () => {
  await withEmptyHome(async (homeDir) => {
    await assert.rejects(
      guard(parsedAction(["session", "brand-new-command"], { args: [SID] }), homeDir),
      /not classified for agents/,
    );
    // the legacy data-plane list still runs as before
    await guard(parsedAction(["session", "say"], { args: [SID, ["hello"]], opts: { path: homeDir } }), homeDir);
  });
});

test("a bridged command whose session stores an admission must be running on it", async () => {
  await withStoredAdmission(async (homeDir) => {
    const say = parsedAction(["session", "say"], { args: [SID, ["hello"]], opts: { path: homeDir } });
    const named = parsedAction(["session", "brand-new-command"], {
      args: [SID],
      opts: { agent: "bridge-agent", path: homeDir },
      sources: { agent: "cli" },
    });
    for (const action of [say, named]) {
      await assert.rejects(guard(action, homeDir), /not bound to it/);
      await bound(() => guard(action, homeDir));
    }
  });
});

test("a bridged command counts every session it will use: --session or --id, given or defaulted, and any operand", async () => {
  await withStoredAdmission(async (homeDir) => {
    for (const action of [
      parsedAction(["session", "locks"], { opts: { session: SID }, sources: { session: "cli" } }),
      parsedAction(["session", "locks"], { opts: { session: SID }, sources: { session: "default" } }),
      parsedAction(["session", "locks"], { opts: { id: SID }, sources: { id: "env" } }),
      parsedAction(["session", "locks"], { args: ["first-operand", SID] }),
      parsedAction(["session", "locks"], { args: ["first-operand", ["more", SID]] }),
    ]) {
      await assert.rejects(guard(action, homeDir), /stores an admission and this command's agent is not bound to it/);
    }
    // the same command using no session that stores one is a control operation
    await assert.rejects(
      guard(parsedAction(["session", "locks"], { args: ["first-operand"] }), homeDir),
      /control operation/,
    );
  });
});

test("bridged join, leave and stop-listener are refused in an agent context, with or without a stored admission", async () => {
  const cases = [
    [["session", "join"], ["session", "join", SID, "--agent", "bridge-agent"], { args: [SID], opts: { agent: "bridge-agent" } }],
    [["session", "leave"], ["session", "leave", SID, "--agent", "bridge-agent"], { args: [SID], opts: { agent: "bridge-agent" } }],
    [
      ["session", "stop-listener"],
      ["session", "stop-listener", "--session", SID, "--agent", "bridge-agent"],
      { opts: { session: SID, agent: "bridge-agent" } },
    ],
  ];
  const sources = { agent: "cli", session: "cli" };
  await withEmptyHome(async (homeDir) => {
    for (const [names, , parsed] of cases) {
      await assert.rejects(guard(parsedAction(names, { ...parsed, sources }), homeDir), /control operation/);
    }
  });
  await withStoredAdmission(async (homeDir) => {
    for (const [names, argv, parsed] of cases) {
      // runCli never binds them to an admission: they act on an agent, not as one
      assert.equal(await resolveAgentAdmissionTarget(argv, { env: BRIDGE_ENV, homeDir }), null);
      await assert.rejects(guard(parsedAction(names, { ...parsed, sources }), homeDir), /not bound to it/);
    }
  });
});

test("outside the bridge, or with no agent signal, the guard does not apply", async () => {
  await withEmptyHome(async (homeDir) => {
    const lock = parsedAction(["session", "lock"], { args: [SID, ["a.js"]], opts: { path: homeDir } });
    await guard(lock, homeDir, {});
    await guard(lock, homeDir, { SENTINELAYER_MCP_BRIDGE: "1" });
  });
});
