import "./setup-env.mjs";
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

async function startActionMockApi({ actions = [], hangActionResponseBody = false, actionRefusal = null } = {}) {
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
    actionRequests: [],
    readCursorPayload: null,
    readCursorPayloads: [],
    readCursorAuthHeader: "",
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
        state.actionRequests.push({
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body: state.actionPayload,
        });
        const refusal = actionRefusal ? actionRefusal(state.actionPayload) : null;
        if (refusal) {
          return jsonResponse(res, refusal.status, refusal.body);
        }
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
      if (req.method === "PUT" && req.url === "/api/v1/sessions/sess-actions/read-cursor") {
        state.readCursorAuthHeader = String(req.headers.authorization || "");
        state.readCursorPayload = await readJsonBody(req);
        state.readCursorPayloads.push(state.readCursorPayload);
        if (hangActionResponseBody) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write('{"ok":true,');
          return;
        }
        return jsonResponse(res, 200, {
          ok: true,
          updated: true,
          lastReadSequenceId: state.readCursorPayload.targetSequenceId,
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
    assert.equal(payload.actions.some((action) => action.type === "view"), false);
    assert.equal(payload.actions.some((action) => action.alias === "comment"), true);
    for (const undo of ["unlike", "undislike"]) {
      const entry = payload.actions.find((action) => action.type === undo);
      assert.ok(entry, `${undo} must be listed`);
      assert.equal(entry.command, `sl session react <id> ${undo} --target-sequence <n>`);
    }
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

test("Unit legacy session action view: advances delivery cursor without claiming human viewing", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sl-view-action-"));
  const mock = await startActionMockApi();
  try {
    const result = await runCli(
      [
        "session",
        "action",
        "sess-actions",
        "view",
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
    assert.equal(payload.command, "session action");
    assert.equal(payload.actionType, "view");
    assert.equal(payload.event, null);
    assert.equal(payload.localAppend.appended, false);
    assert.equal(payload.localAppend.reason, "read_cursor_projection");
    assert.deepEqual(payload.readCursorProjection, {
      updated: true,
      lastReadSequenceId: 42,
      targetCursor: null,
    });
    assert.equal(mock.state.actionPayloads.length, 0);
    assert.equal(mock.state.readCursorPayload.targetSequenceId, 42);
    assert.equal(mock.state.readCursorPayload.agentId, "codex");
    const humanResult = await runCli(
      [
        "session",
        "action",
        "sess-actions",
        "view",
        "--target-sequence",
        "43",
        "--agent",
        "codex",
        "--path",
        tmp,
      ],
      {
        cwd: tmp,
        env: { SENTINELAYER_API_URL: mock.apiUrl },
      },
    );
    assert.equal(humanResult.code, 0, humanResult.stderr);
    assert.match(
      humanResult.stdout,
      /Advanced read cursor through #43; no transcript event appended\./,
    );
    assert.equal(mock.state.actionPayloads.length, 0);

    const streamRaw = await readFile(
      path.join(tmp, ".sentinelayer", "sessions", "sess-actions", "stream.ndjson"),
      "utf8",
    );
    const stream = streamRaw.trim()
      ? JSON.parse(`[${streamRaw.trim().split(/\r?\n/).join(",")}]`)
      : [];
    assert.equal(
      stream.some((event) => event.event === "session_action" && event.payload?.actionType === "view"),
      false,
    );
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session read --remote: performs one read-cursor upsert for the displayed window", async () => {
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
      skipped: 1,
      queued: 1,
      background: true,
      reason: "queued_monotonic_upsert",
    });

    assert.equal(mock.state.actionPayloads.length, 0);
    assert.equal(mock.state.readCursorPayloads.length, 1);
    assert.deepEqual(mock.state.readCursorPayloads[0], {
      targetSequenceId: 42,
      targetCursor: "cursor-42",
      agentId: "codex",
    });
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
    assert.equal(mock.state.readCursorPayloads.length, 0);
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Unit session read --remote: collapses all displayed messages into one cursor write", async () => {
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
      reason: "queued_monotonic_upsert",
    });
    assert.equal(mock.state.actionPayloads.length, 0);
    assert.equal(mock.state.readCursorPayloads.length, 1);
    assert.equal(mock.state.readCursorPayloads[0].targetSequenceId, 42);
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
      skipped: 1,
      queued: 1,
      background: true,
      reason: "queued_monotonic_upsert",
    });
    assert.equal(mock.state.actionPayloads.length, 0);
    assert.equal(mock.state.readCursorPayloads.length, 1);
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

// --- reaction undo (sentinelayer-api#914: unlike / undislike) ---

const REPLY_ACTION_ID = "6f6238a9-f035-4a8f-b05b-ac33507f772a";

// What a server without #914 answers: FastAPI request validation rejects the value.
const PRE_UNDO_SERVER_422 = {
  detail: [
    {
      type: "value_error",
      loc: ["body", "actionType"],
      msg: "Value error, unsupported message action type",
      input: "unlike",
      ctx: { error: {} },
    },
  ],
};

function refuseUndoWith(status, body) {
  return (payload) => (["unlike", "undislike"].includes(payload.actionType) ? { status, body } : null);
}

async function withActionMock(prefix, mockOptions, fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const mock = await startActionMockApi(mockOptions);
  const react = (reaction, extraArgs = []) =>
    runCli(
      ["session", "react", "sess-actions", reaction, "--agent", "codex", "--path", tmp, ...extraArgs],
      { cwd: tmp, env: { SENTINELAYER_API_URL: mock.apiUrl } },
    );
  try {
    await fn({ tmp, mock, react });
  } finally {
    await mock.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

async function readLocalStream(tmp) {
  const raw = await readFile(
    path.join(tmp, ".sentinelayer", "sessions", "sess-actions", "stream.ndjson"),
    "utf8",
  ).catch(() => "");
  return raw.trim() ? raw.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

test("Unit session react undo: unlike and undislike are accepted and sent verbatim", async () => {
  await withActionMock("sl-react-undo-", {}, async ({ tmp, mock, react }) => {
    const cases = [
      ["unlike", ["--target-sequence", "42"]],
      ["undislike", ["--target-action-id", REPLY_ACTION_ID]],
    ];
    for (const [reaction, targetArgs] of cases) {
      const result = await react(reaction, [...targetArgs, "--json"]);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.command, "session react");
      assert.equal(payload.actionType, reaction);
      assert.equal(mock.state.actionPayload.actionType, reaction, "the action value goes on the wire verbatim");
      assert.equal(payload.event.event, "session_reaction", "an undo is a reaction event, like like/dislike");
      assert.equal(payload.event.payload.actionType, reaction);
    }
    assert.equal(mock.state.actionPayloads[1].targetActionId, REPLY_ACTION_ID);
    const stream = await readLocalStream(tmp);
    assert.deepEqual(
      stream.map((event) => event.payload.actionType),
      ["unlike", "undislike"],
    );
  });
});

test("Unit session react undo: unknown reactions are still rejected client-side", async () => {
  await withActionMock("sl-react-unknown-", {}, async ({ mock, react }) => {
    for (const reaction of ["bogus", "reply", "unpin", "undo"]) {
      const result = await react(reaction, ["--target-sequence", "42"]);
      assert.notEqual(result.code, 0, `${reaction} must be refused`);
      assert.match(result.stderr, /must be one of/);
    }
    const reply = await react("reply", ["--target-sequence", "42"]);
    assert.match(reply.stderr, /reaction must be one of: ack, like, dislike, unlike, undislike\./);
    assert.equal(mock.state.actionRequests.length, 0, "a refused reaction must never reach the API");
  });
});

test("Unit session react undo: a server without undo (422) gets a friendly refusal and exit 1", async () => {
  await withActionMock(
    "sl-react-undo-422-",
    { actionRefusal: refuseUndoWith(422, PRE_UNDO_SERVER_422) },
    async ({ tmp, mock, react }) => {
      const text = await react("unlike", ["--target-sequence", "42"]);
      assert.equal(text.code, 1, text.stderr);
      assert.match(text.stderr, /This server doesn't support undo yet \(no 'unlike' action\)\. Nothing was changed\./);
      assert.doesNotMatch(text.stderr, /^\s+at /m, "no stack trace");
      assert.doesNotMatch(text.stderr, /Error:/);
      assert.equal(text.stdout.trim(), "");

      const json = await react("undislike", ["--target-sequence", "42", "--json"]);
      assert.equal(json.code, 1, json.stderr);
      const payload = JSON.parse(json.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.reason, "undo_unsupported");
      assert.equal(payload.status, 422);
      assert.equal(payload.actionType, "undislike");
      assert.doesNotMatch(json.stderr, /^\s+at /m);

      assert.equal(mock.state.actionRequests.length, 2);
      assert.deepEqual(await readLocalStream(tmp), [], "a refused undo appends nothing locally");
    },
  );
});

test("Unit session react undo: a 422 about another field is not reported as missing undo", async () => {
  const badTarget = {
    detail: [{ type: "uuid_parsing", loc: ["body", "targetActionId"], msg: "Input should be a valid UUID" }],
  };
  await withActionMock(
    "sl-react-undo-422-other-",
    { actionRefusal: refuseUndoWith(422, badTarget) },
    async ({ react }) => {
      const result = await react("unlike", ["--target-action-id", "not-a-uuid"]);
      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.stderr, /doesn't support undo/);
      assert.match(result.stderr, /Session action failed \(api_422\)/);
    },
  );
});

test("Unit session react undo: 409 REACTION_NOT_ACTIVE says there is nothing to undo", async () => {
  const notActive = {
    error: {
      code: "REACTION_NOT_ACTIVE",
      message: "no active like by this actor on the target to undo",
      request_id: "req-unit",
    },
  };
  await withActionMock(
    "sl-react-undo-409-",
    { actionRefusal: refuseUndoWith(409, notActive) },
    async ({ react }) => {
      const result = await react("unlike", ["--target-sequence", "42"]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /Nothing to undo: codex has no active like on #42\./);
      assert.doesNotMatch(result.stderr, /^\s+at /m);
    },
  );
});

test("Unit session react undo: unlike authors exactly as like does (agent, auth, headers, path)", async () => {
  await withActionMock("sl-react-undo-identity-", {}, async ({ mock, react }) => {
    const like = await react("like", ["--target-sequence", "42", "--json"]);
    const unlike = await react("unlike", ["--target-sequence", "42", "--json"]);
    assert.equal(like.code, 0, like.stderr);
    assert.equal(unlike.code, 0, unlike.stderr);

    const [likeRequest, unlikeRequest] = mock.state.actionRequests;
    assert.equal(unlikeRequest.method, likeRequest.method);
    assert.equal(unlikeRequest.url, likeRequest.url);
    const withoutLength = ({ "content-length": _length, ...headers }) => headers;
    assert.deepEqual(withoutLength(unlikeRequest.headers), withoutLength(likeRequest.headers));
    assert.equal(unlikeRequest.headers.authorization, `Bearer ${ACTION_TEST_TOKEN}`);

    const { actionType: likeType, idempotencyKey: likeKey, ...likeBody } = likeRequest.body;
    const { actionType: unlikeType, idempotencyKey: unlikeKey, ...unlikeBody } = unlikeRequest.body;
    assert.deepEqual(unlikeBody, likeBody, "only the action value (and its fresh key) may differ");
    assert.deepEqual(unlikeBody.metadata, { source: "cli", agentId: "codex" });
    assert.deepEqual([likeType, unlikeType], ["like", "unlike"]);
    assert.match(likeKey, /^cli:like:seq:42:codex:none:[0-9a-f]{16}$/);
    assert.match(unlikeKey, /^cli:unlike:seq:42:codex:none:[0-9a-f]{16}$/);
    assert.equal(JSON.parse(unlike.stdout).event.agent.id, JSON.parse(like.stdout).event.agent.id);
  });
});

test("Unit session react undo: each reaction gets a fresh key; explicit and non-reaction keys are stable", async () => {
  await withActionMock("sl-react-undo-keys-", {}, async ({ mock, react }) => {
    // like -> unlike -> like must be three writes the API can tell apart: a reused
    // key replays the first like instead of re-activating it.
    for (const reaction of ["like", "unlike", "like"]) {
      const result = await react(reaction, ["--target-sequence", "42"]);
      assert.equal(result.code, 0, result.stderr);
    }
    const reactionKeys = mock.state.actionPayloads.map((payload) => payload.idempotencyKey);
    assert.equal(new Set(reactionKeys).size, 3, `keys must differ: ${reactionKeys.join(", ")}`);

    await react("like", ["--target-sequence", "42", "--idempotency-key", "retry-like-42"]);
    await react("ack", ["--target-sequence", "42"]);
    await react("ack", ["--target-sequence", "42"]);
    const [explicitKey, ackKey1, ackKey2] = mock.state.actionPayloads
      .slice(3)
      .map((payload) => payload.idempotencyKey);
    assert.equal(explicitKey, "retry-like-42");
    assert.equal(ackKey1, "cli:ack:seq:42:codex:none");
    assert.equal(ackKey2, ackKey1);
  });
});
