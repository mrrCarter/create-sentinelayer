import "./setup-env.mjs";
// The local MCP server's reactions, through the REAL transport (createSessionMessageAction)
// against a stateful model of sentinelayer-api#914's reaction contract. Native
// `sl session react` takes the same path (src/session/reactions.js); its CLI-level tests
// live in unit.session-react-command.test.mjs, and its admission tests (MCP included) in
// unit.session-admission-commands.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SESSION_MCP_TOOLS, createSessionMcpToolHandlers } from "../src/mcp/session-stdio-server.js";
import { resetSessionSyncStateForTests } from "../src/session/sync.js";
import { createReactionLedger } from "./fixtures/reaction-ledger.mjs";

const SID = "sess-mcp-reactions";
const TOKEN = ["api", "token", "unit", "mcp", "reactions"].join("_");

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}

// Only the route reactions use. `loseResponse` commits the write, then drops the
// connection so the client never learns the outcome.
async function withLedgerApi(fn, { loseResponse = null } = {}) {
  const ledger = createReactionLedger();
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== `/api/v1/sessions/${SID}/actions`) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const body = await readJsonBody(req);
    requests.push({ authorization: String(req.headers.authorization || ""), body });
    const answer = ledger.apply(SID, body);
    if (loseResponse && loseResponse(body)) {
      req.socket.destroy();
      return;
    }
    const payload = JSON.stringify(answer.body);
    res.writeHead(answer.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-mcp-reactions-"));
  const saved = { url: process.env.SENTINELAYER_API_URL, token: process.env.SENTINELAYER_TOKEN };
  resetSessionSyncStateForTests(); // also lifts SENTINELAYER_SKIP_REMOTE_SYNC: we want the transport
  process.env.SENTINELAYER_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SENTINELAYER_TOKEN = TOKEN;
  try {
    await fn({ ledger, requests, handlers: createSessionMcpToolHandlers({ targetPath: tmp }) });
  } finally {
    for (const [name, value] of [["SENTINELAYER_API_URL", saved.url], ["SENTINELAYER_TOKEN", saved.token]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetSessionSyncStateForTests();
    process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "1"; // setup-env's default again
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
}

const AT_42 = { sessionId: SID, agentId: "codex", targetSequenceId: 42 };

test("Unit MCP reactions: tools list all four reaction types", () => {
  const react = SESSION_MCP_TOOLS.find((tool) => tool.name === "session_react");
  const action = SESSION_MCP_TOOLS.find((tool) => tool.name === "session_action");
  assert.deepEqual(react.inputSchema.properties.reaction.enum, ["ack", "like", "dislike", "unlike", "undislike"]);
  for (const type of ["like", "dislike", "unlike", "undislike"]) {
    assert.ok(action.inputSchema.properties.actionType.enum.includes(type), type);
  }
});

test("Unit MCP reactions: undone elsewhere, a new like re-activates instead of replaying a stale key", async () => {
  await withLedgerApi(async ({ ledger, handlers }) => {
    const first = await handlers.session_react({ ...AT_42, reaction: "like" });
    assert.equal(first.outcome, "applied");
    assert.match(first.operationKey, /^mcp:like:seq:42:codex:[0-9a-f]{16}$/);

    // Another surface (the native CLI, the web) undoes it.
    ledger.apply(SID, {
      actionType: "unlike",
      targetSequenceId: 42,
      metadata: { source: "cli", agentId: "codex" },
      idempotencyKey: "cli:unlike:seq:42:codex:elsewhere",
    });
    assert.equal(ledger.isActive("codex", { targetSequenceId: 42 }, "like"), false);

    const second = await handlers.session_react({ ...AT_42, reaction: "like" });
    assert.notEqual(second.operationKey, first.operationKey, "a new intent never reuses a key");
    assert.equal(second.outcome, "applied", "not a stale success");
    assert.equal(second.ok, true);
    assert.equal(ledger.isActive("codex", { targetSequenceId: 42 }, "like"), true, "and it is really active");
  });
});

test("Unit MCP reactions: a repeat like through either tool surfaces the retained collapsedActionId", async () => {
  await withLedgerApi(async ({ ledger, handlers }) => {
    const first = await handlers.session_react({ ...AT_42, reaction: "like" });
    const again = await handlers.session_action({ ...AT_42, actionType: "like" });
    const evidence = ledger.rows.find((row) => row.collapsedIntoActionId);
    assert.ok(evidence);
    assert.equal(again.ok, true);
    assert.equal(again.outcome, "no_op");
    assert.equal(again.collapsedActionId, evidence.id);
    assert.equal(again.action.id, first.action.id);
    assert.match(again.message, new RegExp(`retained as evidence ${evidence.id}`));
  });
});

test("Unit MCP reactions: a lost response is unknown, and retrying its key never retracts a newer like", async () => {
  let lostOnce = false;
  const loseResponse = (body) => body.actionType === "unlike" && !lostOnce && (lostOnce = true);
  await withLedgerApi(
    async ({ ledger, handlers }) => {
      await handlers.session_react({ ...AT_42, reaction: "like" });
      const lost = await handlers.session_react({ ...AT_42, reaction: "unlike" });
      assert.equal(lost.ok, false);
      assert.equal(lost.outcome, "unknown");
      ledger.apply(SID, {
        actionType: "like",
        targetSequenceId: 42,
        metadata: { source: "cli", agentId: "codex" },
        idempotencyKey: "cli:like:seq:42:codex:elsewhere",
      });
      const retried = await handlers.session_react({ ...AT_42, reaction: "unlike", idempotencyKey: lost.operationKey });
      assert.equal(retried.outcome, "replayed");
      assert.equal(ledger.isActive("codex", { targetSequenceId: 42 }, "like"), true);
    },
    { loseResponse },
  );
});

test("Unit MCP reactions: undo refusals are named outcomes, and ack keeps its own path", async () => {
  await withLedgerApi(async ({ requests, handlers }) => {
    const nothing = await handlers.session_react({ ...AT_42, reaction: "undislike" });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.outcome, "not_active");
    assert.equal(nothing.status, 409);
    assert.match(nothing.message, /Nothing to undo: codex has no active dislike on #42\./);

    await assert.rejects(
      handlers.session_react({ ...AT_42, agentId: "Codex:Bot", reaction: "like" }),
      /not a canonical agent id/,
    );
    assert.equal(requests.length, 1, "a non-canonical agent id is refused before any request");

    await handlers.session_react({ ...AT_42, reaction: "ack" }).catch(() => {});
    assert.match(requests.at(-1).body.idempotencyKey, /^mcp:ack:seq:42:codex:/);
    assert.equal(requests.every((request) => request.authorization === `Bearer ${TOKEN}`), true);
  });
});
