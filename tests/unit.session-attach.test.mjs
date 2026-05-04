// Unit coverage for `sl session join` + `sl session ensure --session <id>`.
//
// Background: Carter reported that an agent could not pick up a session
// created from the web (or by another CLI). The legacy CLI flow assumed
// the session was created locally first — `join` happily registered an
// agent record without ever asking the API whether the session existed.
//
// These tests pin the new contract:
//   - `join <id>` GETs `/api/v1/sessions/{id}` (singleton from API PR #483)
//     before materializing local cache; 404 surfaces a friendly error.
//   - `--agent <granted>` relays an `agent_join` canonical event after the
//     local stream is materialized (mirrors `post-agent` semantics).
//   - `ensure --session <id>` is a thin alias over `join` for the
//     `{sessionId, title, resumed}` JSON contract callers consume.
//
// Tests intentionally drive `globalThis.fetch` directly (matching the
// pattern in `unit.session-post-agent.test.mjs`) and disable the
// SENTINELAYER_SKIP_REMOTE_SYNC bootstrap so the singleton GET path is
// exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { resetSessionSyncStateForTests } from "../src/session/sync.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-attach-fixture", version: "1.0.0" }, null, 2),
    "utf-8",
  );
}

async function runSessionCommand(args = []) {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerSessionCommand(program);

  const logs = [];
  const errLogs = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(" "));
  console.error = (...parts) => errLogs.push(parts.map((part) => String(part)).join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
  return { stdout: logs.join("\n").trim(), stderr: errLogs.join("\n").trim() };
}

function installAuthEnv(apiUrl = "https://api.sentinelayer.com") {
  const previous = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
  };
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_TOKEN = "tok_attach_test";
  process.env.SENTINELAYER_API_URL = apiUrl;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function fakeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body || {}),
    json: async () => body || {},
    headers: { get: () => "application/json" },
  };
}

test("Unit session join: GETs singleton, materializes local, prints summary", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-join-ok-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    await seedWorkspace(tempRoot);
    const remoteSessionId = "sess-web-abcdef0123456789";
    const lastActivityIso = new Date(Date.now() - 5 * 60_000).toISOString();
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: String(options.method || "GET").toUpperCase() });
      if (String(url).endsWith(`/api/v1/sessions/${remoteSessionId}`)) {
        return fakeJsonResponse(200, {
          session: {
            sessionId: remoteSessionId,
            title: "Carter's web-launched investigation",
            eventCount: 7,
            agentCount: 2,
            lastInteractionAt: lastActivityIso,
            createdAt: lastActivityIso,
          },
        });
      }
      return fakeJsonResponse(404, {});
    };

    const { stdout } = await runSessionCommand([
      "session",
      "join",
      remoteSessionId,
      "--name",
      "agent-alpha",
      "--role",
      "coder",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(stdout);
    assert.equal(payload.command, "session join");
    assert.equal(payload.joined, true);
    assert.equal(payload.sessionId, remoteSessionId);
    assert.equal(payload.title, "Carter's web-launched investigation");
    assert.equal(payload.eventCount, 7);
    assert.equal(payload.agentCount, 2);
    assert.equal(payload.materializedLocalSession, true);
    assert.equal(payload.verificationSource, "singleton");
    assert.equal(payload.agentJoinRelayed, false);
    const singletonCalls = calls.filter((call) =>
      call.url.endsWith(`/api/v1/sessions/${remoteSessionId}`),
    );
    assert.equal(singletonCalls.length, 1);
    assert.equal(singletonCalls[0].method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session join: 404 from singleton + empty list fallback exits with friendly error", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-join-404-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  try {
    await seedWorkspace(tempRoot);
    const remoteSessionId = "sess-missing-9999999999";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith(`/api/v1/sessions/${remoteSessionId}`)) {
        return fakeJsonResponse(404, {});
      }
      if (String(url).includes("/api/v1/sessions?")) {
        return fakeJsonResponse(200, { sessions: [], count: 0 });
      }
      return fakeJsonResponse(404, {});
    };

    await assert.rejects(
      () =>
        runSessionCommand([
          "session",
          "join",
          remoteSessionId,
          "--path",
          tempRoot,
          "--json",
        ]),
      /not found, archived, or not accessible/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session join: --agent <granted> relays agent_join canonical event", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-join-agent-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const eventPosts = [];
  try {
    await seedWorkspace(tempRoot);
    const remoteSessionId = "sess-relay-1111111111";
    globalThis.fetch = async (url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (method === "GET" && String(url).endsWith(`/api/v1/sessions/${remoteSessionId}`)) {
        return fakeJsonResponse(200, {
          session: {
            sessionId: remoteSessionId,
            title: "Relay test",
            eventCount: 0,
            agentCount: 0,
            createdAt: new Date().toISOString(),
          },
        });
      }
      if (
        method === "POST" &&
        String(url).endsWith(`/api/v1/sessions/${remoteSessionId}/events`)
      ) {
        eventPosts.push({ url: String(url), body: JSON.parse(String(options.body || "{}")) });
        return fakeJsonResponse(202, {});
      }
      return fakeJsonResponse(404, {});
    };

    const { stdout } = await runSessionCommand([
      "session",
      "join",
      remoteSessionId,
      "--agent",
      "codex",
      "--model",
      "gpt-5-codex",
      "--role",
      "coder",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(stdout);
    assert.equal(payload.command, "session join");
    assert.equal(payload.agentJoinRelayed, true);

    // registerAgent fan-outs an `agent_join` to /events through appendToStream
    // — exactly the relay path the spec calls for. Other auxiliary events
    // (agent_identified, etc.) may piggy-back, but at least one POST must
    // be the canonical agent_join with the granted agent id.
    assert.ok(eventPosts.length >= 1, "expected at least one relayed event");
    const joinPost = eventPosts.find((entry) => entry.body?.event?.event === "agent_join");
    assert.ok(joinPost, "expected an agent_join POST to /events");
    const agentBlock = joinPost.body.event.agent || {};
    assert.equal(agentBlock.id || joinPost.body.event.agentId, "codex");

    const local = await readStream(remoteSessionId, { targetPath: tempRoot, tail: 20 });
    const persistedJoin = local.find((event) => event.event === "agent_join");
    assert.ok(persistedJoin, "expected local stream to contain the agent_join event");
    const persistedAgentBlock = persistedJoin.agent || {};
    assert.equal(persistedAgentBlock.id || persistedJoin.agentId, "codex");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session ensure --session <id>: behaves like join for the JSON contract", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-ensure-attach-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  try {
    await seedWorkspace(tempRoot);
    const remoteSessionId = "sess-attach-2222222222";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith(`/api/v1/sessions/${remoteSessionId}`)) {
        return fakeJsonResponse(200, {
          session: {
            sessionId: remoteSessionId,
            title: "Cross-surface attach",
            createdAt: new Date().toISOString(),
          },
        });
      }
      return fakeJsonResponse(404, {});
    };

    const { stdout } = await runSessionCommand([
      "session",
      "ensure",
      "--session",
      remoteSessionId,
      "--path",
      tempRoot,
    ]);

    const payload = JSON.parse(stdout);
    assert.equal(payload.command, "session ensure");
    assert.equal(payload.sessionId, remoteSessionId);
    assert.equal(payload.title, "Cross-surface attach");
    assert.equal(payload.resumed, true);
    assert.equal(payload.attached, true);
    assert.equal(payload.materializedLocalSession, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session join: 5xx on first attempt is retried once before failing", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-join-5xx-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  try {
    await seedWorkspace(tempRoot);
    const remoteSessionId = "sess-flaky-3333333333";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith(`/api/v1/sessions/${remoteSessionId}`)) {
        attempts += 1;
        if (attempts === 1) {
          return fakeJsonResponse(503, { error: "upstream" });
        }
        return fakeJsonResponse(200, {
          session: {
            sessionId: remoteSessionId,
            title: "Flaky but resolved",
            createdAt: new Date().toISOString(),
          },
        });
      }
      return fakeJsonResponse(404, {});
    };

    const { stdout } = await runSessionCommand([
      "session",
      "join",
      remoteSessionId,
      "--path",
      tempRoot,
      "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.sessionId, remoteSessionId);
    assert.equal(payload.title, "Flaky but resolved");
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session join: 404 singleton + matching list fallback succeeds (pre-#483 servers)", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-join-fallback-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  try {
    await seedWorkspace(tempRoot);
    const remoteSessionId = "sess-prelist-4444444444";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith(`/api/v1/sessions/${remoteSessionId}`)) {
        return fakeJsonResponse(404, {});
      }
      if (String(url).includes("/api/v1/sessions?")) {
        return fakeJsonResponse(200, {
          sessions: [
            {
              sessionId: remoteSessionId,
              title: "Listed via legacy endpoint",
              eventCount: 3,
              agentCount: 1,
              createdAt: new Date().toISOString(),
            },
          ],
          count: 1,
        });
      }
      return fakeJsonResponse(404, {});
    };

    const { stdout } = await runSessionCommand([
      "session",
      "join",
      remoteSessionId,
      "--path",
      tempRoot,
      "--json",
    ]);
    const payload = JSON.parse(stdout);
    assert.equal(payload.sessionId, remoteSessionId);
    assert.equal(payload.title, "Listed via legacy endpoint");
    assert.equal(payload.verificationSource, "list_fallback");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session ensure --session <id>: 404 surfaces friendly error", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "create-sentinelayer-session-ensure-404-"),
  );
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  try {
    await seedWorkspace(tempRoot);
    const remoteSessionId = "sess-missing-5555555555";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith(`/api/v1/sessions/${remoteSessionId}`)) {
        return fakeJsonResponse(404, {});
      }
      if (String(url).includes("/api/v1/sessions?")) {
        return fakeJsonResponse(200, { sessions: [], count: 0 });
      }
      return fakeJsonResponse(404, {});
    };

    await assert.rejects(
      () =>
        runSessionCommand([
          "session",
          "ensure",
          "--session",
          remoteSessionId,
          "--path",
          tempRoot,
        ]),
      /not found, archived, or not accessible/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
