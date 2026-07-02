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

test("session export: registry snapshots do not downgrade event-derived participant freshness", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    const registered = await registerAgent(created.sessionId, {
      targetPath: root,
      agentId: "codex-live",
      role: "coder",
      model: "gpt-5-codex",
      trackProcessExit: false,
    });
    const staleIso = "2026-01-01T00:00:00.000Z";
    const freshIso = "2026-07-02T20:00:00.000Z";
    const snapshot = JSON.parse(await fsp.readFile(registered.snapshotPath, "utf-8"));
    await fsp.writeFile(
      registered.snapshotPath,
      `${JSON.stringify(
        {
          ...snapshot,
          joinedAt: staleIso,
          lastActivityAt: staleIso,
          updatedAt: staleIso,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex-live",
        agentModel: "gpt-5-codex",
        sessionId: created.sessionId,
        ts: freshIso,
        payload: { message: "fresh participant activity proof" },
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
    const participant = payload.participants.find((item) => item.agentId === "codex-live");
    assert.ok(participant);
    assert.equal(participant.source, "events+registry");
    assert.equal(participant.lastActivityAt, participant.lastSeen);
    assert.equal(Date.parse(participant.lastActivityAt) >= Date.parse(freshIso), true);
    assert.equal(Date.parse(participant.lastActivityAt) > Date.parse(staleIso), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session export: empty transcript has stable zero counts", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
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
    assert.equal(payload.counts.rawEvents, 0);
    assert.equal(payload.counts.hiddenControlEvents, 0);
    assert.equal(payload.counts.events, 0);
    assert.equal(payload.counts.participants, 0);
    assert.deepEqual(payload.events, []);
    assert.deepEqual(payload.participants, []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session export: sequence-bearing events stay in durable sequence order across timestamp skew", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_usage",
        agentId: "omargate-security",
        sessionId: created.sessionId,
        cursor: "000000000012:0000000c",
        sequenceId: 12,
        ts: "2026-07-01T05:00:00.000Z",
        payload: {
          schema: "billing/v1",
          action: "omargate_deep",
          totalTokens: 10,
          providerCostUsd: 0.01,
        },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_usage",
        agentId: "omargate-testing",
        sessionId: created.sessionId,
        cursor: "000000000011:0000000b",
        sequenceId: 11,
        ts: "2026-07-01T05:00:00.001Z",
        payload: {
          schema: "billing/v1",
          action: "omargate_deep",
          totalTokens: 5,
          providerCostUsd: 0.005,
        },
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
    assert.deepEqual(
      payload.events.map((event) => event.sequenceId),
      [11, 12],
    );
    assert.deepEqual(
      payload.events.map((event) => event.cursor),
      ["000000000011:0000000b", "000000000012:0000000c"],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session export: omits control events by default and includes them only on request", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { message: "material export proof" },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_listener_heartbeat",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { source: "session_listen", lifecycle: "heartbeat" },
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
    assert.equal(payload.includeControlEvents, false);
    assert.equal(payload.counts.rawEvents, 2);
    assert.equal(payload.counts.hiddenControlEvents, 1);
    assert.equal(payload.counts.events, 1);
    assert.deepEqual(payload.events.map((event) => event.event), ["session_message"]);

    const withControls = JSON.parse(await runSessionCommand([
      "session",
      "export",
      created.sessionId,
      "--format",
      "json",
      "--include-control-events",
      "--path",
      root,
    ]));
    assert.equal(withControls.includeControlEvents, true);
    assert.equal(withControls.counts.hiddenControlEvents, 0);
    assert.deepEqual(
      withControls.events.map((event) => event.event),
      ["session_message", "session_listener_heartbeat"],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session export/download dedupes local enriched canonical message duplicates", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    const message = "status: duplicate local enrichment proof";
    const timestamp = "2026-06-24T01:44:35.221Z";
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex",
        agentModel: "gpt-5",
        sessionId: created.sessionId,
        eventId: "local-enriched-event",
        idempotencyToken: "local-enriched-token",
        ts: timestamp,
        payload: {
          message,
          channel: "session",
          source: "agent",
          to: ["claude-mythos"],
          mentions: { handles: ["claude-mythos"], broadcast: [] },
        },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex",
        sessionId: created.sessionId,
        eventId: "remote-canonical-event",
        idempotencyToken: "remote-canonical-token",
        cursor: "0000000101866:00018dfa",
        sequenceId: 101866,
        ts: "2026-06-24T01:44:35.221000+00:00",
        payload: {
          message,
          channel: "session",
          source: "agent",
          messageId: "remote-message-id",
        },
      }),
      { targetPath: root, syncRemote: false },
    );

    const exported = JSON.parse(await runSessionCommand([
      "session",
      "export",
      created.sessionId,
      "--format",
      "json",
      "--path",
      root,
    ]));
    assert.equal(exported.counts.rawEvents, 2);
    assert.equal(exported.counts.events, 1);
    assert.equal(exported.events[0].sequenceId, 101866);
    assert.equal(exported.events[0].payload.messageId, "remote-message-id");
    assert.deepEqual(exported.events[0].payload.to, ["claude-mythos"]);
    assert.deepEqual(exported.events[0].payload.mentions, {
      handles: ["claude-mythos"],
      broadcast: [],
    });

    const outPath = path.join(root, "download-deduped.md");
    const downloaded = JSON.parse(await runSessionCommand([
      "session",
      "download",
      created.sessionId,
      "--path",
      root,
      "--out",
      outPath,
      "--json",
    ]));
    const markdown = await fsp.readFile(outPath, "utf-8");
    assert.equal(downloaded.rawEventCount, 2);
    assert.equal(downloaded.eventCount, 1);
    assert.equal(markdown.match(new RegExp(message, "g"))?.length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("session export: ndjson emits omission metadata before event rows", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { message: "ndjson material proof" },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_coaching",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { source: "session_listen", message: "coach" },
      }),
      { targetPath: root, syncRemote: false },
    );

    const output = await runSessionCommand([
      "session",
      "export",
      created.sessionId,
      "--format",
      "ndjson",
      "--path",
      root,
    ]);
    const rows = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(rows[0].kind, "session");
    assert.equal(rows[1].kind, "export_metadata");
    assert.equal(rows[1].value.hiddenControlEventCount, 1);
    assert.equal(rows[1].value.rawEventCount, 2);
    assert.equal(rows[1].value.eventCount, 1);
    assert.deepEqual(
      rows.filter((row) => row.kind === "event").map((row) => row.value.event),
      ["session_message"],
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

test("session download: omits control events from markdown and reports hidden count", async () => {
  const root = await makeTempRepo();
  try {
    const created = await createSession({ targetPath: root });
    const outPath = path.join(root, "download-control.md");
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "session_message",
        agentId: "codex",
        sessionId: created.sessionId,
        payload: { message: "material download proof" },
      }),
      { targetPath: root, syncRemote: false },
    );
    await appendToStream(
      created.sessionId,
      createAgentEvent({
        event: "listener_stop",
        agentId: "session-control",
        sessionId: created.sessionId,
        payload: { broadcast: true, reason: "operator_stop" },
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
      outPath,
      "--json",
    ]);
    const payload = JSON.parse(output);
    const markdown = await fsp.readFile(outPath, "utf-8");
    assert.equal(payload.includeControlEvents, false);
    assert.equal(payload.hiddenControlEventCount, 1);
    assert.equal(payload.eventCount, 1);
    assert.match(markdown, /material download proof/);
    assert.doesNotMatch(markdown, /operator_stop/);
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
