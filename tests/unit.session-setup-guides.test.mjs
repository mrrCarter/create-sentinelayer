import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { setupSessionGuides } from "../src/session/setup-guides.js";
import { createSession } from "../src/session/store.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-setup-guides-fixture", version: "1.0.0" }, null, 2),
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

function countCoordinationMarkers(text = "") {
  return (String(text || "").match(/SENTINELAYER_SESSION_COORDINATION:START/g) || []).length;
}

async function runSessionCommand(args = []) {
  const program = new Command();
  program.name("sl").exitOverride();
  registerSessionCommand(program);

  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
  }

  return logs.join("\n").trim();
}

test("Unit session setup-guides: generation is idempotent and emits one coordination section", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-setup-guides-idempotent-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const first = await setupSessionGuides(session.sessionId, { targetPath: tempRoot });
    assert.equal(first.agents.sectionCount, 1);
    assert.equal(first.claude.sectionCount, 1);
    assert.equal(first.sessionGuide.changed, true);

    const agentsPath = path.join(tempRoot, "AGENTS.md");
    const claudePath = path.join(tempRoot, "CLAUDE.md");
    const guidePath = path.join(tempRoot, ".sentinelayer", "AGENTS_SESSION_GUIDE.md");
    const firstAgents = await readFile(agentsPath, "utf-8");
    const firstClaude = await readFile(claudePath, "utf-8");
    const firstGuide = await readFile(guidePath, "utf-8");

    assert.equal(countCoordinationMarkers(firstAgents), 1);
    assert.equal(countCoordinationMarkers(firstClaude), 1);
    assert.match(firstGuide, /SentinelLayer Session Guide for AI Agents/);

    const second = await setupSessionGuides(session.sessionId, { targetPath: tempRoot });
    assert.equal(second.agents.changed, false);
    assert.equal(second.claude.changed, false);
    assert.equal(second.sessionGuide.changed, false);
    assert.equal(second.agents.sectionCount, 1);
    assert.equal(second.claude.sectionCount, 1);

    const secondAgents = await readFile(agentsPath, "utf-8");
    const secondClaude = await readFile(claudePath, "utf-8");
    const secondGuide = await readFile(guidePath, "utf-8");
    assert.equal(secondAgents, firstAgents);
    assert.equal(secondClaude, firstClaude);
    assert.equal(secondGuide, firstGuide);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session setup-guides: content outside coordination section is preserved", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-setup-guides-preserve-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const initialAgents = `# AGENTS

Project-wide defaults that must stay untouched.

## Existing Policy
- Keep deterministic tests.

## Final Notes
Do not remove this trailing section.
`;
    const initialClaude = `# CLAUDE

Prelude line that must remain.

## Multi-Agent Session Coordination (SentinelLayer)

Legacy text to replace.
- stale bullet

## Runtime Rules
- Keep this intact.
`;
    await writeFile(path.join(tempRoot, "AGENTS.md"), initialAgents, "utf-8");
    await writeFile(path.join(tempRoot, "CLAUDE.md"), initialClaude, "utf-8");

    const result = await setupSessionGuides(session.sessionId, { targetPath: tempRoot });
    assert.equal(result.agents.sectionCount, 1);
    assert.equal(result.claude.sectionCount, 1);

    const updatedAgents = await readFile(path.join(tempRoot, "AGENTS.md"), "utf-8");
    assert.match(updatedAgents, /Project-wide defaults that must stay untouched\./);
    assert.match(updatedAgents, /## Existing Policy/);
    assert.match(updatedAgents, /## Final Notes/);
    assert.match(updatedAgents, /## Multi-Agent Session Coordination \(SentinelLayer\)/);
    assert.equal(countCoordinationMarkers(updatedAgents), 1);

    const updatedClaude = await readFile(path.join(tempRoot, "CLAUDE.md"), "utf-8");
    assert.match(updatedClaude, /Prelude line that must remain\./);
    assert.match(updatedClaude, /## Runtime Rules/);
    assert.doesNotMatch(updatedClaude, /Legacy text to replace\./);
    assert.equal(countCoordinationMarkers(updatedClaude), 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session setup-guides: `session setup-guides` command emits JSON payload and is idempotent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-setup-guides-command-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const firstOutput = await runSessionCommand([
      "session",
      "setup-guides",
      session.sessionId,
      "--path",
      tempRoot,
      "--json",
    ]);
    const firstPayload = JSON.parse(firstOutput);
    assert.equal(firstPayload.command, "session setup-guides");
    assert.equal(firstPayload.sessionId, session.sessionId);
    assert.equal(firstPayload.agents.changed, true);
    assert.equal(firstPayload.claude.changed, true);
    assert.equal(firstPayload.sessionGuide.changed, true);

    const secondOutput = await runSessionCommand([
      "session",
      "setup-guides",
      session.sessionId,
      "--path",
      tempRoot,
      "--json",
    ]);
    const secondPayload = JSON.parse(secondOutput);
    assert.equal(secondPayload.command, "session setup-guides");
    assert.equal(secondPayload.agents.changed, false);
    assert.equal(secondPayload.claude.changed, false);
    assert.equal(secondPayload.sessionGuide.changed, false);
    assert.equal(secondPayload.agents.sectionCount, 1);
    assert.equal(secondPayload.claude.sectionCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session setup-guides: `session inject-guide` only mutates existing instruction files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-inject-guide-command-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await writeFile(
      path.join(tempRoot, "AGENTS.md"),
      "# AGENTS\n\nKeep this file and append coordination section only.\n",
      "utf-8"
    );

    const output = await runSessionCommand([
      "session",
      "inject-guide",
      session.sessionId,
      "--path",
      tempRoot,
      "--json",
    ]);
    const payload = JSON.parse(output);
    assert.equal(payload.command, "session inject-guide");
    assert.equal(payload.agents.existed, true);
    assert.equal(payload.agents.changed, true);
    assert.equal(payload.agents.sectionCount, 1);
    assert.equal(payload.claude.existed, false);
    assert.equal(payload.claude.changed, false);
    assert.equal(payload.claude.sectionCount, 0);

    const agentsText = await readFile(path.join(tempRoot, "AGENTS.md"), "utf-8");
    assert.match(agentsText, /Keep this file and append coordination section only\./);
    assert.equal(countCoordinationMarkers(agentsText), 1);

    const claudeText = await readOptionalFile(path.join(tempRoot, "CLAUDE.md"));
    assert.equal(claudeText, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
