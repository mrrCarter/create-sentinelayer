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

async function waitForStreamEvent(sessionId, predicate, {
  targetPath,
  tail = 50,
  timeoutMs = 1500,
  pollMs = 25,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const stream = await readStream(sessionId, { tail, targetPath });
    const event = stream.find(predicate);
    if (event) {
      return event;
    }
    await sleep(pollMs);
  }
  return null;
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

test("Unit session daemon: health tick requests durable checkpoints with cadence", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-checkpoint-daemon-"));
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
    const startedAt = "2026-05-24T00:00:30.000Z";
    const baseEpoch = Date.parse("2026-05-24T00:00:00.000Z");
    for (let index = 0; index < 20; index += 1) {
      await appendToStream(
        session.sessionId,
        createAgentEvent({
          event: "session_message",
          agentId: "codex-c3d4",
          sessionId: session.sessionId,
          ts: new Date(baseEpoch + (index + 1) * 1000).toISOString(),
          payload: {
            message: `checkpoint source event ${index + 1}`,
          },
        }),
        { targetPath: tempRoot },
      );
    }

    const calls = [];
    const checkpointGenerator = async (generatedSessionId, options) => {
      calls.push({ generatedSessionId, options });
      return {
        ok: true,
        created: true,
        duplicate: false,
        checkpointId: "cp_auto_daemon",
        checkpoint: { checkpointId: "cp_auto_daemon" },
        eventCount: 24,
      };
    };
    const senti = await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
      checkpointGenerator,
      checkpointIntervalMs: 60_000,
      checkpointMinEvents: 20,
      checkpointMaxEvents: 80,
      checkpointEventThreshold: 20,
    });

    const first = await senti.runTick(startedAt);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].generatedSessionId, session.sessionId);
    assert.equal(calls[0].options.targetPath, tempRoot);
    assert.equal(calls[0].options.minEvents, 20);
    assert.equal(calls[0].options.maxEvents, 80);
    assert.equal(calls[0].options.createdByAgentId, "senti");
    assert.equal(first.checkpoint.attempted, true);
    assert.equal(first.checkpoint.created, true);
    assert.equal(first.checkpoint.checkpointId, "cp_auto_daemon");
    assert.equal(first.checkpoint.trigger, "event_threshold");
    assert.equal(first.checkpoint.sourceEventCount, 20);

    for (let index = 0; index < 20; index += 1) {
      await appendToStream(
        session.sessionId,
        createAgentEvent({
          event: "session_message",
          agentId: "codex-c3d4",
          sessionId: session.sessionId,
          ts: new Date(baseEpoch + (31 + index) * 1000).toISOString(),
          payload: {
            message: `next checkpoint source event ${index + 1}`,
          },
        }),
        { targetPath: tempRoot },
      );
    }

    const second = await senti.runTick("2026-05-24T00:00:55.000Z");
    assert.equal(calls.length, 1);
    assert.equal(second.checkpoint.attempted, false);
    assert.equal(second.checkpoint.reason, "checkpoint_cadence_wait");

    const third = await senti.runTick("2026-05-24T00:01:31.000Z");
    assert.equal(calls.length, 2);
    assert.equal(third.checkpoint.created, true);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon: checkpoint policy triggers on inactivity after meaningful source event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-checkpoint-idle-"));
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
    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex-c3d4",
        sessionId: session.sessionId,
        ts: "2026-05-24T00:00:00.000Z",
        payload: {
          message: "single source event should checkpoint after idle",
        },
      }),
      { targetPath: tempRoot },
    );

    const calls = [];
    const checkpointGenerator = async (generatedSessionId, options) => {
      calls.push({ generatedSessionId, options });
      return {
        ok: true,
        created: true,
        duplicate: false,
        checkpointId: "cp_idle_daemon",
        checkpoint: { checkpointId: "cp_idle_daemon" },
        eventCount: 1,
      };
    };
    const senti = await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
      checkpointGenerator,
      checkpointIntervalMs: 1,
      checkpointEventThreshold: 5,
      checkpointIdleMs: 1_000,
    });

    const first = await senti.runTick("2026-05-24T00:00:00.500Z");
    assert.equal(calls.length, 0);
    assert.equal(first.checkpoint.reason, "checkpoint_event_count_wait");
    assert.equal(first.checkpoint.policy.sourceEventCount, 1);

    const second = await senti.runTick("2026-05-24T00:00:01.500Z");
    assert.equal(calls.length, 1);
    assert.equal(second.checkpoint.attempted, true);
    assert.equal(second.checkpoint.trigger, "inactivity");
    assert.equal(second.checkpoint.sourceEventCount, 1);
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon: stop performs closeout checkpoint for uncheckpointed source events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-checkpoint-closeout-"));
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
    const calls = [];
    const checkpointGenerator = async (generatedSessionId, options) => {
      calls.push({ generatedSessionId, options });
      return {
        ok: true,
        created: true,
        duplicate: false,
        checkpointId: "cp_closeout_daemon",
        checkpoint: { checkpointId: "cp_closeout_daemon" },
        eventCount: 1,
      };
    };
    await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
      checkpointGenerator,
      checkpointEventThreshold: 20,
      checkpointIdleMs: 600_000,
    });
    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex-c3d4",
        sessionId: session.sessionId,
        ts: "2026-05-24T00:00:00.000Z",
        payload: {
          message: "closeout should checkpoint this unfinished handoff",
        },
      }),
      { targetPath: tempRoot },
    );

    const stopped = await stopSenti(session.sessionId, {
      targetPath: tempRoot,
      reason: "operator_closeout",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].generatedSessionId, session.sessionId);
    assert.equal(calls[0].options.createdByAgentId, "senti");
    assert.equal(stopped.checkpointCloseout.attempted, true);
    assert.equal(stopped.checkpointCloseout.trigger, "closeout");
    assert.equal(stopped.checkpointCloseout.checkpointId, "cp_closeout_daemon");
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon: checkpoint generator failure is non-blocking", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-checkpoint-failure-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;
    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex-c3d4",
        sessionId: session.sessionId,
        payload: {
          message: "source event for failed checkpoint generation",
        },
      }),
      { targetPath: tempRoot },
    );
    const senti = await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
      checkpointGenerator: async () => {
        throw new Error("checkpoint api down");
      },
      checkpointIntervalMs: 1,
      checkpointEventThreshold: 1,
    });

    const summary = await senti.runTick(new Date().toISOString());
    assert.equal(senti.isRunning(), true);
    assert.equal(summary.checkpoint.attempted, true);
    assert.equal(summary.checkpoint.ok, false);
    assert.equal(summary.checkpoint.created, false);
    assert.equal(summary.checkpoint.reason, "checkpoint api down");
  } finally {
    if (sessionId) {
      await stopSenti(sessionId, { targetPath: tempRoot }).catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session daemon: health tick hydrates remote durable agent events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-daemon-remote-"));
  let sessionId = "";
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    sessionId = session.sessionId;
    let hydrated = false;
    const remoteHydrator = async ({ sessionId: hydrateSessionId, targetPath }) => {
      if (!hydrated) {
        hydrated = true;
        await appendToStream(
          hydrateSessionId,
          createAgentEvent({
            event: "session_message",
            agentId: "claude-remote",
            agentModel: "Claude 3.7 Sonnet",
            sessionId: hydrateSessionId,
            payload: {
              message: "Remote durable agent update for recap and checkpoint context.",
            },
          }),
          { targetPath, syncRemote: false }
        );
        return {
          ok: true,
          relayed: 1,
          humanRelayed: 0,
          eventsRelayed: 1,
          eventsCursor: "event-cursor-1",
          eventsBackfillComplete: true,
          eventsPageCount: 1,
          localAppendComplete: true,
          dropped: 0,
          cursor: null,
        };
      }
      return {
        ok: true,
        relayed: 0,
        humanRelayed: 0,
        eventsRelayed: 0,
        eventsCursor: "event-cursor-1",
        eventsBackfillComplete: true,
        eventsPageCount: 1,
        localAppendComplete: true,
        dropped: 0,
        cursor: null,
      };
    };

    const senti = await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
      remoteHydrator,
    });
    const summary = await senti.runTick(new Date(Date.parse(session.createdAt) + 5_000).toISOString());

    assert.equal(summary.humanMessages.relayed, 1);
    assert.equal(summary.humanMessages.sessionEventsRelayed, 1);
    assert.equal(summary.humanMessages.sessionEventsCursor, "event-cursor-1");
    assert.equal(senti.getState().sessionEventsCursor, "event-cursor-1");

    const stream = await readStream(session.sessionId, { tail: 30, targetPath: tempRoot });
    const remoteEvent = stream.find(
      (event) => event.event === "session_message" && event.agent?.id === "claude-remote"
    );
    assert.ok(remoteEvent);
    assert.match(String(remoteEvent.payload?.message || ""), /Remote durable agent update/);
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
    const response = await waitForStreamEvent(
      session.sessionId,
      (event) => event.event === "help_response" && event.payload?.requestId === "req-help-1",
      { targetPath: tempRoot }
    );
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

test("Unit session daemon: lock/unlock directives from session messages enforce exclusive file ownership", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-lock-directives-"));
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
    await registerAgent(session.sessionId, {
      agentId: "claude-a1b2",
      model: "Claude 3.7 Sonnet",
      role: "reviewer",
      targetPath: tempRoot,
    });
    await startSenti(session.sessionId, {
      targetPath: tempRoot,
      autoStart: false,
    });

    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex-c3d4",
        sessionId: session.sessionId,
        payload: {
          message: "lock: src/routes/auth.js — implementing JWT middleware",
        },
      }),
      { targetPath: tempRoot }
    );
    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "claude-a1b2",
        sessionId: session.sessionId,
        payload: {
          message: "lock: src/routes/auth.js — reviewing auth route",
        },
      }),
      { targetPath: tempRoot }
    );
    const lockEvent = await waitForStreamEvent(
      session.sessionId,
      (event) => event.event === "file_lock" && event.payload?.file === "src/routes/auth.js",
      { targetPath: tempRoot }
    );
    assert.ok(lockEvent);
    assert.equal(lockEvent.agent.id, "codex-c3d4");
    assert.equal(lockEvent.payload.file, "src/routes/auth.js");

    const denied = await waitForStreamEvent(
      session.sessionId,
      (event) => event.event === "daemon_alert" && event.payload?.alert === "file_lock_denied",
      { targetPath: tempRoot }
    );
    assert.ok(denied);
    assert.equal(denied.payload.file, "src/routes/auth.js");
    assert.equal(denied.payload.heldBy, "codex-c3d4");

    await appendToStream(
      session.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex-c3d4",
        sessionId: session.sessionId,
        payload: {
          message: "unlock: src/routes/auth.js — done",
        },
      }),
      { targetPath: tempRoot }
    );
    const unlockEvent = await waitForStreamEvent(
      session.sessionId,
      (event) => event.event === "file_unlock" && event.payload?.file === "src/routes/auth.js",
      { targetPath: tempRoot }
    );
    assert.ok(unlockEvent);
    assert.equal(unlockEvent.payload.file, "src/routes/auth.js");
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
