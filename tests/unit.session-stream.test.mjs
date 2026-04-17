import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { validateAgentEvent } from "../src/events/schema.js";
import { createSession, expireSession, renewSession } from "../src/session/store.js";
import { appendToStream, readStream, tailStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-stream-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const value = 1;\n", "utf-8");
}

test("Unit session stream: append and read events preserves canonical envelope", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-stream-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const appended = await appendToStream(
      session.sessionId,
      {
        event: "agent_join",
        agentId: "codex-a1b2",
        payload: { role: "coder" },
      },
      { targetPath: tempRoot }
    );
    assert.equal(appended.stream, "sl_event");
    assert.equal(appended.sessionId, session.sessionId);
    assert.equal(validateAgentEvent(appended, { allowLegacy: false }), true);

    const events = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "agent_join");
    assert.equal(events[0].payload.role, "coder");
    assert.equal(events[0].sessionId, session.sessionId);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session stream: concurrent append from 3 workers writes corruption-free NDJSON", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-concurrent-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const workers = Array.from({ length: 3 }, (_, workerIndex) =>
      (async () => {
        for (let i = 0; i < 30; i += 1) {
          await appendToStream(
            session.sessionId,
            {
              event: "heartbeat",
              agentId: `codex-worker-${workerIndex}`,
              payload: { workerIndex, iteration: i },
            },
            { targetPath: tempRoot }
          );
        }
      })()
    );
    await Promise.all(workers);

    const events = await readStream(session.sessionId, { tail: 0, targetPath: tempRoot });
    assert.equal(events.length, 90);
    for (const event of events) {
      assert.equal(validateAgentEvent(event, { allowLegacy: false }), true);
    }

    const raw = await readFile(path.join(session.sessionDir, "stream.ndjson"), "utf-8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    assert.equal(lines.length, 90);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session stream: tail emits new events within 1 second", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-tail-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const controller = new AbortController();

    const firstEventPromise = (async () => {
      for await (const event of tailStream(session.sessionId, {
        targetPath: tempRoot,
        pollMs: 100,
        signal: controller.signal,
      })) {
        return event;
      }
      return null;
    })();

    await sleep(100);
    await appendToStream(
      session.sessionId,
      {
        event: "agent_status",
        agentId: "senti",
        payload: { state: "watching" },
      },
      { targetPath: tempRoot }
    );

    const timeoutPromise = sleep(1000).then(() => {
      throw new Error("tailStream did not emit in time.");
    });
    const emitted = await Promise.race([firstEventPromise, timeoutPromise]);
    controller.abort();
    assert.ok(emitted);
    assert.equal(emitted.event, "agent_status");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session stream: expired session blocks writes, renew re-enables writes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-expired-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 60 });

    await expireSession(session.sessionId, { targetPath: tempRoot });
    await assert.rejects(
      () =>
        appendToStream(
          session.sessionId,
          {
            event: "agent_status",
            agentId: "senti",
            payload: { state: "blocked" },
          },
          { targetPath: tempRoot }
        ),
      /expired/
    );

    await renewSession(session.sessionId, { targetPath: tempRoot });
    const appended = await appendToStream(
      session.sessionId,
      {
        event: "agent_status",
        agentId: "senti",
        payload: { state: "resumed" },
      },
      { targetPath: tempRoot }
    );
    assert.equal(appended.payload.state, "resumed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
