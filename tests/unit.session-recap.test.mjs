import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { validateAgentEvent } from "../src/events/schema.js";
import { registerAgent } from "../src/session/agent-registry.js";
import {
  emitPeriodicRecap,
  shouldEmitRecap,
} from "../src/session/recap.js";
import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-recap-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

test("Unit session recap: joining agent receives context briefing within 2 seconds", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await registerAgent(session.sessionId, {
      agentId: "codex-a1",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    const joined = await registerAgent(session.sessionId, {
      agentId: "claude-b2",
      model: "claude-3.7-sonnet",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const events = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const briefing = events.find(
      (event) =>
        event.event === "context_briefing" &&
        event.agent?.id === "senti" &&
        event.payload?.forAgent === joined.agentId
    );
    assert.ok(briefing);
    assert.equal(validateAgentEvent(briefing, { allowLegacy: false }), true);
    assert.equal(briefing.payload.ephemeral, true);
    assert.equal(briefing.payload.style, "italic-grey");
    assert.match(String(briefing.payload.recap || ""), /While you were away:/);
    const deltaMs = Date.parse(String(briefing.ts || "")) - Date.parse(String(joined.joinedAt || ""));
    assert.equal(deltaMs >= 0 && deltaMs <= 2_000, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: agent-join briefing includes operational rules", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-rules-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const joined = await registerAgent(session.sessionId, {
      agentId: "claude-verifier",
      model: "claude-opus-4-7",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const events = await readStream(session.sessionId, { tail: 50, targetPath: tempRoot });
    const briefing = events.find(
      (event) =>
        event.event === "context_briefing" &&
        event.agent?.id === "senti" &&
        event.payload?.forAgent === joined.agentId,
    );
    assert.ok(briefing);

    const message = String(briefing.payload.message || "");
    const rules = String(briefing.payload.rules || "");

    // payload.message is the rendered briefing the web reads first via payloadText.
    assert.ok(message.length > 0, "briefing payload.message must be non-empty");
    // Rules block is present in both the message and the standalone rules field.
    assert.match(message, /Reading the room/);
    assert.match(message, /Polling cadence/);
    assert.match(message, /Writing back/);
    assert.match(message, /markdown/i);
    assert.match(message, /Stop conditions/);
    assert.match(rules, /Reading the room/);
    assert.match(rules, /sl session read --remote --tail/);
    // Recap text is preserved separately for clients that want just the activity summary.
    assert.match(String(briefing.payload.recap || ""), /(While you were away|no active peers)/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: includeJoinRules=false omits rules from briefing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-norules-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    // Register without auto-emitting; emit manually with includeJoinRules: false.
    const { emitContextBriefing } = await import("../src/session/recap.js");
    const result = await emitContextBriefing(session.sessionId, {
      forAgentId: "test-agent",
      targetPath: tempRoot,
      includeJoinRules: false,
    });

    const message = String(result.event.payload.message || "");
    const rules = result.event.payload.rules;

    assert.equal(rules, null, "rules field should be null when includeJoinRules=false");
    assert.equal(
      /Reading the room/.test(message),
      false,
      "message should not include rules block when opted out",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: periodic recap emits while active and stops after inactivity", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-periodic-"));
  let emitter = null;
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "codex-a1",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "codex-a1",
        payload: { message: "status: implementing recap flow" },
      },
      { targetPath: tempRoot }
    );

    emitter = emitPeriodicRecap(session.sessionId, {
      targetPath: tempRoot,
      intervalMs: 10_000,
      inactivityMs: 140,
      maxEvents: 50,
    });
    await emitter.tickNow();

    const firstPass = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const recaps = firstPass.filter((event) => event.event === "session_recap");
    assert.equal(recaps.length >= 1, true);
    assert.equal(recaps[0].payload.ephemeral, true);
    assert.equal(recaps[0].payload.style, "italic-grey");

    await sleep(220);
    await emitter.tickNow();
    assert.equal(emitter.isRunning(), false);

    const secondPass = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const recapCount = secondPass.filter((event) => event.event === "session_recap").length;
    assert.equal(recapCount, 1);
  } finally {
    if (emitter && emitter.isRunning()) {
      emitter.stop("test_cleanup");
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: shouldEmitRecap triggers on >5 new events or inactivity", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-should-recap-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "agent-alpha",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await registerAgent(session.sessionId, {
      agentId: "agent-beta",
      model: "claude-3.7-sonnet",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const lastReadAt = new Date().toISOString();
    const statusMessages = [
      "status update one",
      "status update two",
      "status update three",
      "status update four",
      "status update five",
      "status update six",
    ];
    for (const message of statusMessages) {
      await appendToStream(
        session.sessionId,
        {
          event: "session_message",
          agentId: "agent-beta",
          payload: { message },
        },
        { targetPath: tempRoot }
      );
    }

    const byEventCount = await shouldEmitRecap(session.sessionId, "agent-alpha", {
      lastReadAt,
      targetPath: tempRoot,
    });
    assert.equal(byEventCount, true);

    const byInactivity = await shouldEmitRecap(session.sessionId, "agent-alpha", {
      lastReadAt: new Date(Date.now() + 1_000).toISOString(),
      targetPath: tempRoot,
      nowIso: new Date(Date.now() + 6 * 60_000).toISOString(),
    });
    assert.equal(byInactivity, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
