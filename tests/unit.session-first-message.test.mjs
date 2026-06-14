import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  FIRST_MESSAGE_AGENT,
  buildFirstSentiMessage,
  postFirstSentiMessage,
} from "../src/session/first-message.js";
import { createSession, getSession } from "../src/session/store.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "first-message-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
}

function parseStream(content = "") {
  return String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("Unit first-message: deterministic content covers the approved protocol", () => {
  const msg = buildFirstSentiMessage({ sessionId: "sess-xyz" });
  // Session id filled, agent id left as a placeholder to substitute.
  assert.ok(msg.includes("session sess-xyz"));
  assert.ok(msg.includes("sl session join sess-xyz --agent <AGENT_ID>"));
  // Reaction policy, threading/nesting, cadence, locks, evidence, lessons+goals.
  assert.ok(/ack —/.test(msg) && /working_on —/.test(msg) && /disregard —/.test(msg));
  assert.ok(msg.includes("--target-action-id")); // nested-reply guidance
  assert.ok(/unrelated/i.test(msg)); // new-post-when-unrelated
  assert.ok(msg.includes("--active-interval 30")); // cadence
  assert.ok(msg.includes("LESSONS") && msg.includes("GOAL note"));
  assert.ok(msg.includes("sl session lock"));
  assert.ok(/evidence:/.test(msg));
  // Per-PR ticket-trail contract (lean), gated on the project having a board.
  assert.ok(/TICKET TRAIL/.test(msg) && /one ticket = one PR/i.test(msg));
  assert.ok(/In-review/.test(msg) && /Blocked/.test(msg));
  // Determinism: same input → identical output.
  assert.equal(msg, buildFirstSentiMessage({ sessionId: "sess-xyz" }));
});

test("Unit first-message: posts as the opening session_message event from senti", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-first-message-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });
    const result = await postFirstSentiMessage({ sessionId: session.sessionId, targetPath: tempRoot });
    assert.equal(result.posted, true);

    const persisted = await getSession(session.sessionId, { targetPath: tempRoot });
    const events = parseStream(await readFile(persisted.streamPath, "utf-8"));
    const first = events.find(
      (e) => e.event === "session_message" && e.agent?.id === FIRST_MESSAGE_AGENT.id,
    );
    assert.ok(first, "expected a first session_message from senti");
    assert.equal(first.payload.firstMessage, true);
    assert.ok(first.payload.message.includes(`sl session join ${session.sessionId}`));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit first-message: missing session id is a no-op, not a throw", async () => {
  const result = await postFirstSentiMessage({ sessionId: "" });
  assert.equal(result.posted, false);
  assert.equal(result.reason, "missing_session_id");
});
