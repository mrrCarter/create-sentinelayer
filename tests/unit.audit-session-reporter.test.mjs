import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  createAuditSessionReporter,
  resolveAuditSessionId,
} from "../src/session/audit-reporter.js";
import { createSession, getSession } from "../src/session/store.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "audit-session-reporter-fixture", version: "1.0.0" }, null, 2),
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

test("Unit audit-reporter: resolveAuditSessionId honors explicit id, disable flag, and recency", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-reporter-resolve-"));
  try {
    await seedWorkspace(tempRoot);

    assert.equal(await resolveAuditSessionId({ targetPath: tempRoot, disabled: true }), "");
    assert.equal(
      await resolveAuditSessionId({ targetPath: tempRoot, explicitSessionId: "explicit-id" }),
      "explicit-id"
    );
    assert.equal(await resolveAuditSessionId({ targetPath: tempRoot }), "");

    const older = await createSession({
      targetPath: tempRoot,
      ttlSeconds: 600,
      lastInteractionAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const newer = await createSession({
      targetPath: tempRoot,
      ttlSeconds: 600,
      lastInteractionAt: new Date().toISOString(),
    });

    const resolved = await resolveAuditSessionId({ targetPath: tempRoot });
    assert.equal(resolved, newer.sessionId);
    assert.notEqual(resolved, older.sessionId);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit-reporter: relays lifecycle events into the session stream in order", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-reporter-relay-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 600 });

    const reporter = createAuditSessionReporter({
      sessionId: session.sessionId,
      targetPath: tempRoot,
    });
    assert.ok(reporter);

    reporter.handleEvent({
      event: "phase_start",
      payload: { phase: "dispatch", agentCount: 2, maxParallel: 2 },
    });
    reporter.handleEvent({
      event: "dispatch",
      payload: { agentId: "backend", persona: "Backend Auditor", domain: "backend" },
    });
    reporter.handleEvent({
      event: "agent_complete",
      payload: {
        phase: "dispatch",
        agentId: "backend",
        status: "ok",
        findingCount: 3,
        summary: { P0: 0, P1: 1, P2: 2, P3: 0 },
        confidence: 0.8,
        durationMs: 4200,
      },
    });
    // Ignored event types must not produce messages.
    reporter.handleEvent({ event: "progress", payload: { phase: "dispatch", message: "noise" } });
    reporter.handleEvent({
      event: "phase_complete",
      payload: { phase: "dispatch", agentCount: 2, durationMs: 9000 },
    });

    const relay = await reporter.completed({
      runId: "run-test-1",
      summary: { P0: 0, P1: 1, P2: 2, P3: 0 },
      agentResults: [{ agentId: "backend" }, { agentId: "security" }],
      reportMarkdownPath: path.join(tempRoot, "AUDIT_REPORT.md"),
    });
    assert.equal(relay.posted, 5);
    assert.equal(relay.failed, 0);

    const persisted = await getSession(session.sessionId, { targetPath: tempRoot });
    const events = parseStream(await readFile(persisted.streamPath, "utf-8"));
    const messages = events
      .filter((event) => event.event === "session_message")
      .map((event) => ({ agentId: event.agent?.id, message: event.payload?.message }));

    assert.equal(messages.length, 5);
    assert.equal(messages[0].agentId, "audit-orchestrator");
    assert.ok(messages[0].message.includes("Audit dispatch started: 2 persona(s)"));
    assert.equal(messages[1].agentId, "backend");
    assert.ok(messages[1].message.includes("Starting Backend Auditor audit"));
    assert.equal(messages[2].agentId, "backend");
    assert.ok(messages[2].message.includes("3 finding(s)"));
    assert.ok(messages[2].message.includes("P1=1"));
    assert.equal(messages[3].agentId, "audit-orchestrator");
    assert.ok(messages[3].message.includes("Dispatch complete"));
    assert.equal(messages[4].agentId, "audit-orchestrator");
    assert.ok(messages[4].message.includes("run-test-1"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit-reporter: failures are swallowed and counted, never thrown", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-reporter-fail-"));
  try {
    await seedWorkspace(tempRoot);
    // No such session exists locally — every post should fail quietly.
    const reporter = createAuditSessionReporter({
      sessionId: "00000000-0000-0000-0000-000000000000",
      targetPath: tempRoot,
    });
    reporter.handleEvent({
      event: "dispatch",
      payload: { agentId: "backend", persona: "Backend Auditor", domain: "backend" },
    });
    const relay = await reporter.failed(new Error("boom"));
    assert.equal(relay.posted, 0);
    assert.equal(relay.failed, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit-reporter: returns null without a session id", () => {
  assert.equal(createAuditSessionReporter({ sessionId: "", targetPath: process.cwd() }), null);
});
