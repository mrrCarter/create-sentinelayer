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
  // stdin carries a metadata-only envelope (NOT the raw event) so message
  // body/content never reaches the external wake command.
  assert.deepEqual(JSON.parse(calls[0].stdin), {
    event: "session_message",
    sessionId: "sess-1",
    agentId: "claude-mythos",
    cursor: "0000000026018:000065a2",
    sequenceId: 26018,
    actorId: "human-mrrcarter",
  });
  assert.equal(emits[0].status, "fired");
});

test("Unit wake runner: redacts message content/PII + sanitizes remote env values", () => {
  const calls = [];
  const runner = createSessionWakeRunner({
    command: "wake.sh",
    sessionId: "s",
    agentId: "a",
    spawnImpl: fakeSpawn(calls),
  });

  runner.trigger({
    event: "session_message",
    cursor: "c-1",
    sequenceId: 99,
    agent: { id: "evil\ninjected-actor" },
    // Content fields a real session_message carries — must NOT be piped out.
    message: "SECRET user PII in the body",
    messageParts: ["another SECRET chunk"],
    body: "do-not-leak",
  });

  const piped = calls[0].stdin;
  // PII: no message content may reach the external wake command's stdin.
  assert.ok(!piped.includes("SECRET"), "message content must not leak to the wake hook");
  assert.ok(!piped.includes("do-not-leak"));
  // Envelope is metadata-only (fixed key set).
  const payload = JSON.parse(piped);
  assert.deepEqual(Object.keys(payload).sort(), [
    "actorId",
    "agentId",
    "cursor",
    "event",
    "sequenceId",
    "sessionId",
  ]);
  assert.equal(payload.event, "session_message");
  assert.equal(payload.sequenceId, 99);
  // Remote-derived env value is sanitized: no control-char / newline injection.
  assert.ok(
    !calls[0].opts.env.SL_WAKE_ACTOR_ID.includes("\n"),
    "actor id newline must be stripped from the child env",
  );
  assert.equal(calls[0].opts.env.SL_WAKE_ACTOR_ID, "evil injected-actor");
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
