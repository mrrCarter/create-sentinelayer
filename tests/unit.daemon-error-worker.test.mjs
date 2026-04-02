import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  appendAdminErrorEvent,
  getErrorDaemonState,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../src/daemon/error-worker.js";

test("Unit daemon error worker: routes events and dedupes by fingerprint with severity escalation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-worker-"));
  try {
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        source: "admin_error_log",
        service: "sentinelayer-api",
        endpoint: "/v1/runtime/runs",
        errorCode: "RUNTIME_TIMEOUT",
        severity: "P2",
        message: "Runtime timed out",
        stackTrace: "TimeoutError: upstream timeout at runtime_run_service.py:112",
      },
    });
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        source: "admin_error_log",
        service: "sentinelayer-api",
        endpoint: "/v1/runtime/runs",
        errorCode: "RUNTIME_TIMEOUT",
        severity: "P1",
        message: "Repeated timeout",
        stackTrace: "TimeoutError: upstream timeout at runtime_run_service.py:112",
      },
    });
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        source: "admin_error_log",
        service: "sentinelayer-api",
        endpoint: "/v1/auth/login",
        errorCode: "AUTH_REDIS_DOWN",
        severity: "P1",
        message: "Redis unavailable",
        stackTrace: "ConnectionError: redis unavailable at auth_service.py:45",
      },
    });

    const execution = await runErrorDaemonWorker({
      targetPath: tempRoot,
      maxEvents: 50,
    });
    assert.equal(execution.processedCount, 3);
    assert.equal(execution.queuedCount, 2);
    assert.equal(execution.dedupedCount, 1);
    assert.equal(execution.queueDepth, 2);

    const listed = await listErrorQueue({
      targetPath: tempRoot,
      limit: 10,
    });
    assert.equal(listed.items.length, 2);
    const runtimeQueueItem = listed.items.find((item) => item.endpoint === "/v1/runtime/runs");
    assert.ok(runtimeQueueItem);
    assert.equal(runtimeQueueItem.occurrenceCount, 2);
    assert.equal(runtimeQueueItem.severity, "P1");
    assert.equal(runtimeQueueItem.status, "QUEUED");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon error worker: advances stream offset deterministically across ticks", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-daemon-offset-"));
  try {
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        service: "sentinelayer-web",
        endpoint: "/admin/overview",
        errorCode: "SSE_DISCONNECT",
        severity: "P3",
        message: "SSE disconnect warning",
      },
    });
    await appendAdminErrorEvent({
      targetPath: tempRoot,
      event: {
        service: "sentinelayer-web",
        endpoint: "/admin/overview",
        errorCode: "SSE_DISCONNECT_2",
        severity: "P3",
        message: "Second warning",
      },
    });

    const firstTick = await runErrorDaemonWorker({
      targetPath: tempRoot,
      maxEvents: 1,
    });
    assert.equal(firstTick.processedCount, 1);
    assert.equal(firstTick.startOffset, 0);
    assert.equal(firstTick.endOffset, 1);
    assert.equal(firstTick.queueDepth, 1);

    const secondTick = await runErrorDaemonWorker({
      targetPath: tempRoot,
      maxEvents: 1,
    });
    assert.equal(secondTick.processedCount, 1);
    assert.equal(secondTick.startOffset, 1);
    assert.equal(secondTick.endOffset, 2);
    assert.equal(secondTick.queueDepth, 2);

    const state = await getErrorDaemonState({
      targetPath: tempRoot,
    });
    assert.equal(state.state.streamOffset, 2);
    assert.equal(state.state.totalProcessedEvents, 2);
    assert.equal(state.state.runCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
