import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { buildHandoffPrompt } from "../src/legacy-cli.js";
import {
  bootstrapProjectSession,
  buildProjectSessionWelcomeMessage,
  PROJECT_BOOTSTRAP_AGENT,
} from "../src/session/project-bootstrap.js";
import { getSession } from "../src/session/store.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "project-bootstrap-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseStream(content = "") {
  return String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("Unit project-bootstrap: creates a session, writes guides, and posts the welcome message", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-project-bootstrap-"));
  try {
    await seedWorkspace(tempRoot);

    const result = await bootstrapProjectSession({
      projectDir: tempRoot,
      projectName: "demo-project",
    });

    assert.ok(result.sessionId, "expected a session id");
    assert.equal(result.title, "demo-project");
    assert.ok(result.dashboardUrl.includes(result.sessionId));
    assert.equal(result.welcomePosted, true);
    assert.ok(result.guides, "expected guides to be written by default");

    const session = await getSession(result.sessionId, { targetPath: tempRoot });
    assert.ok(session, "expected session to be materialized locally");
    assert.equal(session.status, "active");
    assert.equal(session.title, "demo-project");

    const events = parseStream(await readFile(session.streamPath, "utf-8"));
    const welcome = events.find(
      (event) =>
        event.event === "session_message" && event.agent?.id === PROJECT_BOOTSTRAP_AGENT.id
    );
    assert.ok(welcome, "expected a welcome session_message from project-bootstrap");
    assert.ok(welcome.payload.message.includes(`sl session join ${result.sessionId}`));

    const agentsGuide = await readOptionalFile(path.join(tempRoot, "AGENTS.md"));
    assert.ok(agentsGuide, "expected AGENTS.md to exist");
    assert.ok(agentsGuide.includes("SENTINELAYER_SESSION_COORDINATION:START"));
    const claudeGuide = await readOptionalFile(path.join(tempRoot, "CLAUDE.md"));
    assert.ok(claudeGuide, "expected CLAUDE.md to exist");
    assert.ok(claudeGuide.includes("SENTINELAYER_SESSION_COORDINATION:START"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit project-bootstrap: skipGuides leaves instruction files untouched", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-project-bootstrap-skip-"));
  try {
    await seedWorkspace(tempRoot);

    const result = await bootstrapProjectSession({
      projectDir: tempRoot,
      projectName: "demo-skip-guides",
      skipGuides: true,
    });

    assert.ok(result.sessionId);
    assert.equal(result.guides, null);
    assert.equal(await readOptionalFile(path.join(tempRoot, "AGENTS.md")), null);
    assert.equal(await readOptionalFile(path.join(tempRoot, "CLAUDE.md")), null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit project-bootstrap: welcome message and handoff prompt advertise the session", () => {
  const message = buildProjectSessionWelcomeMessage({
    projectName: "acme",
    sessionId: "session-123",
  });
  assert.ok(message.includes('"acme"'));
  assert.ok(message.includes("sl session join session-123"));
  assert.ok(message.includes("sl session say session-123"));

  const withSession = buildHandoffPrompt({
    projectName: "acme",
    repoSlug: "owner/acme",
    secretName: "SENTINELAYER_TOKEN",
    buildFromExistingRepo: false,
    authMode: "sentinelayer",
    codingAgent: "claude-code",
    sessionId: "session-123",
  });
  assert.ok(withSession.includes("Project senti session (auto-created at init): `session-123`"));
  assert.ok(withSession.includes("sl session join session-123"));

  const withoutSession = buildHandoffPrompt({
    projectName: "acme",
    repoSlug: "owner/acme",
    secretName: "SENTINELAYER_TOKEN",
    buildFromExistingRepo: false,
    authMode: "sentinelayer",
    codingAgent: "claude-code",
  });
  assert.ok(withoutSession.includes("## Multi-Agent Coordination (if session active)"));
  assert.ok(!withoutSession.includes("session-123"));
});
