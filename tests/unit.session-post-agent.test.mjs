import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
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
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => "",
      json: async () => ({}),
    });

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

    const events = await readStream(session.sessionId, { targetPath: tempRoot, tail: 20 });
    assert.equal(events.some((event) => event.event === "session_message"), false);
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
