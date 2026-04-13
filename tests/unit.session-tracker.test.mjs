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
  const previousIsTty = process.stderr.isTTY;
  delete process.env.SENTINELAYER_VERBOSE_TELEMETRY;
  delete process.env.SENTINELAYER_DEBUG_ERRORS;
  delete process.env.SENTINELAYER_UNMASK_TRACE_ID;
  process.stderr.isTTY = true;

  try {
    const session = startSession("unit-test");
    const output = captureStderr(() => printSessionSummary({ sessionId: session.id }));
    assert.match(output, /trace_id=/);
    assert.doesNotMatch(output, new RegExp(session.id));
  } finally {
    process.env = previousEnv;
    process.stderr.isTTY = previousIsTty;
  }
});

test("Session tracker keeps trace id masked with verbose telemetry unless explicit unmask flag is set", () => {
  const previousEnv = { ...process.env };
  const previousIsTty = process.stderr.isTTY;
  process.env.SENTINELAYER_VERBOSE_TELEMETRY = "1";
  delete process.env.SENTINELAYER_UNMASK_TRACE_ID;
  process.env.NODE_ENV = "development";
  process.stderr.isTTY = true;

  try {
    const session = startSession("unit-test");
    const output = captureStderr(() => printSessionSummary({ sessionId: session.id }));
    assert.match(output, /trace_id=/);
    assert.doesNotMatch(output, new RegExp(session.id));
  } finally {
    process.env = previousEnv;
    process.stderr.isTTY = previousIsTty;
  }
});

test("Session tracker reveals trace id only with explicit unmask + dev tty context", () => {
  const previousEnv = { ...process.env };
  const previousIsTty = process.stderr.isTTY;
  process.env.SENTINELAYER_VERBOSE_TELEMETRY = "1";
  process.env.SENTINELAYER_UNMASK_TRACE_ID = "1";
  process.env.NODE_ENV = "development";
  process.stderr.isTTY = true;

  try {
    const session = startSession("unit-test");
    const output = captureStderr(() => printSessionSummary({ sessionId: session.id }));
    assert.match(output, new RegExp(session.id));
  } finally {
    process.env = previousEnv;
    process.stderr.isTTY = previousIsTty;
  }
});
