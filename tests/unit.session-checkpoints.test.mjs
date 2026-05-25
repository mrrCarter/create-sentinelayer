import test from "node:test";
import assert from "node:assert/strict";

import { SentinelayerApiError } from "../src/auth/http.js";
import {
  buildGenerateCheckpointPayload,
  buildManualCheckpointPayload,
  createSessionCheckpoint,
  generateSessionCheckpoint,
  generateSessionCheckpointBatch,
  generateSessionCheckpointBestEffort,
  listSessionCheckpoints,
  normalizeCheckpointGenerationResult,
} from "../src/session/checkpoints.js";

const fakeAuthValue = ["local", "checkpoint", "auth"].join("-");

const fakeAuth = async () => ({
  token: fakeAuthValue,
  apiUrl: "https://api.example.com/",
});

function withRemoteSyncEnabled(fn) {
  return async () => {
    const previous = process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    try {
      await fn();
    } finally {
      if (previous === undefined) {
        delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
      } else {
        process.env.SENTINELAYER_SKIP_REMOTE_SYNC = previous;
      }
    }
  };
}

test("Unit session checkpoints: manual payload is stable and validates ranges", () => {
  const first = buildManualCheckpointPayload("sess-1", {
    startSequence: "10",
    endSequence: "20",
    title: "Handoff",
    summary: "Implemented checkpoint CLI.",
    kind: "handoff",
    createdByAgentId: "codex",
    tokenStart: "100",
    tokenEnd: "250",
  });
  const second = buildManualCheckpointPayload("sess-1", {
    startSequence: 10,
    endSequence: 20,
    title: "Handoff",
    summary: "Implemented checkpoint CLI.",
    kind: "handoff",
    createdByAgentId: "codex",
    tokenStart: 100,
    tokenEnd: 250,
  });

  assert.deepEqual(first, second);
  assert.match(first.body.checkpointId, /^cp_cli_[a-f0-9]{24}$/);
  assert.match(first.idempotencyKey, /^sl_cli_session_checkpoint_[a-f0-9]{64}$/);
  assert.deepEqual(first.body.tokenRange, { start: 100, end: 250 });

  assert.throws(
    () =>
      buildManualCheckpointPayload("sess-1", {
        startSequence: 20,
        endSequence: 10,
        title: "Bad",
        summary: "Bad range.",
      }),
    /start-sequence must be less than or equal to end-sequence/i,
  );
  assert.throws(
    () =>
      buildManualCheckpointPayload("sess-1", {
        startSequence: 1,
        endSequence: 2,
        title: "Bad",
      }),
    /summary is required/i,
  );
});

test("Unit session checkpoints: generate payload bounds event window", () => {
  const payload = buildGenerateCheckpointPayload("sess-1", {
    minEvents: "5",
    maxEvents: "20",
    createdByAgentId: "senti",
  });
  assert.deepEqual(payload.body, {
    minEvents: 5,
    maxEvents: 20,
    createdByAgentId: "senti",
  });
  assert.match(payload.idempotencyKey, /^sl_cli_session_checkpoint_generate_[a-f0-9-]+$/);
  assert.throws(
    () => buildGenerateCheckpointPayload("sess-1", { minEvents: 50, maxEvents: 10 }),
    /max-events must be greater than or equal to min-events/i,
  );
  assert.throws(
    () => buildGenerateCheckpointPayload("sess-1", { minEvents: 201, maxEvents: 201 }),
    /min-events must be less than or equal to 200/i,
  );
});

test("Unit session checkpoints: generated checkpoint idempotency is invocation scoped", () => {
  const first = buildGenerateCheckpointPayload("sess-1", {
    minEvents: 5,
    maxEvents: 20,
    createdByAgentId: "senti",
  });
  const second = buildGenerateCheckpointPayload("sess-1", {
    minEvents: 5,
    maxEvents: 20,
    createdByAgentId: "senti",
  });

  assert.match(first.idempotencyKey, /^sl_cli_session_checkpoint_generate_[a-f0-9-]+$/);
  assert.match(second.idempotencyKey, /^sl_cli_session_checkpoint_generate_[a-f0-9-]+$/);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);

  const explicit = buildGenerateCheckpointPayload("sess-1", {
    minEvents: 5,
    maxEvents: 20,
    idempotencyKey: "sl_cli_session_checkpoint_generate_custom_key",
  });
  assert.equal(explicit.idempotencyKey, "sl_cli_session_checkpoint_generate_custom_key");
});

test("Unit session checkpoints: list calls checkpoint endpoint with auth", async () => {
  const calls = [];
  const result = await listSessionCheckpoints("sess-123", {
    targetPath: "/repo",
    limit: 500,
    resolveAuthSession: fakeAuth,
    request: async (url, options) => {
      calls.push({ url, options });
      return {
        checkpoints: [{ checkpointId: "cp_1", title: "One", summary: "First" }],
        count: 1,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.example.com/api/v1/sessions/sess-123/checkpoints?limit=200",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${fakeAuthValue}`);
  assert.equal(result.count, 1);
  assert.equal(result.checkpoints[0].checkpointId, "cp_1");
});

test("Unit session checkpoints: create posts stable idempotent checkpoint body", async () => {
  const calls = [];
  const result = await createSessionCheckpoint("sess-123", {
    targetPath: "/repo",
    startSequence: 3,
    endSequence: 9,
    title: "Range",
    summary: "Durable handoff.",
    kind: "handoff",
    createdByAgentId: "codex",
    resolveAuthSession: fakeAuth,
    requestMutation: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        duplicate: false,
        checkpoint: {
          checkpointId: options.body.checkpointId,
          startSequence: options.body.startSequence,
          endSequence: options.body.endSequence,
          title: options.body.title,
          summary: options.body.summary,
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/api/v1/sessions/sess-123/checkpoints");
  assert.equal(calls[0].options.operationName, "session-checkpoint-create");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${fakeAuthValue}`);
  assert.match(calls[0].options.idempotencyKey, /^sl_cli_session_checkpoint_[a-f0-9]{64}$/);
  assert.match(calls[0].options.body.checkpointId, /^cp_cli_[a-f0-9]{24}$/);
  assert.equal(result.checkpoint.startSequence, 3);
  assert.equal(result.idempotencyKey, calls[0].options.idempotencyKey);
});

test("Unit session checkpoints: generate posts bounded request body", async () => {
  const calls = [];
  const result = await generateSessionCheckpoint("sess-123", {
    targetPath: "/repo",
    minEvents: 4,
    maxEvents: 12,
    createdByAgentId: "senti",
    resolveAuthSession: fakeAuth,
    requestMutation: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        created: true,
        duplicate: false,
        checkpoint: { checkpointId: "cp_auto_1", title: "Auto", summary: "Generated." },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.example.com/api/v1/sessions/sess-123/checkpoints/generate",
  );
  assert.equal(calls[0].options.operationName, "session-checkpoint-generate");
  assert.deepEqual(calls[0].options.body, {
    minEvents: 4,
    maxEvents: 12,
    createdByAgentId: "senti",
  });
  assert.equal(result.checkpoint.checkpointId, "cp_auto_1");
});

test("Unit session checkpoints: batch generate stops on first skipped window", async () => {
  const calls = [];
  const responses = [
    {
      ok: true,
      created: true,
      duplicate: false,
      checkpoint: { checkpointId: "cp_auto_1", title: "Auto 1", summary: "Generated." },
      eventCount: 80,
    },
    {
      ok: true,
      created: true,
      duplicate: false,
      checkpoint: { checkpointId: "cp_auto_2", title: "Auto 2", summary: "Generated." },
      eventCount: 80,
    },
    {
      ok: true,
      created: false,
      duplicate: false,
      reason: "insufficient_events",
      eventCount: 12,
      minEvents: 20,
    },
  ];
  const result = await generateSessionCheckpointBatch("sess-123", {
    targetPath: "/repo",
    minEvents: 20,
    maxEvents: 80,
    maxCheckpoints: 5,
    idempotencyKey: "checkpoint-catchup",
    createdByAgentId: "codex",
    resolveAuthSession: fakeAuth,
    requestMutation: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.options.idempotencyKey),
    ["checkpoint-catchup:1", "checkpoint-catchup:2", "checkpoint-catchup:3"],
  );
  assert.deepEqual(calls[0].options.body, {
    minEvents: 20,
    maxEvents: 80,
    createdByAgentId: "codex",
  });
  assert.equal(result.createdCount, 2);
  assert.equal(result.attemptedCount, 3);
  assert.equal(result.stoppedReason, "insufficient_events");
  assert.deepEqual(result.checkpointIds, ["cp_auto_1", "cp_auto_2"]);
  assert.equal(result.lastResult.reason, "insufficient_events");
});

test("Unit session checkpoints: batch generate is capped and rejects invalid caps", async () => {
  const calls = [];
  const result = await generateSessionCheckpointBatch("sess-123", {
    targetPath: "/repo",
    maxCheckpoints: 2,
    resolveAuthSession: fakeAuth,
    requestMutation: async () => {
      calls.push(true);
      return {
        ok: true,
        created: true,
        duplicate: false,
        checkpoint: { checkpointId: `cp_auto_${calls.length}` },
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.createdCount, 2);
  assert.equal(result.stoppedReason, "max_checkpoints");
  await assert.rejects(
    () => generateSessionCheckpointBatch("sess-123", { maxCheckpoints: 0 }),
    /max-checkpoints must be a positive integer/i,
  );
});

test("Unit session checkpoints: best-effort generate is safe for daemon ticks", withRemoteSyncEnabled(async () => {
  const calls = [];
  const result = await generateSessionCheckpointBestEffort("sess-123", {
    targetPath: "/repo",
    minEvents: 25,
    maxEvents: 90,
    resolveAuthSession: fakeAuth,
    requestMutation: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        created: true,
        duplicate: false,
        checkpoint: { checkpoint_id: "cp_auto_2" },
        event_count: 25,
        min_events: 25,
        max_events: 90,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/api/v1/sessions/sess-123/checkpoints/generate");
  assert.deepEqual(calls[0].options.body, {
    minEvents: 25,
    maxEvents: 90,
    createdByAgentId: "senti",
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.checkpointId, "cp_auto_2");
  assert.equal(result.eventCount, 25);
}));

test("Unit session checkpoints: best-effort generate normalizes disabled, auth, and API failures", async () => {
  const previous = process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "1";
  try {
    const skipped = await generateSessionCheckpointBestEffort("sess-123");
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, "remote_sync_disabled_env");
  } finally {
    if (previous === undefined) {
      delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    } else {
      process.env.SENTINELAYER_SKIP_REMOTE_SYNC = previous;
    }
  }

  await withRemoteSyncEnabled(async () => {
    const noAuth = await generateSessionCheckpointBestEffort("sess-123", {
      resolveAuthSession: async () => ({ token: "" }),
    });
    assert.equal(noAuth.ok, false);
    assert.equal(noAuth.reason, "not_authenticated");

    const apiFailure = await generateSessionCheckpointBestEffort("sess-123", {
      resolveAuthSession: fakeAuth,
      requestMutation: async () => {
        throw new SentinelayerApiError("temporarily unavailable", {
          status: 503,
          code: "SERVICE_UNAVAILABLE",
          requestId: "req-1",
        });
      },
    });
    assert.equal(apiFailure.ok, false);
    assert.equal(apiFailure.reason, "api_503");
    assert.equal(apiFailure.status, 503);
    assert.equal(apiFailure.code, "SERVICE_UNAVAILABLE");
    assert.equal(apiFailure.requestId, "req-1");
  })();
});

test("Unit session checkpoints: generation result normalization handles API casing", () => {
  const normalized = normalizeCheckpointGenerationResult({
    ok: true,
    created: false,
    duplicate: true,
    reason: "checkpoint range already covered",
    checkpoint: { checkpoint_id: "cp_existing" },
    event_count: "33",
    min_events: "20",
    max_events: "80",
  });
  assert.equal(normalized.reason, "checkpoint_range_already_covered");
  assert.equal(normalized.checkpointId, "cp_existing");
  assert.equal(normalized.eventCount, 33);
  assert.equal(normalized.minEvents, 20);
  assert.equal(normalized.maxEvents, 80);
});
