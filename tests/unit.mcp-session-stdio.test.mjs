import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  createSessionMcpToolHandlers,
  handleMcpJsonRpcMessage,
  readNextMcpMessage,
  runMcpStdioServer,
  writeMcpJsonRpcMessage,
} from "../src/mcp/session-stdio-server.js";

function evt(cursor, agentId, payload = {}, extra = {}) {
  return {
    stream: "sl_event",
    event: "session_message",
    cursor,
    sequenceId: Number(String(cursor).replace(/\D+/g, "")) || undefined,
    sessionId: "sess-1",
    ts: "2026-05-25T00:00:00.000Z",
    agent: { id: agentId, model: "test" },
    payload,
    ...extra,
  };
}

test("Unit MCP session stdio: poll_inbox filters recipients and advances returned cursor", async () => {
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsFn: async (sessionId, options) => ({
      ok: true,
      sessionId,
      cursor: "c4",
      events: [
        evt("c1", "human-mrrcarter", { message: "broadcast" }),
        evt("c2", "claude", { message: "private", to: "claude" }),
        evt("c3", "codex", { message: "self" }),
        evt("c4", "senti", { source: "session_listen", message: "heartbeat" }, { event: "session_listen_heartbeat" }),
      ],
      options,
    }),
  });

  const result = await handlers.poll_inbox({
    sessionId: "sess-1",
    agentId: "codex",
    cursor: "c0",
    limit: 99,
  });

  assert.equal(result.ok, true);
  assert.equal(result.cursor, "c4");
  assert.equal(result.eventCount, 4);
  assert.equal(result.inboxCount, 1);
  assert.equal(result.events[0].payload.message, "broadcast");
});

test("Unit MCP session stdio: send_message persists remote first and caches local second", async () => {
  const synced = [];
  const cached = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    uuidFn: () => "uuid-1",
    now: () => "2026-05-25T00:00:00.000Z",
    syncSessionEventToApiFn: async (sessionId, event, options) => {
      synced.push({ sessionId, event, options });
      return { synced: true, status: 202 };
    },
    appendToStreamFn: async (sessionId, event, options) => {
      cached.push({ sessionId, event, options });
      return { ...event, cursor: "remote-cursor-1", sequenceId: 10 };
    },
  });

  const result = await handlers.send_message({
    sessionId: "sess-1",
    agentId: "codex",
    message: "shipping L3",
    to: ["claude", "carter"],
    idempotencyKey: "idem-1",
  });

  assert.equal(result.ok, true);
  assert.equal(synced.length, 1);
  assert.equal(cached.length, 1);
  assert.equal(synced[0].event.event, "session_message");
  assert.equal(synced[0].event.agent.id, "codex");
  assert.deepEqual(synced[0].event.payload.to, ["claude", "carter"]);
  assert.equal(synced[0].event.idempotencyToken, "idem-1");
  assert.equal(cached[0].options.syncRemote, false);
});

test("Unit MCP session stdio: attention_request emits help_request with high-signal payload", async () => {
  let capturedEvent = null;
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    uuidFn: () => "uuid-2",
    syncSessionEventToApiFn: async (_sessionId, event) => {
      capturedEvent = event;
      return { synced: true, status: 202 };
    },
    appendToStreamFn: async (_sessionId, event) => event,
  });

  const result = await handlers.attention_request({
    sessionId: "sess-1",
    agentId: "codex",
    message: "Need audit on MCP tool surface",
    to: "claude-mythos",
    severity: "review",
  });

  assert.equal(result.ok, true);
  assert.equal(capturedEvent.event, "help_request");
  assert.equal(capturedEvent.payload.requestType, "attention");
  assert.equal(capturedEvent.payload.priority, "high");
  assert.deepEqual(capturedEvent.payload.to, ["claude-mythos"]);
});

test("Unit MCP session stdio: JSON-RPC initialize, list, and call return MCP tool results", async () => {
  const handlers = {
    poll_inbox: async () => ({ ok: true, cursor: "c1", events: [] }),
  };

  const initialized = await handleMcpJsonRpcMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { handlers },
  );
  assert.equal(initialized.result.capabilities.tools.listChanged, false);

  const listed = await handleMcpJsonRpcMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { handlers },
  );
  assert.equal(listed.result.tools.some((tool) => tool.name === "poll_inbox"), true);

  const called = await handleMcpJsonRpcMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "poll_inbox", arguments: { sessionId: "sess-1", agentId: "codex" } },
    },
    { handlers },
  );
  assert.equal(called.result.structuredContent.ok, true);
  assert.equal(called.result.content[0].type, "text");
});

test("Unit MCP session stdio: framing parser accepts content-length and writer supports newline", () => {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  const parsed = readNextMcpMessage(framed);

  assert.equal(parsed.raw, payload);
  assert.equal(parsed.rest.length, 0);

  const out = new PassThrough();
  let written = "";
  out.on("data", (chunk) => {
    written += chunk.toString("utf8");
  });
  writeMcpJsonRpcMessage(out, { jsonrpc: "2.0", id: 1, result: {} }, { framing: "newline" });
  assert.match(written, /\n$/);
});

test("Unit MCP session stdio: server reads newline JSON-RPC from stdin", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => {
    written += chunk.toString("utf8");
  });

  const server = runMcpStdioServer({
    stdin: input,
    stdout: output,
    handlers: {
      poll_inbox: async () => ({ ok: true, cursor: "c2", events: [] }),
    },
  });
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "poll_inbox", arguments: { sessionId: "sess-1", agentId: "codex" } },
    })}\n`,
  );
  input.end();
  await server;

  const response = JSON.parse(written.trim());
  assert.equal(response.id, 7);
  assert.equal(response.result.structuredContent.ok, true);
});
