import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-admin-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
}

function createSessionProgram() {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerSessionCommand(program);
  return program;
}

async function withCapturedConsole(run) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => errors.push(parts.join(" "));
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logs, errors };
}

async function startMockSessionAdminApi() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) {
      rawBody += String(chunk);
    }
    const jsonBody = rawBody ? JSON.parse(rawBody) : {};
    requests.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: jsonBody,
    });

    const killSessionMatch = /^\/api\/v1\/admin\/sessions\/([^/]+)\/kill$/.exec(String(req.url || ""));
    if (req.method === "POST" && killSessionMatch) {
      const sessionId = decodeURIComponent(killSessionMatch[1]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          killed: true,
          status: "killed",
          reason: String(jsonBody?.reason || "admin_kill"),
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/admin/sessions/kill-all") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          killedCount: 2,
          reason: String(jsonBody?.reason || "admin_global_kill"),
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "missing route" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = Number(address?.port || 0);
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    requests: () => [...requests],
  };
}

test("Unit session admin command: admin-kill hits API and emits local stream event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-admin-kill-"));
  const mockApi = await startMockSessionAdminApi();
  const previousToken = process.env.SENTINELAYER_TOKEN;
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const program = createSessionProgram();
    process.env.SENTINELAYER_TOKEN = "tok_test_admin";

    const captured = await withCapturedConsole(async () => {
      await program.parseAsync(
        [
          "session",
          "admin-kill",
          session.sessionId,
          "--path",
          tempRoot,
          "--api-url",
          mockApi.apiUrl,
          "--reason",
          "operator_stop",
          "--json",
        ],
        { from: "user" }
      );
    });

    const payload = JSON.parse(captured.logs[captured.logs.length - 1]);
    assert.equal(payload.command, "session admin-kill");
    assert.equal(payload.sessionId, session.sessionId);
    assert.equal(payload.reason, "operator_stop");
    assert.equal(payload.result.killed, true);
    assert.equal(payload.localEventEmitted, true);

    const requests = mockApi.requests();
    assert.equal(requests.length >= 1, true);
    const first = requests[0];
    assert.equal(first.method, "POST");
    assert.equal(first.path, `/api/v1/admin/sessions/${encodeURIComponent(session.sessionId)}/kill`);
    assert.match(String(first.headers.authorization || ""), /^Bearer /);

    const events = await readStream(session.sessionId, {
      targetPath: tempRoot,
      tail: 20,
    });
    const adminKillEvent = events.find((event) => event.event === "session_admin_kill");
    assert.ok(adminKillEvent);
    assert.equal(adminKillEvent.payload.scope, "session");
    assert.equal(adminKillEvent.payload.reason, "operator_stop");
  } finally {
    if (previousToken === undefined) {
      delete process.env.SENTINELAYER_TOKEN;
    } else {
      process.env.SENTINELAYER_TOKEN = previousToken;
    }
    await mockApi.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session admin command: admin-kill-all requires --confirm", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-admin-confirm-"));
  const previousExitCode = process.exitCode;
  try {
    await seedWorkspace(tempRoot);
    const program = createSessionProgram();
    process.exitCode = 0;
    const captured = await withCapturedConsole(async () => {
      await program.parseAsync(
        [
          "session",
          "admin-kill-all",
          "--path",
          tempRoot,
          "--json",
        ],
        { from: "user" }
      );
    });
    const payload = JSON.parse(captured.logs[captured.logs.length - 1]);
    assert.equal(payload.command, "session admin-kill-all");
    assert.equal(payload.blocked, true);
    assert.match(payload.error, /--confirm/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session admin command: admin-kill-all hits API with confirmation header and mirrors local events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-admin-kill-all-"));
  const mockApi = await startMockSessionAdminApi();
  const previousToken = process.env.SENTINELAYER_TOKEN;
  const previousExitCode = process.exitCode;
  try {
    await seedWorkspace(tempRoot);
    const firstSession = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const secondSession = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const program = createSessionProgram();
    process.env.SENTINELAYER_TOKEN = "tok_test_admin";
    process.exitCode = 0;

    const captured = await withCapturedConsole(async () => {
      await program.parseAsync(
        [
          "session",
          "admin-kill-all",
          "--confirm",
          "--reason",
          "global_stop",
          "--path",
          tempRoot,
          "--api-url",
          mockApi.apiUrl,
          "--json",
        ],
        { from: "user" }
      );
    });
    const payload = JSON.parse(captured.logs[captured.logs.length - 1]);
    assert.equal(payload.command, "session admin-kill-all");
    assert.equal(payload.reason, "global_stop");
    assert.equal(payload.result.killedCount, 2);
    assert.equal(payload.localEventsEmitted >= 1, true);

    const requests = mockApi.requests();
    const killAll = requests.find((request) => request.path === "/api/v1/admin/sessions/kill-all");
    assert.ok(killAll);
    assert.equal(String(killAll.headers["x-confirm-kill-all"] || "").toLowerCase(), "true");
    assert.match(String(killAll.headers.authorization || ""), /^Bearer /);

    const firstEvents = await readStream(firstSession.sessionId, { targetPath: tempRoot, tail: 20 });
    const secondEvents = await readStream(secondSession.sessionId, { targetPath: tempRoot, tail: 20 });
    assert.ok(firstEvents.find((event) => event.event === "session_admin_kill"));
    assert.ok(secondEvents.find((event) => event.event === "session_admin_kill"));
    assert.equal(process.exitCode, 0);
  } finally {
    if (previousToken === undefined) {
      delete process.env.SENTINELAYER_TOKEN;
    } else {
      process.env.SENTINELAYER_TOKEN = previousToken;
    }
    process.exitCode = previousExitCode;
    await mockApi.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});
