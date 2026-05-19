import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGenerateCheckpointPayload,
  buildManualCheckpointPayload,
  createSessionCheckpoint,
  generateSessionCheckpoint,
  listSessionCheckpoints,
} from "../src/session/checkpoints.js";

const fakeAuthValue = ["local", "checkpoint", "auth"].join("-");

const fakeAuth = async () => ({
  token: fakeAuthValue,
  apiUrl: "https://api.example.com/",
});

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
