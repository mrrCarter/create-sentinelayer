// route-classes.js -- the ONE classification of every local MCP session tool ("mcp:<tool>")
// and every `sl session` command the MCP CLI bridge can invoke ("cli:session <path>").
//
// In an agent context it decides what a route may do when the session it acts in stores NO
// admission on this machine (when the session stores one, every route binds to it or is
// refused; see runInSessionToolContext in src/mcp/session-stdio-server.js and
// assertBridgedSessionRoute in src/session/admission-auth.js):
//
//   legacy-data-plane  a compatibility list for rooms that don't require admission:
//                      posting, replying, reading/polling, message actions and reactions,
//                      attention requests. Runs as before; the server's admission mode
//                      decides whether a room accepts it.
//   control            leases, locks, guards, tickets, checkpoints, joining and leaving,
//                      listeners, room setup and everything else that is not plain
//                      data-plane traffic. Refused unless the session's admission binds it.
//   owner              room owner actions. Refused in an agent context.
//   exempt-local       sends no request (a local store or built-in constants only).
//
// A route missing from this table is treated as unclassified and refused like control. A
// unit test derives every MCP tool and every bridge-invokable command from the real handlers
// and command tree and fails when one is missing here.

export const SESSION_ROUTE_CLASSES = Object.freeze({
  // ---- local MCP session tools
  "mcp:poll_inbox": "legacy-data-plane",
  "mcp:read_history": "legacy-data-plane",
  "mcp:send_message": "legacy-data-plane",
  "mcp:attention_request": "legacy-data-plane",
  "mcp:session_action": "legacy-data-plane",
  "mcp:session_react": "legacy-data-plane",
  "mcp:session_reply": "legacy-data-plane",
  "mcp:session_lock": "control",
  "mcp:session_unlock": "control",
  "mcp:session_locks": "control",
  "mcp:memory.write": "exempt-local",
  "mcp:memory.recall": "exempt-local",
  "mcp:memory.summarize": "exempt-local",

  // ---- `sl session` commands invokable through the MCP CLI bridge
  "cli:session say": "legacy-data-plane",
  "cli:session post-agent": "legacy-data-plane",
  "cli:session observe": "legacy-data-plane",
  "cli:session reply": "legacy-data-plane",
  "cli:session comment": "legacy-data-plane",
  "cli:session action": "legacy-data-plane",
  "cli:session react": "legacy-data-plane",
  "cli:session read": "legacy-data-plane",
  "cli:session history": "legacy-data-plane",
  "cli:session search": "legacy-data-plane",
  "cli:session pins": "legacy-data-plane",
  "cli:session lock": "control",
  "cli:session unlock": "control",
  "cli:session locks": "control",
  "cli:session renew": "control",
  "cli:session guard": "control",
  "cli:session guard-hook": "control",
  "cli:session guard-install": "control",
  "cli:session guard-uninstall": "control",
  "cli:session checkpoint create": "control",
  "cli:session checkpoint generate": "control",
  "cli:session checkpoint list": "control",
  "cli:session checkpoint show": "control",
  "cli:session ticket claim": "control",
  "cli:session ticket events": "control",
  "cli:session ticket list": "control",
  "cli:session ticket release": "control",
  "cli:session ticket renew": "control",
  "cli:session ticket submit": "control",
  "cli:session join": "control",
  "cli:session leave": "control",
  "cli:session stop-listener": "control",
  "cli:session listeners": "control",
  "cli:session set-title": "control",
  "cli:session start": "control",
  "cli:session ensure": "control",
  "cli:session continue": "control",
  "cli:session inject-guide": "control",
  "cli:session setup-guides": "control",
  "cli:session sync": "control",
  "cli:session status": "control",
  "cli:session list": "control",
  "cli:session usage": "control",
  "cli:session recall": "control",
  "cli:session recap now": "control",
  "cli:session edit": "control",
  "cli:session wake codex": "control",
  "cli:session wake codex-notify": "control",
  "cli:session wake daemon": "control",
  "cli:session access approve": "owner",
  "cli:session access deny": "owner",
  "cli:session access revoke": "owner",
  "cli:session access mode": "owner",
  "cli:session access request": "owner",
  "cli:session access list": "owner",
  "cli:session access status": "owner",
  "cli:session actions": "exempt-local",
  "cli:session templates": "exempt-local",
});

/** The compatibility list for rooms that don't require admission, as one named view of the table. */
export const LEGACY_DATA_PLANE_TOOLS = Object.freeze(
  Object.keys(SESSION_ROUTE_CLASSES).filter((route) => SESSION_ROUTE_CLASSES[route] === "legacy-data-plane"),
);

export function sessionRouteClass(route) {
  return SESSION_ROUTE_CLASSES[route] || "unclassified";
}

/**
 * The classified route a `session` argv names: the longest "session ..." command path in
 * the table (argv from the bridge always starts with the command path), else the bare
 * "session <subcommand>", which is then unclassified.
 */
export function sessionCommandRoute(args = []) {
  const tokens = args.map((arg) => String(arg ?? "").trim().toLowerCase());
  for (const depth of [3, 2]) {
    const route = `cli:${tokens.slice(0, depth + 1).join(" ")}`;
    if (SESSION_ROUTE_CLASSES[route]) return { route, depth };
  }
  return { route: `cli:${tokens.slice(0, 2).join(" ")}`, depth: 1 };
}
