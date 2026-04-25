// Unit tests for `slc session export` shape.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { createAgentEvent } from "../src/events/schema.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-export-"));
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
