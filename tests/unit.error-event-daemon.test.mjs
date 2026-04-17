import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  WAKE_MODES,
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
  scheduledErrorSweep,
  startErrorEventDaemon,
  stopErrorEventDaemon,
} from "../src/daemon/error-worker.js";
import { validateAgentEvent } from "../src/events/schema.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "error-event-daemon-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

test("Unit error event daemon: dedup collapses 3 identical events and emits canonical intake envelopes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-error-daemon-dedup-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    for (const requestId of ["req_1", "req_2", "req_3"]) {
      await appendAdminErrorEvent({
        targetPath: tempRoot,
        event: {
          source: "admin_error_log",
          service: "sentinelayer-api",
          endpoint: "/v1/runtime/runs",
          errorCode: "RUNTIME_TIMEOUT",
          severity: "P1",
          message: "Runtime timed out",
          stackTrace: "TimeoutError: upstream timeout at runtime_run_service.py:112",
          commitSha: "abc123",
          requestId,
        },
      });
    }

    const execution = await runErrorDaemonWorker({
      targetPath: tempRoot,
      maxEvents: 50,
      sessionId: session.sessionId,
      wakeMode: WAKE_MODES.REALTIME,
    });
    assert.equal(execution.processedCount, 3);
    assert.equal(execution.queuedCount, 1);
    assert.equal(execution.dedupedCount, 2);
    assert.equal(execution.queueDepth, 1);
    assert.equal(execution.intakeArtifacts.length, 3);
    assert.equal(execution.emittedEvents.length, 3);

    const listed = await listErrorQueue({ targetPath: tempRoot, limit: 10 });
    assert.equal(listed.items.length, 1);
    const workItem = listed.items[0];
    assert.equal(workItem.occurrenceCount, 3);
    assert.equal(workItem.commitSha, "abc123");
    assert.equal(workItem.requestIds.length, 3);
    assert.equal(workItem.dedupKey.includes("sentinelayer-api|/v1/runtime/runs|runtime_timeout|"), true);

    const intakePayload = JSON.parse(await readFile(execution.intakeArtifacts[0].intakePath, "utf-8"));
    assert.equal(intakePayload.work_item_id, workItem.workItemId);
    assert.equal(intakePayload.occurrence_count, 3);
    assert.equal(Array.isArray(intakePayload.request_ids), true);
    assert.equal(intakePayload.request_ids.length, 3);
    assert.equal(intakePayload.dedup_key, workItem.dedupKey);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const intakeEvents = stream.filter((event) => event.event === "agent_intake");
    assert.equal(intakeEvents.length, 3);
    for (const intakeEvent of intakeEvents) {
      assert.equal(validateAgentEvent(intakeEvent, { allowLegacy: false }), true);
      assert.equal(intakeEvent.sessionId, session.sessionId);
      assert.equal(intakeEvent.agent.id, "error-daemon");
      assert.equal(intakeEvent.payload.wakeMode, WAKE_MODES.REALTIME);
      assert.equal(intakeEvent.payload.workItemId, workItem.workItemId);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit error event daemon: different commit_sha values create distinct work items", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-error-daemon-commit-"));
  try {
    await seedWorkspace(tempRoot);
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        service: "sentinelayer-api",
        endpoint: "/v1/auth/login",
        errorCode: "AUTH_REDIS_DOWN",
        severity: "P1",
        message: "Redis unavailable",
        stackTrace: "ConnectionError: redis unavailable at auth_service.py:45",
        commitSha: "aaa111",
      },
    });
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        service: "sentinelayer-api",
        endpoint: "/v1/auth/login",
        errorCode: "AUTH_REDIS_DOWN",
        severity: "P1",
        message: "Redis unavailable",
        stackTrace: "ConnectionError: redis unavailable at auth_service.py:45",
        commitSha: "bbb222",
      },
    });

    const execution = await runErrorDaemonWorker({
      targetPath: tempRoot,
      maxEvents: 50,
    });
    assert.equal(execution.queuedCount, 2);
    assert.equal(execution.dedupedCount, 0);

    const listed = await listErrorQueue({ targetPath: tempRoot, limit: 10 });
    assert.equal(listed.items.length, 2);
    const dedupKeys = new Set(listed.items.map((item) => item.dedupKey));
    assert.equal(dedupKeys.size, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit error event daemon: scheduled sweep creates backlog rollup and optional intake event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-error-daemon-sweep-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        service: "sentinelayer-api",
        endpoint: "/v1/runtime/runs",
        errorCode: "RUNTIME_TIMEOUT",
        severity: "P1",
        message: "Runtime timed out",
      },
    });
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        service: "sentinelayer-web",
        endpoint: "/dashboard/sessions/sess-1",
        errorCode: "SSE_DISCONNECT",
        severity: "P2",
        message: "Dashboard stream disconnected",
      },
    });
    await runErrorDaemonWorker({ targetPath: tempRoot, maxEvents: 50 });

    const sweep = await scheduledErrorSweep({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      region: "us-east-1",
      tz: "America/New_York",
    });
    assert.equal(sweep.queueDepth, 2);
    assert.equal(sweep.totalOccurrences, 2);
    assert.equal(sweep.severityCounts.P1, 1);
    assert.equal(sweep.severityCounts.P2, 1);
    assert.equal(sweep.digest.runId, sweep.runId);
    assert.equal(sweep.digest.region, "us-east-1");
    assert.equal(sweep.digest.tz, "America/New_York");

    const persistedSweep = JSON.parse(await readFile(sweep.sweepPath, "utf-8"));
    assert.equal(persistedSweep.queueDepth, 2);
    assert.equal(persistedSweep.totalOccurrences, 2);

    const stream = await readStream(session.sessionId, { tail: 10, targetPath: tempRoot });
    const rollupEvent = stream.find(
      (event) => event.event === "agent_intake" && event.payload.action === "scheduled_rollup"
    );
    assert.ok(rollupEvent);
    assert.equal(validateAgentEvent(rollupEvent, { allowLegacy: false }), true);
    assert.equal(rollupEvent.payload.queueDepth, 2);
    assert.equal(rollupEvent.payload.region, "us-east-1");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit error event daemon: kill switch terminates daemon cleanly", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-error-daemon-kill-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const daemon = await startErrorEventDaemon({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      wakeMode: WAKE_MODES.REALTIME,
      autoStart: false,
      pollMs: 100,
    });

    assert.equal(daemon.isRunning(), true);
    await daemon.runTick();

    const killed = await stopErrorEventDaemon({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      reason: "operator_kill",
    });
    assert.equal(killed.stopped, true);
    assert.equal(killed.count, 1);
    assert.equal(daemon.isRunning(), false);

    const stream = await readStream(session.sessionId, { tail: 10, targetPath: tempRoot });
    const killEvent = stream.find((event) => event.event === "agent_killed");
    assert.ok(killEvent);
    assert.equal(validateAgentEvent(killEvent, { allowLegacy: false }), true);
    assert.equal(killEvent.agent.id, "error-daemon");
    assert.equal(killEvent.payload.reason, "operator_kill");

    const secondStop = await stopErrorEventDaemon({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      reason: "operator_kill",
    });
    assert.equal(secondStop.stopped, false);
    assert.equal(secondStop.count, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit error event daemon: start reuses active daemon key and stop supports wake-mode filters", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-error-daemon-reuse-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const daemonA = await startErrorEventDaemon({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      wakeMode: WAKE_MODES.REALTIME,
      autoStart: false,
    });
    const daemonB = await startErrorEventDaemon({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      wakeMode: WAKE_MODES.REALTIME,
      autoStart: false,
    });
    assert.equal(daemonA, daemonB);

    const mismatchedStop = await stopErrorEventDaemon({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      wakeMode: WAKE_MODES.SCHEDULED,
      reason: "no_match",
    });
    assert.equal(mismatchedStop.stopped, false);
    assert.equal(mismatchedStop.count, 0);

    const matchedStop = await stopErrorEventDaemon({
      targetPath: tempRoot,
      sessionId: session.sessionId,
      wakeMode: WAKE_MODES.REALTIME,
      reason: "match",
    });
    assert.equal(matchedStop.stopped, true);
    assert.equal(matchedStop.count, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit error event daemon: scheduled sweep without session returns digest and no stream event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-error-daemon-sweep-nosession-"));
  try {
    await seedWorkspace(tempRoot);
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        service: "sentinelayer-api",
        endpoint: "/v1/admin/error-log",
        errorCode: "ERROR_STREAM_BACKPRESSURE",
        severity: "P2",
        message: "error stream lagging",
      },
    });
    await runErrorDaemonWorker({ targetPath: tempRoot, maxEvents: 20 });

    const sweep = await scheduledErrorSweep({
      targetPath: tempRoot,
      region: "eu-west-1",
      tz: "UTC",
    });
    assert.equal(sweep.queueDepth, 1);
    assert.equal(sweep.event, null);
    assert.equal(sweep.digest.region, "eu-west-1");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
