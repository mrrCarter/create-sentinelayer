import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createSessionWakeRunner } from "../src/commands/session.js";

function fakeSpawn(calls) {
  return (command, opts) => {
    const child = new EventEmitter();
    const rec = { command, opts, stdin: "", child };
    child.stdin = {
      write: (chunk) => {
        rec.stdin += String(chunk);
      },
      end: () => {},
    };
    calls.push(rec);
    return child;
  };
}

const EVENT = {
  event: "session_message",
  cursor: "0000000026018:000065a2",
  sequenceId: 26018,
  agent: { id: "human-mrrcarter" },
};

test("Unit wake runner: fires the command with event context on stdin + env", () => {
  const calls = [];
  const emits = [];
  const runner = createSessionWakeRunner({
    command: "echo hi",
    sessionId: "sess-1",
    agentId: "claude-mythos",
    emit: (p) => emits.push(p),
    spawnImpl: fakeSpawn(calls),
  });

  assert.equal(runner.hasCommand, true);
  runner.trigger(EVENT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "echo hi");
  assert.equal(calls[0].opts.shell, true);
  assert.equal(calls[0].opts.env.SL_WAKE_SESSION_ID, "sess-1");
  assert.equal(calls[0].opts.env.SL_WAKE_AGENT_ID, "claude-mythos");
  assert.equal(calls[0].opts.env.SL_WAKE_EVENT_TYPE, "session_message");
  assert.equal(calls[0].opts.env.SL_WAKE_EVENT_CURSOR, "0000000026018:000065a2");
  assert.equal(calls[0].opts.env.SL_WAKE_EVENT_SEQUENCE, "26018");
  assert.equal(calls[0].opts.env.SL_WAKE_ACTOR_ID, "human-mrrcarter");
  assert.deepEqual(JSON.parse(calls[0].stdin), EVENT);
  assert.equal(emits[0].status, "fired");
});

test("Unit wake runner: coalesces a burst into one trailing wake", () => {
  const calls = [];
  const runner = createSessionWakeRunner({
    command: "wake.sh",
    sessionId: "s",
    agentId: "a",
    spawnImpl: fakeSpawn(calls),
  });

  runner.trigger({ ...EVENT, cursor: "c1" }); // runs immediately (busy now)
  runner.trigger({ ...EVENT, cursor: "c2" }); // queued
  runner.trigger({ ...EVENT, cursor: "c3" }); // replaces queued -> c3
  assert.equal(calls.length, 1, "only one wake while busy");

  calls[0].child.emit("exit", 0); // finish -> fire the trailing (latest) event
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.env.SL_WAKE_EVENT_CURSOR, "c3", "trailing wake uses the latest event");

  calls[1].child.emit("exit", 0); // no more pending
  assert.equal(calls.length, 2);
});

test("Unit wake runner: no command is a no-op", () => {
  const calls = [];
  const runner = createSessionWakeRunner({ command: "", spawnImpl: fakeSpawn(calls) });
  assert.equal(runner.hasCommand, false);
  runner.trigger(EVENT);
  assert.equal(calls.length, 0);
});

test("Unit wake runner: non-zero exit surfaces an error notice", () => {
  const calls = [];
  const emits = [];
  const runner = createSessionWakeRunner({
    command: "wake.sh",
    emit: (p) => emits.push(p),
    spawnImpl: fakeSpawn(calls),
  });
  runner.trigger(EVENT);
  calls[0].child.emit("exit", 3);
  assert.ok(emits.some((p) => p.status === "error" && p.reason === "exit_3"));
});

test("Unit wake runner: spawn failure is reported, not thrown", () => {
  const emits = [];
  const runner = createSessionWakeRunner({
    command: "wake.sh",
    emit: (p) => emits.push(p),
    spawnImpl: () => {
      throw new Error("spawn ENOENT");
    },
  });
  assert.doesNotThrow(() => runner.trigger(EVENT));
  assert.ok(emits.some((p) => p.status === "error" && /spawn ENOENT/.test(p.reason)));
});
