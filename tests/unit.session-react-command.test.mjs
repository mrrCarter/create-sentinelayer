import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");
const ACTION_TEST_TOKEN = ["api", "token", "unit", "session", "action"].join("_");

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function startActionMockApi({ actions = [], hangActionResponseBody = false } = {}) {
  const sessionEvents = [
    {
      stream: "sl_event",
      event: "session_message",
      agent: { id: "human-mrrcarter", model: "human" },
      payload: { message: "first readable message" },
      sessionId: "sess-actions",
      cursor: "cursor-41",
      sequenceId: 41,
      ts: "2026-05-22T01:59:00.000Z",
      timestamp: "2026-05-22T01:59:00.000Z",
    },
    {
      stream: "sl_event",
      event: "session_message",
      agent: { id: "claude-mythos", role: "reviewer" },
      payload: { message: "second readable message" },
      sessionId: "sess-actions",
      cursor: "cursor-42",
      sequenceId: 42,
      ts: "2026-05-22T02:00:00.000Z",
      timestamp: "2026-05-22T02:00:00.000Z",
    },
  ];
  const state = {
    eventsProbeCount: 0,
    actionPayload: null,
    actionPayloads: [],
    actionAuthHeader: "",
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/v1/sessions") {
        return jsonResponse(res, 200, {
          sessions: [{ sessionId: "sess-actions", status: "active", title: "Actions session" }],
          count: 1,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/sessions/sess-actions/human-messages") {
        return jsonResponse(res, 200, { sessionId: "sess-actions", messages: [], cursor: null });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/sessions/sess-actions/events") {
        state.eventsProbeCount += 1;
        return jsonResponse(res, 200, { sessionId: "sess-actions", events: [], count: 0 });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/sessions/sess-actions/events/before") {
        return jsonResponse(res, 200, {
          sessionId: "sess-actions",
          events: [...sessionEvents].reverse(),
          count: sessionEvents.length,
          next_before_sequence: 41,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/sessions/sess-actions/actions") {
        return jsonResponse(res, 200, {
          sessionId: "sess-actions",
          actions,
          count: actions.length,
          projection: { unacknowledgedHumanMessages: [], recentActivity: [] },
        });
      }
      if (req.method === "POST" && req.url === "/api/v1/sessions/sess-actions/actions") {
        state.actionAuthHeader = String(req.headers.authorization || "");
        state.actionPayload = await readJsonBody(req);
        state.actionPayloads.push(state.actionPayload);
        if (hangActionResponseBody) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write('{"ok":true,');
          return;
        }
        const actionType = String(state.actionPayload.actionType || "ack");
        return jsonResponse(res, 200, {
          ok: true,
          duplicate: false,
          action: {
            id: `act-${actionType}`,
            sessionId: "sess-actions",
            targetSequenceId: state.actionPayload.targetSequenceId || null,
            targetCursor: "",
            targetActionId: state.actionPayload.targetActionId || null,
            actionType,
            actionKey: actionType,
            actorKind: "agent",
            actorId: state.actionPayload.metadata?.agentId || "codex",
            actorRole: "coder",
            note: state.actionPayload.note || "",
            createdAt: "2026-05-22T02:00:00.000Z",
            metadata: state.actionPayload.metadata || {},
            idempotencyKey: state.actionPayload.idempotencyKey || "",
          },
        });
      }
      return jsonResponse(res, 404, { error: "not_found", path: req.url });
    } catch (error) {
      return jsonResponse(res, 500, { error: String(error?.message || error) });
    }
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(resolve);
      }),
  };
}

function runCli(args, { cwd, env = {}, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        XDG_CONFIG_HOME: path.join(cwd, ".config"),
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
        SENTINELAYER_SKIP_REMOTE_SYNC: "0",
        SENTINELAYER_TOKEN: ACTION_TEST_TOKEN,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

test("Unit session actions command: lists action vocabulary and examples", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-actions-list-"));
  try {
    const result = await runCli(["session", "actions", "--json"], { cwd: tmp });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session actions");
    assert.equal(payload.actions.some((action) => action.type === "view"), true);
    assert.equal(payload.actions.some((action) => action.alias === "comment"), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session react command: ack posts a message action and appends local event", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-react-ack-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "react",
        "sess-actions",
        "ack",
        "--target-sequence",
        "42",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session react");
    assert.equal(payload.actionType, "ack");
    assert.equal(payload.action.actionType, "ack");
    assert.equal(payload.localAppend.appended, true);
    assert.equal(payload.event.event, "session_action");
    assert.equal(payload.event.payload.actionType, "ack");

    assert.equal(mock.state.eventsProbeCount, 1);
    assert.equal(mock.state.actionAuthHeader, `Bearer ${ACTION_TEST_TOKEN}`);
    assert.equal(mock.state.actionPayload.actionType, "ack");
    assert.equal(mock.state.actionPayload.targetSequenceId, 42);
    assert.equal(mock.state.actionPayload.metadata.agentId, "codex");
    assert.equal(mock.state.actionPayload.metadata.source, "cli");

    const stream = JSON.parse(
      await readFile(path.join(tmp, ".sentinelayer", "sessions", "sess-actions", "stream.ndjson"), "utf8")
        .then((raw) => `[${raw.trim().split(/\r?\n/).join(",")}]`),
    );
    assert.equal(stream.length, 1);
    assert.equal(stream[0].event, "session_action");
    assert.equal(stream[0].payload.actionType, "ack");
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session view command: posts read receipt action", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-view-action-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "view",
        "sess-actions",
        "42",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session view");
    assert.equal(payload.actionType, "view");
    assert.equal(payload.event, null);
    assert.equal(payload.localAppend.appended, false);
    assert.equal(payload.localAppend.reason, "no_event");
    assert.equal(mock.state.actionPayload.actionType, "view");
    assert.equal(mock.state.actionPayload.targetSequenceId, 42);
    assert.equal(mock.state.actionPayload.metadata.agentId, "codex");
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session read --remote: records automatic view receipts for displayed messages", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-read-auto-view-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "read",
        "sess-actions",
        "--remote",
        "--tail",
        "2",
        "--no-actions",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session read");
    assert.equal(payload.count, 2);
    assert.deepEqual(
      payload.events.map((event) => event.sequenceId),
      [41, 42],
    );
    assert.deepEqual(payload.autoView, {
      enabled: true,
      agentId: "codex",
      targetCount: 2,
      attempted: 0,
      recorded: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      queued: 2,
      background: true,
      reason: "queued_best_effort",
    });

    assert.equal(mock.state.actionPayloads.length, 2);
    assert.deepEqual(
      mock.state.actionPayloads.map((body) => body.targetSequenceId),
      [41, 42],
    );
    assert.equal(mock.state.actionPayloads[0].actionType, "view");
    assert.equal(mock.state.actionPayloads[0].targetCursor, "cursor-41");
    assert.equal(mock.state.actionPayloads[0].metadata.source, "cli_read");
    assert.equal(mock.state.actionPayloads[0].metadata.agentId, "codex");
    assert.equal(mock.state.actionPayloads[0].idempotencyKey, "cli:view:seq:41:codex:none");
    assert.equal(mock.state.actionPayloads[1].idempotencyKey, "cli:view:seq:42:codex:none");
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session read --remote: --no-view suppresses automatic view receipts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-read-no-view-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "read",
        "sess-actions",
        "--remote",
        "--tail",
        "2",
        "--no-actions",
        "--no-view",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.autoView.enabled, false);
    assert.equal(payload.autoView.reason, "disabled");
    assert.equal(payload.autoView.targetCount, 0);
    assert.equal(payload.autoView.queued, 0);
    assert.equal(payload.autoView.background, false);
    assert.equal(mock.state.actionPayloads.length, 0);
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session read --remote: caps automatic view writes per read", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-read-auto-view-cap-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "read",
        "sess-actions",
        "--remote",
        "--tail",
        "2",
        "--no-actions",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: {
          SENTINELAYER_API_URL: mock.apiUrl,
          SENTINELAYER_SESSION_READ_VIEW_MAX_TARGETS: "1",
        },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.autoView, {
      enabled: true,
      agentId: "codex",
      targetCount: 2,
      attempted: 0,
      recorded: 0,
      duplicates: 0,
      failed: 0,
      skipped: 1,
      queued: 1,
      background: true,
      reason: "target_cap_reached",
    });
    assert.equal(mock.state.actionPayloads.length, 1);
    assert.equal(mock.state.actionPayloads[0].targetSequenceId, 42);
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session read --remote: hanging auto-view action body does not block output", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-read-auto-view-hang-"));
  const mock = await startActionMockApi({ hangActionResponseBody: true });
  try {
    const startedAt = Date.now();
    const result = await runCli(
      [
        "session",
        "read",
        "sess-actions",
        "--remote",
        "--tail",
        "2",
        "--no-actions",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: {
          SENTINELAYER_API_URL: mock.apiUrl,
          SENTINELAYER_SESSION_READ_VIEW_TIMEOUT_MS: "100",
        },
        timeoutMs: 2_500,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.timedOut, false, result.stderr || result.stdout);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(elapsedMs < 2_000, `session read should exit quickly; elapsed=${elapsedMs}ms`);

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session read");
    assert.equal(payload.count, 2);
    assert.deepEqual(
      payload.events.map((event) => event.payload?.message),
      ["first readable message", "second readable message"],
    );
    assert.deepEqual(payload.autoView, {
      enabled: true,
      agentId: "codex",
      targetCount: 2,
      attempted: 0,
      recorded: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      queued: 2,
      background: true,
      reason: "queued_best_effort",
    });
    assert.equal(mock.state.actionPayloads.length, 1);
    assert.equal(mock.state.actionPayloads[0].actionType, "view");
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session read --remote: quiet actions stay out of visible transcript events", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-read-view-actions-hidden-"));
  const mock = await startActionMockApi({
    actions: [
      {
        id: "act-view-41",
        actionType: "view",
        targetSequenceId: 41,
        actorKind: "agent",
        actorId: "codex",
        createdAt: "2026-05-22T02:00:01.000Z",
      },
      {
        id: "act-ack-41",
        actionType: "ack",
        targetSequenceId: 41,
        actorKind: "agent",
        actorId: "claude",
        createdAt: "2026-05-22T02:00:02.000Z",
      },
    ],
  });
  try {
    const result = await runCli(
      [
        "session",
        "read",
        "sess-actions",
        "--remote",
        "--tail",
        "5",
        "--no-view",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(
      payload.events.some((event) => event.payload?.actionType === "view"),
      false,
    );
    assert.equal(
      payload.events.some((event) => event.payload?.actionType === "ack"),
      false,
    );
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session react command: can target a threaded reply action", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-react-reply-action-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "react",
        "sess-actions",
        "like",
        "--target-action-id",
        "6f6238a9-f035-4a8f-b05b-ac33507f772a",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session react");
    assert.equal(payload.actionType, "like");
    assert.equal(payload.action.targetActionId, "6f6238a9-f035-4a8f-b05b-ac33507f772a");
    assert.equal(payload.event.payload.targetActionId, "6f6238a9-f035-4a8f-b05b-ac33507f772a");
    assert.equal(mock.state.actionPayload.targetActionId, "6f6238a9-f035-4a8f-b05b-ac33507f772a");
    assert.equal(mock.state.actionPayload.targetSequenceId, undefined);
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session comment command: aliases threaded replies", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-comment-action-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "comment",
        "sess-actions",
        "42",
        "threaded",
        "comment",
        "--agent",
        "codex",
        "--path",
        tmp,
        "--json",
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, "session comment");
    assert.equal(payload.actionType, "reply");
    assert.equal(payload.event.event, "session_reply");
    assert.equal(payload.event.payload.actionType, "reply");
    assert.equal(mock.state.actionPayload.actionType, "reply");
    assert.equal(mock.state.actionPayload.note, "threaded comment");
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
