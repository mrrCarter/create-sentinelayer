import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand, resolveSessionSayAgentId } from "../src/commands/session.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { resetSessionSyncStateForTests } from "../src/session/sync.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-post-agent-fixture", version: "1.0.0" }, null, 2),
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
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n").trim();
}

function installAuthEnv(apiUrl = "https://api.sentinelayer.com") {
  const previous = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
  };
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_TOKEN = "tok_agent_post_test";
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

test("Unit session say identity: default placeholder is not rewritten to human auth identity", () => {
  assert.equal(resolveSessionSayAgentId(undefined), "cli-user");
  assert.equal(resolveSessionSayAgentId(""), "cli-user");
  assert.equal(resolveSessionSayAgentId("cli-user"), "cli-user");
  assert.equal(resolveSessionSayAgentId("Claude Mythos"), "claude-mythos");
});

test("Unit session say identity: omitted --agent persists cli-user visibly", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-say-default-"));
  const restoreEnv = installAuthEnv();
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const output = await runSessionCommand([
      "session",
      "say",
      session.sessionId,
      "default author should stay placeholder",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.command, "session say");
    assert.equal(payload.agentId, "cli-user");
    assert.equal(payload.event.agent.id, "cli-user");
    assert.equal(payload.event.payload.message, "default author should stay placeholder");

    const local = await readStream(session.sessionId, { targetPath: tempRoot, tail: 20 });
    const persistedMessages = local.filter(
      (event) =>
        event.event === "session_message" &&
        event.agent?.id === "cli-user" &&
        event.payload?.message === "default author should stay placeholder",
    );
    assert.equal(persistedMessages.length, 1, "session say must append exactly one local message");
  } finally {
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session say identity: explicit metadata is persisted on the event envelope", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-say-metadata-"));
  const restoreEnv = installAuthEnv();
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const output = await runSessionCommand([
      "session",
      "say",
      session.sessionId,
      "status: metadata is explicit",
      "--agent",
      "codex",
      "--model",
      "gpt-5-codex",
      "--display-name",
      "Codex",
      "--role",
      "coder",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.command, "session say");
    assert.equal(payload.agentId, "codex");
    assert.equal(payload.event.agent.id, "codex");
    assert.equal(payload.event.agent.model, "gpt-5-codex");
    assert.equal(payload.event.agent.displayName, "Codex");
    assert.equal(payload.event.agent.role, "coder");
    assert.equal(payload.event.agent.clientKind, "cli");
  } finally {
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session say identity: joined agent metadata enriches later messages", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-say-registry-"));
  const restoreEnv = installAuthEnv();
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      targetPath: tempRoot,
      agentId: "claude-mythos",
      model: "claude-opus-4.1",
      role: "reviewer",
      trackProcessExit: false,
    });

    const output = await runSessionCommand([
      "session",
      "say",
      session.sessionId,
      "review: joined metadata should carry forward",
      "--agent",
      "claude-mythos",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.event.agent.id, "claude-mythos");
    assert.equal(payload.event.agent.model, "claude-opus-4.1");
    assert.equal(payload.event.agent.role, "reviewer");
    assert.equal(payload.event.agent.clientKind, "cli");
  } finally {
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session say: materialized remote sessions post once then append locally without resync", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-say-materialized-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    await seedWorkspace(tempRoot);
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (options.method === "GET") {
        assert.ok(String(url).endsWith("/api/v1/sessions/remote-say/events?limit=1"));
        return {
          ok: true,
          status: 200,
          json: async () => ({ events: [] }),
        };
      }
      return {
        ok: true,
        status: 202,
        text: async () => "",
        json: async () => ({}),
      };
    };

    const output = await runSessionCommand([
      "session",
      "say",
      "remote-say",
      "status: materialized remote should not double post",
      "--agent",
      "codex",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.materializedLocalSession, true);
    assert.equal(payload.remoteSync.synced, true);
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);

    const events = await readStream("remote-say", { targetPath: tempRoot, tail: 20 });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.message, "status: materialized remote should not double post");

    const readOutput = await runSessionCommand([
      "session",
      "read",
      "remote-say",
      "--tail",
      "5",
      "--path",
      tempRoot,
      "--json",
    ]);
    const readPayload = JSON.parse(readOutput);
    assert.equal(readPayload.displaySource, "local");
    assert.equal(readPayload.count, 1);
    assert.equal(readPayload.events[0].payload.message, "status: materialized remote should not double post");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session post-agent: posts canonical agent event and persists only after remote acceptance", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-post-agent-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 202,
        text: async () => "",
        json: async () => ({}),
      };
    };

    const output = await runSessionCommand([
      "session",
      "post-agent",
      session.sessionId,
      "status: implementing D helper",
      "--agent",
      "Codex",
      "--model",
      "gpt-5-codex",
      "--display-name",
      "Codex",
      "--role",
      "coder",
      "--to",
      "claude",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.command, "session post-agent");
    assert.equal(payload.agentId, "codex");
    assert.equal(payload.remoteSync.synced, true);
    assert.equal(calls.some((call) => call.url.includes("human-message")), false);
    const postCalls = calls.filter((call) => call.options.method === "POST");
    assert.equal(postCalls.length, 1);
    assert.equal(
      postCalls[0].url,
      `https://api.sentinelayer.com/api/v1/sessions/${session.sessionId}/events`,
    );
    assert.equal(postCalls[0].options.headers.Authorization, "Bearer tok_agent_post_test");

    const body = JSON.parse(postCalls[0].options.body);
    assert.equal(body.source, "cli");
    assert.equal(body.event.event, "session_message");
    assert.equal(body.event.agent.id, "codex");
    assert.equal(body.event.agent.model, "gpt-5-codex");
    assert.equal(body.event.agent.displayName, "Codex");
    assert.equal(body.event.agent.clientKind, "cli");
    assert.equal(body.event.payload.message, "status: implementing D helper");
    assert.equal(body.event.payload.source, "agent");
    assert.equal(body.event.payload.to, "claude");

    const events = await readStream(session.sessionId, { targetPath: tempRoot, tail: 20 });
    const posted = events.find(
      (event) =>
        event.event === "session_message" &&
        event.agent?.id === "codex" &&
        event.payload?.message === "status: implementing D helper",
    );
    assert.ok(posted);
    assert.equal(posted.agent.id, "codex");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session post-agent: remote rejection does not write local transcript", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-post-agent-reject-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return {
        ok: false,
        status: 403,
        text: async () => "",
        json: async () => ({}),
      };
    };

    await assert.rejects(
      () =>
        runSessionCommand([
          "session",
          "post-agent",
          session.sessionId,
          "status: blocked",
          "--agent",
          "codex",
          "--path",
          tempRoot,
          "--json",
        ]),
      /Agent post failed \(api_403\).*active grant/,
    );
    assert.equal(fetchCount, 1);

    const events = await readStream(session.sessionId, { targetPath: tempRoot, tail: 20 });
    assert.equal(events.some((event) => event.event === "session_message"), false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session post-agent: refreshes expired local cache after remote acceptance", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-post-agent-expired-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({
      targetPath: tempRoot,
      sessionId: "remote-expired-cache",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      ttlSeconds: 60,
    });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: options.method === "GET" ? 200 : 202,
        text: async () => "",
        json: async () => ({ events: [], cursor: null }),
      };
    };

    const output = await runSessionCommand([
      "session",
      "post-agent",
      session.sessionId,
      "status: remote accepted before local append",
      "--agent",
      "codex",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.remoteSync.synced, true);
    assert.equal(payload.refreshedLocalSession, true);
    assert.ok(
      calls.some(
        (call) =>
          call.options.method === "GET" &&
          call.url.includes(`/api/v1/sessions/${session.sessionId}/events?limit=1`),
      ),
    );
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);

    const events = await readStream(session.sessionId, { targetPath: tempRoot, tail: 20 });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.message, "status: remote accepted before local append");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session post-agent: refreshes locally expired status when remote session is active", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-post-agent-status-expired-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({
      targetPath: tempRoot,
      sessionId: "remote-status-expired-cache",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      ttlSeconds: 60,
    });
    const metadataPath = path.join(session.sessionDir, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    metadata.status = "expired";
    metadata.expiredAt = "2026-01-02T00:00:00.000Z";
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (options.method === "GET") {
        assert.ok(String(url).endsWith(`/api/v1/sessions/${session.sessionId}`));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session: {
              sessionId: session.sessionId,
              title: "remote still active",
              status: "active",
              archiveStatus: "active",
              expiresAt: "2027-01-02T00:00:00.000Z",
              lastInteractionAt: "2027-01-01T12:00:00.000Z",
            },
          }),
        };
      }
      return {
        ok: true,
        status: 202,
        text: async () => "",
        json: async () => ({}),
      };
    };

    const output = await runSessionCommand([
      "session",
      "post-agent",
      session.sessionId,
      "status: remote active despite stale local status",
      "--agent",
      "codex",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.remoteSync.synced, true);
    assert.equal(payload.refreshedLocalSession, true);
    assert.equal(calls.filter((call) => call.options.method === "GET").length, 1);
    assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);

    const refreshedMetadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    assert.equal(refreshedMetadata.status, "active");
    assert.equal(refreshedMetadata.expiredAt, null);
    assert.equal(refreshedMetadata.expiresAt, "2027-01-02T00:00:00.000Z");
    assert.equal(refreshedMetadata.title, "remote still active");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session join: refreshes expired local cache after remote verification", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-join-expired-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({
      targetPath: tempRoot,
      sessionId: "remote-join-expired-cache",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      ttlSeconds: 60,
      title: "stale local title",
    });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (options.method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session: {
              sessionId: session.sessionId,
              title: "remote title",
              status: "active",
              eventCount: 7217,
              agentCount: 5,
              lastInteractionAt: "2026-05-09T14:52:11.934Z",
            },
          }),
        };
      }
      return {
        ok: true,
        status: 202,
        text: async () => "",
        json: async () => ({}),
      };
    };

    const output = await runSessionCommand([
      "session",
      "join",
      session.sessionId,
      "--agent",
      "codex",
      "--model",
      "gpt-5",
      "--role",
      "coder",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.joined, true);
    assert.equal(payload.refreshedLocalSession, true);
    assert.equal(payload.title, "remote title");
    assert.ok(
      calls.some(
        (call) =>
          call.options.method === "GET" &&
          call.url.endsWith(`/api/v1/sessions/${session.sessionId}`),
      ),
    );
    assert.ok(calls.filter((call) => call.options.method === "POST").length >= 1);

    const events = await readStream(session.sessionId, { targetPath: tempRoot, tail: 20 });
    const joinEvent = events.find((event) => event.event === "agent_join");
    assert.ok(joinEvent);
    assert.equal(joinEvent.agent.id, "codex");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session post-agent: rejects human and placeholder identities before remote call", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-post-agent-human-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  let called = false;
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    globalThis.fetch = async () => {
      called = true;
      return { ok: true, status: 202 };
    };

    await assert.rejects(
      () =>
        runSessionCommand([
          "session",
          "post-agent",
          session.sessionId,
          "status: nope",
          "--agent",
          "human-mrrcarter",
          "--path",
          tempRoot,
        ]),
      /requires a granted non-human agent id/,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session read: --remote requires the same active auth surface as writes", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-read-remote-auth-"));
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
    SENTINELAYER_DISABLE_KEYRING: process.env.SENTINELAYER_DISABLE_KEYRING,
  };
  try {
    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    process.env.SENTINELAYER_DISABLE_KEYRING = "1";
    delete process.env.SENTINELAYER_TOKEN;
    delete process.env.SENTINELAYER_API_URL;

    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await assert.rejects(
      () =>
        runSessionCommand([
          "session",
          "read",
          session.sessionId,
          "--remote",
          "--path",
          tempRoot,
          "--json",
        ]),
      /Remote session read requires authentication/,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session read: --remote --json reports remote verification and tail provenance", async () => {
  resetSessionSyncStateForTests();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-read-remote-json-"));
  const restoreEnv = installAuthEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, sessionId: "remote-read-json", ttlSeconds: 120 });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const textUrl = String(url);
      if (textUrl.includes("/human-messages?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [], cursor: null }),
        };
      }
      if (textUrl.includes("/events/before?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              {
                event: "session_message",
                sessionId: session.sessionId,
                cursor: "1779364717000:000026d4",
                sequenceId: 9940,
                ts: "2026-05-21T12:20:00.000Z",
                agent: { id: "claude-mythos" },
                payload: { message: "remote verified tail" },
              },
            ],
          }),
        };
      }
      if (textUrl.includes("/events?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ events: [], cursor: null }),
        };
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      };
    };

    const output = await runSessionCommand([
      "session",
      "read",
      session.sessionId,
      "--remote",
      "--tail",
      "5",
      "--path",
      tempRoot,
      "--json",
    ]);

    const payload = JSON.parse(output);
    assert.equal(payload.displaySource, "remote_verified_tail");
    assert.equal(payload.remoteVerified, true);
    assert.equal(payload.remote.tailProbe.verified, true);
    assert.equal(payload.remote.tailProbe.appended, 1);
    assert.equal(payload.remote.tailProbe.displayedOnly, 0);
    assert.equal(payload.events[0].payload.message, "remote verified tail");
    assert.equal(payload.events[0].sequenceId, 9940);
    assert.equal(payload.events[0].cursor, "1779364717000:000026d4");
    assert.ok(calls.some((call) => String(call.url).includes("/events/before?limit=5")));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    resetSessionSyncStateForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
