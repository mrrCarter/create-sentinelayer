import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { eventMatchesAgent } from "../src/session/listener.js";
import { createSession, getSession } from "../src/session/store.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "stop-listener-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
}

function parseStream(content = "") {
  return String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runSessionCommand(args = []) {
  const program = new Command();
  program.name("sl").exitOverride();
  registerSessionCommand(program);
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

test("Unit stop-listener: a targeted listener_stop routes only to that agent", () => {
  const targeted = { event: "listener_stop", payload: { targetAgentId: "api-01" } };
  assert.equal(eventMatchesAgent(targeted, "api-01"), true);
  assert.equal(eventMatchesAgent(targeted, "ui-01"), false);
});

test("Unit stop-listener: a broadcast listener_stop reaches every listener", () => {
  const broadcast = { event: "listener_stop", payload: { broadcast: true, reason: "operator_stop" } };
  assert.equal(eventMatchesAgent(broadcast, "api-01"), true);
  assert.equal(eventMatchesAgent(broadcast, "ui-01"), true);
});

test("Unit stop-listener: command enqueues a targeted ephemeral control only", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-stop-listener-"));
  const originalFetch = globalThis.fetch;
  const previousEnv = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
  };
  const requests = [];
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });
    delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    process.env.SENTINELAYER_TOKEN = "tok_stop_listener_unit";
    process.env.SENTINELAYER_API_URL = "https://api.sentinelayer.com";
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (
        options.method === "POST" &&
        String(url).endsWith(`/api/v1/sessions/${session.sessionId}/listener-controls/stop`)
      ) {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            recorded: true,
            control: {
              controlId: "control-targeted",
              type: "stop",
              issuedAt: "2026-07-31T05:30:00.000Z",
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const output = await runSessionCommand([
      "session",
      "stop-listener",
      session.sessionId,
      "--agent",
      "api-01",
      "--path",
      tempRoot,
      "--json",
    ]);

    const persisted = await getSession(session.sessionId, { targetPath: tempRoot });
    const events = parseStream(await readFile(persisted.streamPath, "utf-8"));
    assert.equal(events.some((event) => event.event === "listener_stop"), false);
    const stopRequests = requests.filter((request) =>
      request.url.endsWith(`/api/v1/sessions/${session.sessionId}/listener-controls/stop`)
    );
    assert.equal(stopRequests.length, 1);
    assert.deepEqual(
      JSON.parse(stopRequests[0].options.body),
      { targetAgentId: "api-01" },
    );
    assert.match(
      stopRequests[0].options.headers["Idempotency-Key"],
      /^sl-listener-stop-[0-9a-f-]{36}$/i,
    );
    assert.equal(requests.some((request) => request.url.endsWith("/events")), false);
    const payload = JSON.parse(output);
    assert.equal(payload.listenerControl.control.controlId, "control-targeted");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit stop-listener: omitting --agent enqueues an ephemeral broadcast only", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-stop-listener-all-"));
  const originalFetch = globalThis.fetch;
  const previousEnv = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
  };
  const requests = [];
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });
    delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    process.env.SENTINELAYER_TOKEN = "tok_stop_listener_unit";
    process.env.SENTINELAYER_API_URL = "https://api.sentinelayer.com";
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (
        options.method === "POST" &&
        String(url).endsWith(`/api/v1/sessions/${session.sessionId}/listener-controls/stop`)
      ) {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            recorded: true,
            control: {
              controlId: "control-broadcast",
              type: "stop",
              issuedAt: "2026-07-31T05:30:00.000Z",
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await runSessionCommand([
      "session",
      "stop-listener",
      session.sessionId,
      "--path",
      tempRoot,
    ]);
    const persisted = await getSession(session.sessionId, { targetPath: tempRoot });
    const events = parseStream(await readFile(persisted.streamPath, "utf-8"));
    assert.equal(events.some((event) => event.event === "listener_stop"), false);
    const stopRequests = requests.filter((request) =>
      request.url.endsWith(`/api/v1/sessions/${session.sessionId}/listener-controls/stop`)
    );
    assert.equal(stopRequests.length, 1);
    const body = JSON.parse(stopRequests[0].options.body);
    assert.equal(body.broadcast, true);
    assert.equal("targetAgentId" in body, false);
    assert.match(
      stopRequests[0].options.headers["Idempotency-Key"],
      /^sl-listener-stop-[0-9a-f-]{36}$/i,
    );
    assert.equal(requests.some((request) => request.url.endsWith("/events")), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
