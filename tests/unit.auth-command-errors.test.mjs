import assert from "node:assert/strict";
import test from "node:test";

import { SentinelayerApiError } from "../src/auth/http.js";
import {
  __sanitizeRemoteAuthErrorForTests,
  __serializeAuthCommandErrorForTests,
  formatApiError,
} from "../src/commands/auth.js";

test("Unit auth command: API errors are sanitized by default", () => {
  const error = new SentinelayerApiError("internal stack trace: token=secret", {
    status: 500,
    code: "INTERNAL_ERROR",
    requestId: "req_123",
  });
  const formatted = formatApiError(error);
  assert.match(formatted, /Sentinelayer API request failed\./);
  assert.doesNotMatch(formatted, /\[INTERNAL_ERROR\]/);
  assert.doesNotMatch(formatted, /status=500/);
  assert.doesNotMatch(formatted, /request_id=/);
  assert.doesNotMatch(formatted, /internal stack trace/i);
  assert.doesNotMatch(formatted, /token=secret/i);
});

test("Unit auth command: debug env emits only request-id tail", () => {
  const previousDebug = process.env.SL_DEBUG_ERRORS;
  const previousCi = process.env.CI;
  const previousIsTty = process.stdout.isTTY;
  process.env.SL_DEBUG_ERRORS = "true";
  delete process.env.CI;
  process.stdout.isTTY = true;
  try {
    const error = new SentinelayerApiError("internal stack trace: token=secret", {
      status: 429,
      code: "RATE_LIMITED",
      requestId: "req_debug_trace_abcdef12",
    });
    const formatted = formatApiError(error);
    assert.match(formatted, /Sentinelayer API request failed\./);
    assert.match(formatted, /\[RATE_LIMITED\]/);
    assert.match(formatted, /status=429/);
    assert.match(formatted, /request_id=\.\.\.abcdef12/);
    assert.doesNotMatch(formatted, /req_debug_trace_abcdef12/);
    assert.doesNotMatch(formatted, /internal stack trace/i);
  } finally {
    process.stdout.isTTY = previousIsTty;
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    if (previousDebug === undefined) {
      delete process.env.SL_DEBUG_ERRORS;
    } else {
      process.env.SL_DEBUG_ERRORS = previousDebug;
    }
  }
});

test("Unit auth command: structured command errors exclude backend code and status fields", () => {
  const serialized = __serializeAuthCommandErrorForTests(
    new SentinelayerApiError("internal details", {
      status: 503,
      code: "NETWORK_ERROR",
      requestId: "req_structured_1234",
    }),
    { includeDebugRequestId: true }
  );
  assert.equal(serialized.message, "Unable to reach the Sentinelayer API. Check network connectivity and retry.");
  assert.equal(serialized.requestId, null);
  assert.equal(Object.prototype.hasOwnProperty.call(serialized, "code"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(serialized, "status"), false);
});

test("Unit auth command: verbose remote errors expose only sanitized message + redacted request id", () => {
  const previousDebug = process.env.SL_DEBUG_ERRORS;
  const previousCi = process.env.CI;
  const previousIsTty = process.stdout.isTTY;
  process.env.SL_DEBUG_ERRORS = "true";
  delete process.env.CI;
  process.stdout.isTTY = true;
  try {
    const sanitized = __sanitizeRemoteAuthErrorForTests(
      {
        code: "AUTH_REQUIRED",
        status: 401,
        requestId: "req_remote_visibility_abc12345",
      },
      { includeDetails: true }
    );
    assert.deepEqual(sanitized, {
      message: "Authentication is required. Run `sl auth login` and retry.",
      requestId: "...abc12345",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "code"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "status"), false);
  } finally {
    process.stdout.isTTY = previousIsTty;
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    if (previousDebug === undefined) {
      delete process.env.SL_DEBUG_ERRORS;
    } else {
      process.env.SL_DEBUG_ERRORS = previousDebug;
    }
  }
});

test("Unit auth command: CI suppresses remote debug request-id details", () => {
  const previousDebug = process.env.SL_DEBUG_ERRORS;
  const previousCi = process.env.CI;
  const previousIsTty = process.stdout.isTTY;
  process.env.SL_DEBUG_ERRORS = "true";
  process.env.CI = "true";
  process.stdout.isTTY = true;
  try {
    const sanitized = __sanitizeRemoteAuthErrorForTests(
      {
        code: "AUTH_REQUIRED",
        status: 401,
        requestId: "req_remote_ci_hidden_98765",
      },
      { includeDetails: true }
    );
    assert.deepEqual(sanitized, {
      message: "Authentication is required. Run `sl auth login` and retry.",
      requestId: null,
    });
  } finally {
    process.stdout.isTTY = previousIsTty;
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    if (previousDebug === undefined) {
      delete process.env.SL_DEBUG_ERRORS;
    } else {
      process.env.SL_DEBUG_ERRORS = previousDebug;
    }
  }
});
