import test from "node:test";
import assert from "node:assert/strict";

import {
  hostName,
  buildResumeArgs,
  buildAsyncRewakeHook,
  buildStopBlockDecision,
  shouldReleaseStopBlock,
  installWakeHook,
  wake,
} from "../src/session/wake/claude.js";

// A fake execFile matching the (file, args, options, callback) signature so we
// can assert what would be spawned without launching `claude`.
function fakeExecFile({ error = null, stdout = "", stderr = "" } = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, stdout, stderr);
  };
  return { impl, calls };
}

test("Unit claude wake: hostName is claude", () => {
  assert.equal(hostName, "claude");
});

test("Unit claude wake: buildResumeArgs builds a no-shell argv (headless by default)", () => {
  const args = buildResumeArgs({ sessionId: "sess-1", message: "wake: new event" });
  assert.deepEqual(args, ["--resume", "sess-1", "-p", "wake: new event"]);
});

test("Unit claude wake: buildResumeArgs honors print=false and extraArgs", () => {
  const args = buildResumeArgs({
    sessionId: "s",
    message: "m",
    print: false,
    extraArgs: ["--model", "opus"],
  });
  assert.deepEqual(args, ["--resume", "s", "--model", "opus", "m"]);
});

test("Unit claude wake: buildResumeArgs rejects empty sessionId/message", () => {
  assert.throws(() => buildResumeArgs({ sessionId: "", message: "m" }), TypeError);
  assert.throws(() => buildResumeArgs({ sessionId: "s", message: "  " }), TypeError);
});

test("Unit claude wake: buildResumeArgs caps an oversized message", () => {
  const big = "x".repeat(20_000);
  const args = buildResumeArgs({ sessionId: "s", message: big });
  assert.equal(args.at(-1).length, 16_000);
});

test("Unit claude wake: buildAsyncRewakeHook encodes the verified contract", () => {
  const hook = buildAsyncRewakeHook({ command: "/bin/sentid-wake", timeoutSeconds: 300 });
  assert.deepEqual(hook, {
    type: "command",
    command: "/bin/sentid-wake",
    asyncRewake: true,
    timeout: 300,
  });
});

test("Unit claude wake: buildAsyncRewakeHook validates inputs", () => {
  assert.throws(() => buildAsyncRewakeHook({ command: "" }), TypeError);
  assert.throws(() => buildAsyncRewakeHook({ command: "x", timeoutSeconds: 0 }), TypeError);
});

test("Unit claude wake: buildStopBlockDecision returns a block decision", () => {
  assert.deepEqual(buildStopBlockDecision({ reason: "inbox has 1 unread" }), {
    decision: "block",
    reason: "inbox has 1 unread",
  });
  assert.throws(() => buildStopBlockDecision({ reason: "" }), TypeError);
});

test("Unit claude wake: shouldReleaseStopBlock honors the block cap", () => {
  assert.equal(shouldReleaseStopBlock({ stop_hook_active: true }), true);
  assert.equal(shouldReleaseStopBlock({ stopHookActive: true }), true);
  assert.equal(shouldReleaseStopBlock({ blockCount: 8 }), true);
  assert.equal(shouldReleaseStopBlock({ blockCount: 2 }), false);
  assert.equal(shouldReleaseStopBlock({}), false);
});

test("Unit claude wake: installWakeHook returns a non-destructive settings fragment", () => {
  const fragment = installWakeHook({ command: "/bin/sentid-wake", event: "Stop" });
  assert.deepEqual(fragment, {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/bin/sentid-wake", asyncRewake: true, timeout: 600 }] }] },
  });
});

test("Unit claude wake: wake() spawns claude --resume via injected execFile and reports ok", async () => {
  const { impl, calls } = fakeExecFile({ stdout: "done" });
  const result = await wake(
    { sessionId: "sess-42", message: "wake: 1 new message from carter" },
    { execFileImpl: impl, claudeBin: "claude" }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "claude");
  assert.deepEqual(calls[0].args, ["--resume", "sess-42", "-p", "wake: 1 new message from carter"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(result, { ok: true, hostName: "claude", sessionId: "sess-42", code: 0, reason: null });
});

test("Unit claude wake: wake() maps a timeout kill to resume_timeout", async () => {
  const killed = Object.assign(new Error("timed out"), { killed: true, code: null });
  const { impl } = fakeExecFile({ error: killed, stderr: "" });
  const result = await wake({ sessionId: "s", message: "m" }, { execFileImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "resume_timeout");
});

test("Unit claude wake: wake() surfaces stderr on non-zero exit", async () => {
  const err = Object.assign(new Error("exited"), { code: 1 });
  const { impl } = fakeExecFile({ error: err, stderr: "session not found" });
  const result = await wake({ sessionId: "s", message: "m" }, { execFileImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.reason, "session not found");
});

test("Unit claude wake: wake() rejects invalid input before spawning", async () => {
  const { impl, calls } = fakeExecFile({});
  await assert.rejects(() => wake({ sessionId: "", message: "m" }, { execFileImpl: impl }), TypeError);
  assert.equal(calls.length, 0);
});
