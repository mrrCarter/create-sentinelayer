// Unit tests for `slc session export` shape.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { createAgentEvent } from "../src/events/schema.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-export-"));
}

async function runSessionCommand(args = []) {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerSessionCommand(program);

  const logs = [];
  const writes = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(" "));
  process.stdout.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    const callback = rest.find((part) => typeof part === "function");
    if (callback) callback();
    return true;
  };
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return `${writes.join("")}${logs.join("\n")}`.trim();
}

/**
 * The CLI command is wired in `src/commands/session.js` against
 * commander; rather than spinning the whole CLI we exercise the
 * underlying primitives the command composes (readStream / listAgents /
 * etc) and assert the shape that gets serialized. This guards against
 * regressions in the export contract without booting the full binary.
 */
test("export bundle: readStream returns full event list when tail=0", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    for (let i = 0; i < 5; i += 1) {
      await appendToStream(
        created.sessionId,
        createAgentEvent({
          event: "session_message",
          agentId: "cli-user",
          sessionId: created.sessionId,
          payload: { message: `m${i}` },
        }),
        { targetPath: root },
      );
    }
    const all = await readStream(created.sessionId, { targetPath: root, tail: 0 });
    assert.equal(all.length, 5);
    assert.equal(all[0].payload.message, "m0");
    assert.equal(all[4].payload.message, "m4");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("export bundle: agents list includes every registered agent", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await registerAgent(created.sessionId, {
      targetPath: root,
      agentId: "claude-1",
      role: "reviewer",
      model: "claude-opus-4-7",
    });
    await registerAgent(created.sessionId, {
      targetPath: root,
      agentId: "codex-1",
      role: "coder",
      model: "gpt-5.3-codex",
    });
    const events = await readStream(created.sessionId, { targetPath: root, tail: 0 });
    // registerAgent emits join events into the stream
    const joinEvents = events.filter((e) => e.event === "agent_join");
    assert.ok(
      joinEvents.length >= 2,
      `expected at least 2 agent_join events, got ${joinEvents.length}`,
    );
    const ids = new Set(joinEvents.map((e) => e.payload?.agentId));
    assert.ok(ids.has("claude-1"));
    assert.ok(ids.has("codex-1"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session export: JSON participants are derived from event authors without registry snapshots", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { message: "status: export participant proof" },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "claude-mythos",
        sessionId: created.sessionId,
        payload: { message: "audit: export participant proof" },
      }),
      { targetPath: root, syncRemote: false },
    );

    const output = await runSessionCommand([
      "session",
      "export",
      created.sessionId,
      "--format",
      "json",
      "--path",
      root,
    ]);
    const payload = JSON.parse(output);
    assert.equal(payload.agents.length, 0);
    assert.equal(payload.counts.registeredAgents, 0);
    assert.equal(payload.counts.participants, 2);
    assert.equal(payload.counts.agents, 2);
    assert.deepEqual(
      payload.participants.map((participant) => participant.agentId).sort(),
      ["claude-mythos", "codex"],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session download: JSON agentCount reports transcript participants, not registry files", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { message: "status: download participant proof" },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "human-mrrcarter",
        sessionId: created.sessionId,
        payload: { message: "please prove participant counts" },
      }),
      { targetPath: root, syncRemote: false },
    );

    const output = await runSessionCommand([
      "session",
      "download",
      created.sessionId,
      "--path",
      root,
      "--out",
      path.join(root, "download.md"),
      "--json",
    ]);
    const payload = JSON.parse(output);
    assert.equal(payload.registeredAgentCount, 0);
    assert.equal(payload.derivedAgentCount, 2);
    assert.equal(payload.participantCount, 2);
    assert.equal(payload.agentCount, 2);
    assert.deepEqual(
      payload.participants.map((participant) => participant.agentId).sort(),
      ["codex", "human-mrrcarter"],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session download: participant derivation includes join/leave-only speakers", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "agent_join",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { agentId: "codex", role: "coder", status: "idle" },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "agent_leave",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { agentId: "codex", reason: "manual" },
      }),
      { targetPath: root, syncRemote: false },
    );

    const output = await runSessionCommand([
      "session",
      "download",
      created.sessionId,
      "--path",
      root,
      "--out",
      path.join(root, "download-system-only.md"),
      "--json",
    ]);
    const payload = JSON.parse(output);
    assert.equal(payload.eventCount, 2);
    assert.equal(payload.participantCount, 1);
    assert.equal(payload.agentCount, 1);
    assert.deepEqual(
      payload.participants.map((participant) => participant.agentId),
      ["codex"],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
