import "./setup-env.mjs";
// The ONE route classification (src/session/route-classes.js) must cover every local MCP
// session tool and every `sl session` command the MCP CLI bridge can invoke, derived from the
// real handlers and command tree so it cannot go stale. Also checks the bridge guard for the
// routes the end-to-end bridge tests cannot reach: owner and unclassified commands.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCliCommandMcpTools } from "../src/mcp/cli-command-tools.js";
import { createSessionMcpToolHandlers } from "../src/mcp/session-stdio-server.js";
import { buildCliProgram } from "../src/cli.js";
import { LEGACY_DATA_PLANE_TOOLS, SESSION_ROUTE_CLASSES } from "../src/session/route-classes.js";
import { assertBridgedSessionRoute } from "../src/session/admission-auth.js";
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

test("a bridged owner command is refused in an agent context, with or without a stored admission", async () => {
  const args = ["session", "access", "approve", SID, "adm-1", "--json"];
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-route-classes-empty-"));
  await assert.rejects(assertBridgedSessionRoute(args, null, { env: BRIDGE_ENV, homeDir }), /owner actions are not available/);
  await fsp.rm(homeDir, { recursive: true, force: true });
  await withStoredAdmission((home) =>
    assert.rejects(
      assertBridgedSessionRoute(args, { sessionId: SID, agentId: "bridge-agent" }, { env: BRIDGE_ENV, homeDir: home }),
      /owner actions are not available/,
    ),
  );
});

test("a bridged unclassified command is refused when its session stores no admission", async () => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-route-classes-empty-"));
  try {
    await assert.rejects(
      assertBridgedSessionRoute(["session", "brand-new-command", SID], null, { env: BRIDGE_ENV, homeDir }),
      /not classified for agents/,
    );
    // the legacy data-plane list still runs as before
    await assertBridgedSessionRoute(["session", "say", SID, "hello"], null, { env: BRIDGE_ENV, homeDir });
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test("a bridged command whose session stores an admission must be bound to it", async () => {
  await withStoredAdmission(async (homeDir) => {
    for (const args of [["session", "say", SID, "hello"], ["session", "brand-new-command", SID]]) {
      await assert.rejects(assertBridgedSessionRoute(args, null, { env: BRIDGE_ENV, homeDir }), /not bound to it/);
      await assertBridgedSessionRoute(args, { sessionId: SID, agentId: "bridge-agent" }, { env: BRIDGE_ENV, homeDir });
    }
  });
});

test("outside the bridge, or with no agent signal, the guard does not apply", async () => {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-route-classes-empty-"));
  try {
    await assertBridgedSessionRoute(["session", "lock", SID, "a.js"], null, { env: {}, homeDir });
    await assertBridgedSessionRoute(["session", "lock", SID, "a.js"], null, { env: { SENTINELAYER_MCP_BRIDGE: "1" }, homeDir });
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});
