import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { createAgentEvent, validateAgentEvent } from "../src/events/schema.js";
import {
  getSentiDaemon,
  runSentiHealthTick,
  startSenti,
  stopSenti,
} from "../src/session/daemon.js";
import { heartbeatAgent, registerAgent } from "../src/session/agent-registry.js";
import { createRuntimeRun } from "../src/session/runtime-bridge.js";
import { createSession, getSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-daemon-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

test("Unit session daemon: welcome event includes codebase synopsis and health tick detects stale + file conflict", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-daemon-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;

    const codex = await registerAgent(session.sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    const claude = await registerAgent(session.sessionId, {
      agentId: "claude-a1b2",
      model: "Claude 3.7 Sonnet",
      role: "reviewer",
      targetPath: tempRoot,
    });
    await heartbeatAgent(session.sessionId, codex.agentId, {
      status: "coding",
      file: "src/auth/login.js",
      detail: "Implementing auth",
      targetPath: tempRoot,
    });
    await heartbeatAgent(session.sessionId, claude.agentId, {
      status: "reviewing",
      file: "src/auth/login.js",
      detail: "Reviewing auth",
      targetPath: tempRoot,
    });

    const senti = await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
    });
    assert.equal(senti.isRunning(), true);
    assert.ok(getSentiDaemon(session.sessionId, { targetPath: tempRoot }));

    const staleNowIso = new Date(Date.parse(codex.lastActivityAt) + 95_000).toISOString();
    const summary = await runSentiHealthTick(session.sessionId, {
      targetPath: tempRoot,
      nowIso: staleNowIso,
      daemonState: null,
    });
    assert.equal(summary.activeAgentCount, 2);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const welcome = stream.find(
      (event) => event.event === "daemon_alert" && event.payload.alert === "senti_online"
    );
    assert.ok(welcome);
    assert.equal(validateAgentEvent(welcome, { allowLegacy: false }), true);
    assert.match(String(welcome.payload.message || ""), /Codebase:/);
    assert.match(String(welcome.payload.message || ""), /codex-c3d4/);
    assert.match(String(welcome.payload.message || ""), /claude-a1b2/);

    const staleDetected = stream.find(
      (event) => event.event === "daemon_alert" && event.payload.alert === "stuck_detected"
    );
    assert.ok(staleDetected);
    assert.equal(validateAgentEvent(staleDetected, { allowLegacy: false }), true);

    const conflictDetected = stream.find(
      (event) => event.event === "daemon_alert" && event.payload.alert === "file_conflict"
    );
    assert.ok(conflictDetected);
    assert.equal(conflictDetected.payload.file, "src/auth/login.js");
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon: unanswered help_request gets auto-response within timeout", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-help-"));
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
      helpRequestTimeoutMs: 40,
    });

    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "help_request",
        agentId: "codex-c3d4",
        sessionId: session.sessionId,
        requestId: "req-help-1",
        payload: {
          requestId: "req-help-1",
          message: "Need routing help for auth timeout.",
        },
      }),
      {
        targetPath: tempRoot,
      }
    );
    await sleep(350);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const response = stream.find((event) => event.event === "help_response");
    assert.ok(response);
    assert.equal(validateAgentEvent(response, { allowLegacy: false }), true);
    assert.equal(response.agent.id, "senti");
    assert.equal(response.payload.requestId, "req-help-1");
    assert.match(String(response.payload.response || ""), /help_request/i);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon: auto-renews session when expiry is near and activity is high", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-renew-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;
    const codex = await registerAgent(session.sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
    });

    for (let index = 0; index < 11; index += 1) {
      await appendToStream(
        session.sessionId,
        createAgentEvent({
          event: "agent_status",
          agentId: codex.agentId,
          sessionId: session.sessionId,
          payload: {
            status: "coding",
            index,
          },
          ts: new Date(Date.parse(session.createdAt) + (index + 1) * 1000).toISOString(),
        }),
        {
          targetPath: tempRoot,
        }
      );
    }

    const nearExpiryIso = new Date(Date.parse(session.createdAt) + 70_000).toISOString();
    const summary = await runSentiHealthTick(session.sessionId, {
      targetPath: tempRoot,
      nowIso: nearExpiryIso,
    });
    assert.ok(summary.renewed);

    const renewed = await getSession(session.sessionId, {
      targetPath: tempRoot,
    });
    assert.ok(renewed);
    assert.equal(renewed.renewalCount >= 1, true);
    assert.equal(Date.parse(renewed.expiresAt) > Date.parse(session.expiresAt), true);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon: kill switch stops senti and abandons runtime run with manual_stop", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-kill-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;
    await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
    });
    const runtimeRun = await createRuntimeRun({
      sessionId: session.sessionId,
      workItemId: "work-item-1",
      targetPath: tempRoot,
      scopeEnvelope: {
        allowed_tools: ["file_read", "grep"],
        allowed_paths: ["src/**"],
        denied_paths: ["secrets/**"],
      },
      budgetEnvelope: {
        max_tokens: 100,
        max_cost_usd: 1,
        max_runtime_minutes: 10,
        max_tool_calls: 50,
        network_domain_allowlist: ["api.sentinelayer.com"],
      },
    });
    assert.equal(runtimeRun.running, true);

    const stopped = await stopSenti(session.sessionId, {
      targetPath: tempRoot,
      reason: "operator_kill",
    });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.runtimeStopSummary.stoppedCount, 1);

    const stream = await readStream(session.sessionId, { tail: 30, targetPath: tempRoot });
    const runtimeStop = stream.find((event) => event.event === "runtime_run_stop");
    assert.ok(runtimeStop);
    assert.equal(runtimeStop.payload.stopClass, "manual_stop");
    assert.equal(validateAgentEvent(runtimeStop, { allowLegacy: false }), true);

    const killed = stream.find(
      (event) => event.event === "agent_killed" && event.agent.id === "senti"
    );
    assert.ok(killed);
    assert.equal(validateAgentEvent(killed, { allowLegacy: false }), true);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
