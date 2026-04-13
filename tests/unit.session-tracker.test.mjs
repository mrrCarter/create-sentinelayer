import test from "node:test";
import assert from "node:assert/strict";

import { startSession, printSessionSummary } from "../src/telemetry/session-tracker.js";

function captureStderr(fn) {
  const previousWrite = process.stderr.write;
  let output = "";
  process.stderr.write = (chunk) => {
    output += String(chunk || "");
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = previousWrite;
  }
  return output;
}

test("Session tracker masks trace id by default", () => {
  const previousEnv = { ...process.env };
  delete process.env.SENTINELAYER_VERBOSE_TELEMETRY;
  delete process.env.SENTINELAYER_DEBUG_ERRORS;

  try {
    const session = startSession("unit-test");
    const output = captureStderr(() => printSessionSummary({ sessionId: session.id }));
    assert.match(output, /trace_id=/);
    assert.doesNotMatch(output, new RegExp(session.id));
  } finally {
    process.env = previousEnv;
  }
});

test("Session tracker reveals trace id when verbose telemetry is enabled", () => {
  const previousEnv = { ...process.env };
  process.env.SENTINELAYER_VERBOSE_TELEMETRY = "1";

  try {
    const session = startSession("unit-test");
    const output = captureStderr(() => printSessionSummary({ sessionId: session.id }));
    assert.match(output, new RegExp(session.id));
  } finally {
    process.env = previousEnv;
  }
});
