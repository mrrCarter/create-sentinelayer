// Contract tests between CLI session sync (src/session/sync.js) and the
// sentinelayer-api session relay endpoints (src/routes/sessions.py).
//
// The authoritative server-side Pydantic models are mirrored as JSON schemas
// here. Each test captures a real CLI outbound fetch, parses its body, and
// asserts it validates against the schema. If either side drifts (e.g. CLI
// renames a field, API adds a required field), the test fails locally before
// integration.
//
// Cross-reference (keep in sync):
// - sentinelayer-api/src/routes/sessions.py Pydantic models:
//     SessionEventPayload        {event: dict, source?: str}
//     SessionMetadataPayload     {metadata: dict, source?: str}
//     SessionErrorPayload        {error: dict, source?: str}
//     SessionHumanMessagePayload {text?: str, message?: str}
//     SessionKillPayload         {reason?: str}

import test, { before } from "node:test";
import assert from "node:assert/strict";

import {
  syncSessionEventToApi,
  syncSessionMetadataToApi,
  syncSessionErrorToApi,
  pollHumanMessages,
} from "../src/session/sync.js";

// Contract tests exercise the network path via mocked fetchImpl. The
// global setup-env shim sets SENTINELAYER_SKIP_REMOTE_SYNC=1 to keep
// real CLI flows from leaking sessions into prod, but it would also
// short-circuit these mocks. Clear it for this file so the recorders
// observe the canonical request bodies they assert against.
before(() => {
  delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
});

const CONTRACT = {
  events: {
    endpoint: (id) => `/api/v1/sessions/${id}/events`,
    method: "POST",
    required: ["event"],
    allowed: ["event", "source"],
    typeCheck: (body) => typeof body.event === "object" && body.event !== null && !Array.isArray(body.event),
  },
  metadata: {
    endpoint: (id) => `/api/v1/sessions/${id}/metadata`,
    method: "POST",
    required: ["metadata"],
    allowed: ["metadata", "source"],
    typeCheck: (body) => typeof body.metadata === "object" && body.metadata !== null,
  },
  errors: {
    endpoint: (id) => `/api/v1/sessions/${id}/errors`,
    method: "POST",
    required: ["error"],
    allowed: ["error", "source"],
    typeCheck: (body) => typeof body.error === "object" && body.error !== null,
  },
  humanMessages: {
    endpoint: (id) => `/api/v1/sessions/${id}/human-messages`,
    method: "GET",
  },
};

function validatePayload(body, contract) {
  for (const key of contract.required) {
    assert.ok(key in body, `required key '${key}' missing from body`);
  }
  for (const key of Object.keys(body)) {
    assert.ok(contract.allowed.includes(key), `unexpected key '${key}' in body (not in contract)`);
  }
  assert.ok(contract.typeCheck(body), "typeCheck failed");
}

function makeFetchRecorder() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({
      url: String(url),
      method: init.method || "GET",
      body,
    });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ messages: [], cursor: null }),
      text: async () => "",
    };
  };
  return { calls, fetchImpl };
}

const FAKE_SESSION = {
  token: "slt_test_token_for_contract_harness",
  apiUrl: "https://api.sentinelayer.com",
};

test("contract: syncSessionEventToApi body matches SessionEventPayload schema", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  await syncSessionEventToApi(
    "sess_contract_1",
    { event: "agent_join", agentId: "test-agent", sessionId: "sess_contract_1", ts: new Date().toISOString() },
    {
      targetPath: process.cwd(),
      resolveAuthSession: async () => FAKE_SESSION,
      fetchImpl,
    }
  );

  assert.equal(calls.length, 1, "exactly one outbound POST expected");
  const call = calls[0];

  assert.equal(call.method, CONTRACT.events.method);
  assert.ok(
    call.url.endsWith(CONTRACT.events.endpoint("sess_contract_1")),
    `URL '${call.url}' does not match expected endpoint`
  );
  validatePayload(call.body, CONTRACT.events);
  assert.equal(call.body.source, "cli");
});

test("contract: syncSessionMetadataToApi body matches SessionMetadataPayload schema", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  await syncSessionMetadataToApi(
    "sess_contract_2",
    { schemaVersion: "1.0.0", sessionId: "sess_contract_2", status: "active" },
    {
      targetPath: process.cwd(),
      resolveAuthSession: async () => FAKE_SESSION,
      fetchImpl,
    }
  );

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, CONTRACT.metadata.method);
  assert.ok(call.url.endsWith(CONTRACT.metadata.endpoint("sess_contract_2")));
  validatePayload(call.body, CONTRACT.metadata);
  assert.equal(call.body.source, "cli");
});

test("contract: syncSessionErrorToApi body matches SessionErrorPayload schema", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  await syncSessionErrorToApi(
    "sess_contract_3",
    { code: "TEST_ERROR", message: "contract test", timestamp: new Date().toISOString() },
    {
      targetPath: process.cwd(),
      resolveAuthSession: async () => FAKE_SESSION,
      fetchImpl,
    }
  );

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, CONTRACT.errors.method);
  assert.ok(call.url.endsWith(CONTRACT.errors.endpoint("sess_contract_3")));
  validatePayload(call.body, CONTRACT.errors);
  assert.equal(call.body.source, "cli");
});

test("contract: pollHumanMessages issues GET with limit and optional since params", async () => {
  const { calls, fetchImpl } = makeFetchRecorder();
  await pollHumanMessages("sess_contract_4", {
    targetPath: process.cwd(),
    resolveAuthSession: async () => FAKE_SESSION,
    fetchImpl,
    since: "2026-04-18T00:00:00Z",
    limit: 10,
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, CONTRACT.humanMessages.method);
  const url = new URL(call.url);
  assert.ok(url.pathname.endsWith(CONTRACT.humanMessages.endpoint("sess_contract_4")));
  assert.equal(url.searchParams.get("since"), "2026-04-18T00:00:00Z");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("contract: event payload always wraps the canonical event under the 'event' key", async () => {
  // Regression fence: previous versions of sync.js flattened the event into
  // the top-level body (e.g. {event: "agent_join", agentId: "x", sessionId: "..."})
  // which would silently fail against SessionEventPayload's {event: dict}.
  const { calls, fetchImpl } = makeFetchRecorder();
  await syncSessionEventToApi(
    "sess_contract_5",
    {
      event: "agent_say",
      agentId: "a1",
      sessionId: "sess_contract_5",
      payload: { body: "hello" },
      ts: new Date().toISOString(),
    },
    {
      targetPath: process.cwd(),
      resolveAuthSession: async () => FAKE_SESSION,
      fetchImpl,
    }
  );

  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.ok("event" in body, "body must have 'event' wrapper");
  assert.ok(typeof body.event === "object", "'event' must be an object (not a string)");
  assert.ok(!("agentId" in body), "agentId must be inside .event, not at top level");
  assert.ok(!("payload" in body), "payload must be inside .event, not at top level");
});
