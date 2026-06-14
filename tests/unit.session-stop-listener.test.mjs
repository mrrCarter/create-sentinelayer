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

test("Unit stop-listener: command emits a targeted directive into the stream", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-stop-listener-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });
    await runSessionCommand([
      "session",
      "stop-listener",
      session.sessionId,
      "--agent",
      "api-01",
      "--path",
      tempRoot,
    ]);

    const persisted = await getSession(session.sessionId, { targetPath: tempRoot });
    const events = parseStream(await readFile(persisted.streamPath, "utf-8"));
    const stop = events.find((e) => e.event === "listener_stop");
    assert.ok(stop, "expected a listener_stop event");
    assert.equal(stop.payload.targetAgentId, "api-01");
    assert.equal(stop.payload.reason, "operator_stop");
    // And that targeted event matches only api-01.
    assert.equal(eventMatchesAgent(stop, "api-01"), true);
    assert.equal(eventMatchesAgent(stop, "ui-01"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit stop-listener: omitting --agent broadcasts to all", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-stop-listener-all-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });
    await runSessionCommand(["session", "stop-listener", session.sessionId, "--path", tempRoot]);
    const persisted = await getSession(session.sessionId, { targetPath: tempRoot });
    const events = parseStream(await readFile(persisted.streamPath, "utf-8"));
    const stop = events.find((e) => e.event === "listener_stop");
    assert.ok(stop);
    assert.equal(stop.payload.broadcast, true);
    assert.equal(eventMatchesAgent(stop, "any-agent"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
