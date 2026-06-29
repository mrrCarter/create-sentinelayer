import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  SESSION_MCP_TOOLS,
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
    listSessionMessageActionsFn: async () => ({ ok: true, actions: [], projection: { recentActivity: [] } }),
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

test("Unit MCP session stdio: poll_inbox surfaces recent human action activity", async () => {
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsFn: async (sessionId) => ({
      ok: true,
      sessionId,
      cursor: "c9",
      events: [],
    }),
    listSessionMessageActionsFn: async (sessionId, options) => ({
      ok: true,
      sessionId,
      actions: [],
      options,
      projection: {
        recentActivity: [
          {
            id: "reply-old-thread",
            sessionId,
            targetSequenceId: 4,
            targetCursor: "1779364600000:00000004",
            actionType: "reply",
            actorKind: "human",
            actorId: "human-mrrcarter",
            actorRole: "human",
            note: "new reply on an old parent",
            createdAt: "2026-05-25T05:00:00.000Z",
            activityType: "message_action",
            isHumanActivity: true,
          },
          {
            id: "codex-view",
            sessionId,
            targetSequenceId: 5,
            actionType: "view",
            actorKind: "agent",
            actorId: "codex",
            createdAt: "2026-05-25T05:01:00.000Z",
          },
        ],
      },
    }),
  });

  const result = await handlers.poll_inbox({
    sessionId: "sess-1",
    agentId: "codex",
    actionLimit: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.recentHumanActivityCount, 1);
  assert.equal(result.recentHumanActivity[0].targetSequenceId, 4);
  assert.equal(result.recentHumanActivity[0].actionType, "reply");
  assert.equal(result.recentHumanActivity[0].note, "new reply on an old parent");
});

test("Unit MCP session stdio: send_message persists remote first and caches local second", async () => {
  const calls = [];
  const synced = [];
  const cached = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    uuidFn: () => "uuid-1",
    now: () => "2026-05-25T00:00:00.000Z",
    pollSessionEventsBeforeFn: async (sessionId, options) => {
      calls.push("anchor");
      return {
        ok: true,
        sessionId,
        cursor: "cursor-anchor",
        events: [evt("cursor-anchor", "claude", { message: "prior" })],
        options,
      };
    },
    syncSessionEventToApiFn: async (sessionId, event, options) => {
      calls.push("sync");
      synced.push({ sessionId, event, options });
      return { synced: true, status: 202 };
    },
    pollSessionEventsFn: async (sessionId, options) => {
      calls.push("confirm");
      return {
        ok: true,
        sessionId,
        cursor: "cursor-post",
        events: [evt("cursor-post", "codex", { message: "shipping L3", clientMessageId: "idem-1" })],
        options,
      };
    },
    appendToStreamFn: async (sessionId, event, options) => {
      calls.push("cache");
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
  assert.deepEqual(calls, ["anchor", "sync", "confirm", "cache"]);
  assert.equal(synced.length, 1);
  assert.equal(cached.length, 1);
  assert.equal(synced[0].event.event, "session_message");
  assert.equal(synced[0].event.agent.id, "codex");
  assert.deepEqual(synced[0].event.payload.to, ["claude", "carter"]);
  assert.equal(synced[0].event.eventId, "idem-1");
  assert.equal(synced[0].event.idempotencyToken, "idem-1");
  assert.equal(synced[0].event.payload.clientMessageId, "idem-1");
  assert.equal(result.remoteConfirmationAnchor.cursor, "cursor-anchor");
  assert.equal(result.remoteConfirmation.confirmed, true);
  assert.equal(result.remoteConfirmation.event.payload.clientMessageId, "idem-1");
  assert.equal(cached[0].options.syncRemote, false);
});

test("Unit MCP session stdio: send_message skips local cache when canonical confirmation fails", async () => {
  let syncCount = 0;
  let cacheCount = 0;
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    uuidFn: () => "uuid-missing",
    pollSessionEventsBeforeFn: async () => ({
      ok: true,
      cursor: "cursor-anchor",
      events: [evt("cursor-anchor", "claude", { message: "prior" })],
    }),
    syncSessionEventToApiFn: async () => {
      syncCount += 1;
      return { synced: true, status: 202 };
    },
    pollSessionEventsFn: async (_sessionId, options) => ({
      ok: true,
      cursor: options.since,
      events: [],
    }),
    appendToStreamFn: async () => {
      cacheCount += 1;
      throw new Error("must not cache");
    },
    sleepFn: async () => {},
  });

  const result = await handlers.send_message({
    sessionId: "sess-1",
    agentId: "codex",
    message: "this should not be locally cached",
    idempotencyKey: "idem-missing",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_visible");
  assert.equal(result.remoteSync.synced, true);
  assert.equal(result.remoteConfirmation.confirmed, false);
  assert.equal(result.localCache.cached, false);
  assert.equal(result.localCache.reason, "remote_not_visible");
  assert.equal(syncCount, 1);
  assert.equal(cacheCount, 0);
});

test("Unit MCP session stdio: send_message confirmation forward-paginates in busy rooms", async () => {
  const pollCursors = [];
  const cached = [];
  const busyEvents = Array.from({ length: 200 }, (_, index) =>
    evt(`busy-${index + 1}`, "claude", { message: `intervening ${index + 1}`, clientMessageId: `other-${index + 1}` }),
  );
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsBeforeFn: async () => ({
      ok: true,
      cursor: "cursor-anchor",
      events: [evt("cursor-anchor", "claude", { message: "prior" })],
    }),
    syncSessionEventToApiFn: async () => ({ synced: true, status: 202 }),
    pollSessionEventsFn: async (_sessionId, options) => {
      pollCursors.push(options.since);
      if (options.since === "cursor-anchor") {
        return { ok: true, cursor: "cursor-page-1", events: busyEvents };
      }
      return {
        ok: true,
        cursor: "cursor-page-2",
        events: [evt("cursor-page-2", "codex", { message: "buried but visible", clientMessageId: "idem-busy" })],
      };
    },
    appendToStreamFn: async (sessionId, event, options) => {
      cached.push({ sessionId, event, options });
      return event;
    },
  });

  const result = await handlers.send_message({
    sessionId: "sess-1",
    agentId: "codex",
    message: "buried but visible",
    idempotencyKey: "idem-busy",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(pollCursors, ["cursor-anchor", "cursor-page-1"]);
  assert.equal(result.remoteConfirmation.confirmed, true);
  assert.equal(result.remoteConfirmation.pages, 2);
  assert.equal(result.remoteConfirmation.checked, 201);
  assert.equal(cached.length, 1);
});

test("Unit MCP session stdio: send_message confirmation falls back to latest tail", async () => {
  let beforeCalls = 0;
  const cached = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    pollSessionEventsBeforeFn: async () => {
      beforeCalls += 1;
      if (beforeCalls === 1) {
        return {
          ok: true,
          cursor: "cursor-anchor",
          events: [evt("cursor-anchor", "claude", { message: "prior" })],
        };
      }
      return {
        ok: true,
        cursor: "cursor-tail",
        events: [
          evt("cursor-heartbeat", "codex", { source: "session_listen" }, { event: "session_listener_heartbeat" }),
          evt("cursor-tail", "codex", { message: "visible in latest tail", clientMessageId: "idem-tail" }),
        ],
      };
    },
    syncSessionEventToApiFn: async () => ({ synced: true, status: 202 }),
    pollSessionEventsFn: async (_sessionId, options) => ({
      ok: true,
      cursor: options.since,
      events: [],
    }),
    appendToStreamFn: async (sessionId, event, options) => {
      cached.push({ sessionId, event, options });
      return event;
    },
  });

  const result = await handlers.send_message({
    sessionId: "sess-1",
    agentId: "codex",
    message: "visible in latest tail",
    idempotencyKey: "idem-tail",
  });

  assert.equal(result.ok, true);
  assert.equal(beforeCalls, 2);
  assert.equal(result.remoteConfirmation.confirmed, true);
  assert.equal(result.remoteConfirmation.source, "latest_tail");
  assert.equal(result.remoteConfirmation.tailChecks, 1);
  assert.equal(cached.length, 1);
});

test("Unit MCP session stdio: attention_request emits help_request with high-signal payload", async () => {
  let capturedEvent = null;
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    uuidFn: () => "uuid-2",
    pollSessionEventsBeforeFn: async () => ({
      ok: true,
      cursor: "cursor-anchor",
      events: [evt("cursor-anchor", "claude", { message: "prior" })],
    }),
    syncSessionEventToApiFn: async (_sessionId, event) => {
      capturedEvent = event;
      return { synced: true, status: 202 };
    },
    pollSessionEventsFn: async () => ({
      ok: true,
      cursor: "cursor-help",
      events: [evt("cursor-help", "codex", { message: "Need audit on MCP tool surface", clientMessageId: "mcp-help_request-uuid-2" })],
    }),
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
  assert.equal(capturedEvent.eventId, "mcp-help_request-uuid-2");
  assert.equal(capturedEvent.idempotencyToken, "mcp-help_request-uuid-2");
  assert.equal(capturedEvent.payload.clientMessageId, "mcp-help_request-uuid-2");
  assert.equal(capturedEvent.payload.requestType, "attention");
  assert.equal(capturedEvent.payload.priority, "high");
  assert.deepEqual(capturedEvent.payload.to, ["claude-mythos"]);
  assert.equal(result.remoteConfirmation.confirmed, true);
});

test("Unit MCP session stdio: session actions call durable message-action API with agent metadata", async () => {
  const calls = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    createSessionMessageActionFn: async (sessionId, options) => {
      calls.push({ sessionId, options });
      return {
        ok: true,
        duplicate: false,
        action: {
          id: `action-${calls.length}`,
          actionType: options.actionType,
          targetSequenceId: options.targetSequenceId,
          targetCursor: options.targetCursor,
          targetActionId: options.targetActionId,
          actorId: options.metadata.agentId,
          note: options.note,
          idempotencyKey: options.idempotencyKey,
          createdAt: "2026-05-25T00:00:00.000Z",
        },
      };
    },
  });

  const ack = await handlers.session_react({
    sessionId: "sess-1",
    agentId: "codex",
    reaction: "ack",
    targetSequenceId: 115853,
  });
  const reply = await handlers.session_reply({
    sessionId: "sess-1",
    agentId: "codex",
    targetSequenceId: 115853,
    message: "ACK, taking MCP lane",
  });
  const workingOn = await handlers.session_action({
    sessionId: "sess-1",
    agentId: "codex",
    actionType: "working_on",
    targetActionId: "thread-1",
    note: "expanding MCP session tools",
    idempotencyKey: "idem-work",
  });

  assert.equal(ack.ok, true);
  assert.equal(ack.actionType, "ack");
  assert.match(ack.idempotencyKey, /^mcp:ack:seq:115853:codex:/);
  assert.equal(reply.ok, true);
  assert.equal(reply.actionType, "reply");
  assert.equal(reply.note, "ACK, taking MCP lane");
  assert.equal(workingOn.ok, true);
  assert.equal(workingOn.idempotencyKey, "idem-work");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.metadata.source, "mcp");
  assert.equal(calls[0].options.metadata.agentId, "codex");
  assert.equal(calls[0].options.targetSequenceId, 115853);
  assert.equal(calls[1].options.note, "ACK, taking MCP lane");
  assert.equal(calls[2].options.targetActionId, "thread-1");
});

test("Unit MCP session stdio: file lock tools use real lock primitives and report conflicts", async () => {
  const lockCalls = [];
  const unlockCalls = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: "workspace",
    lockFileFn: async (sessionId, agentId, file, options) => {
      lockCalls.push({ sessionId, agentId, file, options });
      if (file === "src/conflict.js") {
        return { file, locked: false, heldBy: "claude", since: "2m ago" };
      }
      return { file, locked: true, lock: { file, agentId, intent: options.intent } };
    },
    unlockFileFn: async (sessionId, agentId, file, options) => {
      unlockCalls.push({ sessionId, agentId, file, options });
      return { file, unlocked: file !== "src/other.js", reason: file === "src/other.js" ? "held_by_other_agent" : "" };
    },
    listFileLocksFn: async (sessionId, options) => [
      { file: "src/a.js", agentId: "codex", intent: "edit", sessionId, targetPath: options.targetPath },
    ],
  });

  const locked = await handlers.session_lock({
    sessionId: "sess-1",
    agentId: "codex",
    files: ["src/a.js", "src/conflict.js"],
    intent: "edit MCP surface",
    ttlSeconds: 60,
    syncRemote: false,
    awaitRemoteSync: false,
  });
  const unlocked = await handlers.session_unlock({
    sessionId: "sess-1",
    agentId: "codex",
    files: ["src/a.js", "src/other.js"],
    reason: "done",
    force: true,
  });
  const listed = await handlers.session_locks({ sessionId: "sess-1" });
  const unlockTool = SESSION_MCP_TOOLS.find((tool) => tool.name === "session_unlock");

  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "lock_conflict");
  assert.equal(locked.lockedCount, 1);
  assert.equal(locked.results[1].heldBy, "claude");
  assert.equal(lockCalls[0].options.intent, "edit MCP surface");
  assert.equal(lockCalls[0].options.ttlSeconds, 60);
  assert.equal(lockCalls[0].options.syncRemote, false);
  assert.equal(lockCalls[0].options.awaitRemoteSync, false);
  assert.equal(unlocked.ok, false);
  assert.equal(unlocked.failedCount, 1);
  assert.equal(unlockCalls[0].options.reason, "done");
  assert.equal(unlockCalls[0].options.force, false);
  assert.equal(unlockTool.inputSchema.properties.force, undefined);
  assert.equal(listed.ok, true);
  assert.equal(listed.lockCount, 1);
  assert.equal(listed.locks[0].file, "src/a.js");
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
  assert.equal(listed.result.tools.some((tool) => tool.name === "session_react"), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === "session_reply"), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === "session_lock"), true);
  assert.equal(listed.result.tools.some((tool) => tool.name === "session_unlock"), true);

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
