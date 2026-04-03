import assert from "node:assert/strict";
import test from "node:test";

import { SentinelayerApiError } from "../src/auth/http.js";
import { formatApiError } from "../src/commands/auth.js";

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
