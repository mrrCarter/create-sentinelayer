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
  assert.match(formatted, /\[INTERNAL_ERROR\]/);
  assert.match(formatted, /status=500/);
  assert.match(formatted, /request_id=req_123/);
  assert.doesNotMatch(formatted, /internal stack trace/i);
  assert.doesNotMatch(formatted, /token=secret/i);
});

test("Unit auth command: debug env never appends raw API error details", () => {
  const previousDebug = process.env.SL_DEBUG_ERRORS;
  process.env.SL_DEBUG_ERRORS = "true";
  try {
    const error = new SentinelayerApiError("internal stack trace: token=secret", {
      status: 429,
      code: "RATE_LIMITED",
      requestId: "req_debug",
    });
    const formatted = formatApiError(error);
    assert.match(formatted, /Sentinelayer API request failed\./);
    assert.doesNotMatch(formatted, /detail=/);
    assert.doesNotMatch(formatted, /internal stack trace/i);
  } finally {
    if (previousDebug === undefined) {
      delete process.env.SL_DEBUG_ERRORS;
    } else {
      process.env.SL_DEBUG_ERRORS = previousDebug;
    }
  }
});
