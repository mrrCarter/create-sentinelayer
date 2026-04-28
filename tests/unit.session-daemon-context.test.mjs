import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { createAgentEvent, validateAgentEvent } from "../src/events/schema.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { startSenti, stopSenti } from "../src/session/daemon.js";
import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-daemon-context-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

async function waitForStreamEvents(
  sessionId,
  targetPath,
  predicate,
  { timeoutMs = 3000, pollMs = 40 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readStream(sessionId, { tail: 50, targetPath });
    if (predicate(events)) {
      return events;
    }
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for session daemon context events.");
}

test("Unit session daemon context relay: unanswered help_request emits help_response and model_span in under 5s", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-context-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;
    await registerAgent(session.sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });

    await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
      helpRequestTimeoutMs: 25,
      llmInvoker: async () => {
        await sleep(30);
        return {
          text: "Route to src/auth/login.js and inspect token verification timeout.",
          usage: {
            inputTokens: 120,
            outputTokens: 18,
            costUsd: 0.0008,
            model: "gpt-5.4-mini",
            provider: "sentinelayer",
            latencyMs: 30,
          },
        };
      },
    });

    const requestEvent = await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "help_request",
        agentId: "codex-c3d4",
        sessionId: session.sessionId,
        requestId: "req-context-1",
        payload: {
          requestId: "req-context-1",
          message: "Auth login times out; where should I inspect first?",
        },
      }),
      {
        targetPath: tempRoot,
      }
    );

    const stream = await waitForStreamEvents(
      session.sessionId,
      tempRoot,
      (events) =>
        events.some(
          (event) => event.event === "help_response" && event.payload?.requestId === "req-context-1"
        ) &&
        events.some((event) => event.event === "model_span" && event.payload?.requestId === "req-context-1")
    );
    const response = stream.find(
      (event) => event.event === "help_response" && event.payload?.requestId === "req-context-1"
    );
    const modelSpan = stream.find(
      (event) => event.event === "model_span" && event.payload?.requestId === "req-context-1"
    );

    assert.ok(response);
    assert.ok(modelSpan);
    assert.equal(validateAgentEvent(response, { allowLegacy: false }), true);
    assert.equal(validateAgentEvent(modelSpan, { allowLegacy: false }), true);
    assert.equal(response.payload.requestId, "req-context-1");
    assert.match(String(response.payload.response || ""), /src\/auth\/login\.js/i);
    assert.equal(Number(response.payload?.contextSignals?.documentCount || 0) > 0, true);

    const requestEpoch = Date.parse(String(requestEvent.ts || ""));
    const responseEpoch = Date.parse(String(response.ts || ""));
    assert.equal(Number.isFinite(requestEpoch), true);
    assert.equal(Number.isFinite(responseEpoch), true);
    assert.equal(responseEpoch - requestEpoch < 5_000, true);

    assert.equal(modelSpan.payload.requestId, "req-context-1");
    assert.equal(modelSpan.payload.fallbackPath, false);
    assert.equal(modelSpan.payload.inputTokens, 120);
    assert.equal(modelSpan.payload.outputTokens, 18);
    assert.equal(modelSpan.payload.costUsd, 0.0008);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon context relay: LLM failure emits fallback response with model_span fallback_path", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-context-fallback-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;
    await registerAgent(session.sessionId, {
      agentId: "claude-a1b2",
      model: "gpt-5.4",
      role: "reviewer",
      targetPath: tempRoot,
    });

    await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
      helpRequestTimeoutMs: 25,
      llmInvoker: async () => {
        throw new Error("simulated upstream failure");
      },
    });

    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "help_request",
        agentId: "claude-a1b2",
        sessionId: session.sessionId,
        requestId: "req-context-2",
        payload: {
          requestId: "req-context-2",
          message: "Need quick routing help for retry path.",
        },
      }),
      {
        targetPath: tempRoot,
      }
    );

    const stream = await waitForStreamEvents(
      session.sessionId,
      tempRoot,
      (events) =>
        events.some(
          (event) => event.event === "help_response" && event.payload?.requestId === "req-context-2"
        ) &&
        events.some((event) => event.event === "model_span" && event.payload?.requestId === "req-context-2")
    );
    const response = stream.find(
      (event) => event.event === "help_response" && event.payload?.requestId === "req-context-2"
    );
    const modelSpan = stream.find(
      (event) => event.event === "model_span" && event.payload?.requestId === "req-context-2"
    );

    assert.ok(response);
    assert.ok(modelSpan);
    assert.equal(validateAgentEvent(response, { allowLegacy: false }), true);
    assert.equal(validateAgentEvent(modelSpan, { allowLegacy: false }), true);
    assert.match(String(response.payload.response || ""), /help_request/i);
    assert.equal(modelSpan.payload.fallbackPath, true);
    assert.match(String(modelSpan.payload.fallbackReason || ""), /failure|timeout|failed/i);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
