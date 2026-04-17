import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { validateAgentEvent } from "../src/events/schema.js";
import { createSession, getSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-provision-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
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
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

async function startMockAidenIdServer({ delayMs = 45 } = {}) {
  let requestCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const receivedBodies = [];

  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/identities") {
      const identityNumber = requestCount + 1;
      requestCount = identityNumber;
      inFlight += 1;
      if (inFlight > maxInFlight) {
        maxInFlight = inFlight;
      }

      let rawBody = "";
      for await (const chunk of req) {
        rawBody += String(chunk);
      }
      try {
        receivedBodies.push(JSON.parse(rawBody));
      } catch {
        receivedBodies.push({});
      }

      await sleep(delayMs);
      inFlight -= 1;

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `identity-${identityNumber}`,
          emailAddress: `session-${identityNumber}@example.test`,
          status: "ACTIVE",
          expiresAt: "2026-04-20T00:00:00.000Z",
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not-found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = Number(address?.port || 0);
  const apiUrl = `http://127.0.0.1:${port}`;

  return {
    apiUrl,
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
    stats: () => ({
      requestCount,
      maxInFlight,
      receivedBodies: [...receivedBodies],
    }),
  };
}

test("Unit session provision command: provisions identities in parallel and persists session shared resources", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-provision-"));
  const mockServer = await startMockAidenIdServer();
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const program = createSessionProgram();

    const logs = await withCapturedConsole(async () => {
      await program.parseAsync(
        [
          "session",
          "provision-emails",
          session.sessionId,
          "--count",
          "5",
          "--concurrency",
          "5",
          "--tags",
          "session,swarm",
          "--path",
          tempRoot,
          "--api-url",
          mockServer.apiUrl,
          "--api-key",
          "test-key",
          "--org-id",
          "org_123",
          "--project-id",
          "project_456",
          "--json",
        ],
        { from: "user" }
      );
    });

    assert.equal(logs.length > 0, true);
    const payload = JSON.parse(logs[logs.length - 1]);
    assert.equal(payload.command, "session provision-emails");
    assert.equal(payload.execute, true);
    assert.equal(payload.requestedCount, 5);
    assert.equal(payload.provisionedCount, 5);
    assert.equal(Array.isArray(payload.identities), true);
    assert.equal(payload.identities.length, 5);
    assert.equal(payload.sharedResources.provisionedIdentityIds.length, 5);

    const stats = mockServer.stats();
    assert.equal(stats.requestCount, 5);
    assert.equal(stats.maxInFlight > 1, true);
    assert.equal(stats.maxInFlight <= 5, true);
    assert.equal(
      stats.receivedBodies.every((body) => Array.isArray(body.tags) && body.tags.includes("session")),
      true
    );

    const refreshedSession = await getSession(session.sessionId, { targetPath: tempRoot });
    assert.ok(refreshedSession);
    assert.equal(refreshedSession.sharedResources.provisionedIdentityIds.length, 5);
    assert.equal(refreshedSession.sharedResources.provisionCount, 5);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const provisionEvent = stream.find((event) => event.event === "session_provision_emails");
    assert.ok(provisionEvent);
    assert.equal(validateAgentEvent(provisionEvent, { allowLegacy: false }), true);
    assert.equal(provisionEvent.payload.provisionedCount, 5);

    const registryPath = path.join(String(payload.outputRoot || ""), "aidenid", "identity-registry.json");
    const registryPayload = JSON.parse(await readFile(registryPath, "utf-8"));
    assert.equal(Array.isArray(registryPayload.identities), true);
    assert.equal(registryPayload.identities.length >= 5, true);
  } finally {
    await mockServer.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});
