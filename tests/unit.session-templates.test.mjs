import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { getSession } from "../src/session/store.js";
import {
  SESSION_TEMPLATE_REGISTRY_VERSION,
  getTemplateRegistry,
  resolveSessionTemplate,
} from "../src/session/templates.js";

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-template-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
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

test("Unit session templates: registry is versioned and includes expected template ids", () => {
  const registry = getTemplateRegistry();
  assert.equal(registry.registryVersion, SESSION_TEMPLATE_REGISTRY_VERSION);
  assert.ok(Array.isArray(registry.templates));
  const templateIds = registry.templates.map((template) => template.id);
  assert.equal(templateIds.includes("code-review"), true);
  assert.equal(templateIds.includes("security-audit"), true);
  assert.equal(templateIds.includes("e2e-test"), true);
  assert.equal(templateIds.includes("incident-response"), true);
  assert.equal(templateIds.includes("standup"), true);
});

test("Unit session templates: unknown template throws actionable error", () => {
  assert.throws(
    () => resolveSessionTemplate("not-real"),
    /Unknown session template 'not-real'.*session templates --json/
  );
});

test("Unit session templates: `session templates --json` emits template registry", async () => {
  const output = await runSessionCommand(["session", "templates", "--json"]);
  const payload = JSON.parse(output);
  assert.equal(payload.command, "session templates");
  assert.equal(payload.registryVersion, SESSION_TEMPLATE_REGISTRY_VERSION);
  assert.equal(Array.isArray(payload.templates), true);
  assert.equal(payload.templates.some((template) => template.id === "code-review"), true);
});

test("Unit session templates: `session start --template code-review` emits launch plan and persists metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-template-start-"));
  try {
    await seedWorkspace(tempRoot);
    const output = await runSessionCommand([
      "session",
      "start",
      "--template",
      "code-review",
      "--path",
      tempRoot,
      "--json",
    ]);
    const payload = JSON.parse(output);
    assert.equal(payload.command, "session start");
    assert.equal(payload.template.id, "code-review");
    assert.equal(payload.template.registryVersion, SESSION_TEMPLATE_REGISTRY_VERSION);
    assert.equal(payload.ttlSeconds, 8 * 60 * 60);
    assert.equal(Array.isArray(payload.launchPlan), true);
    assert.equal(payload.launchPlan.length, 2);
    assert.equal(payload.launchPlan[0].role, "coder");
    assert.match(payload.launchPlan[0].command, /--name codex-1 --role coder$/);
    assert.equal(payload.launchPlan[1].role, "reviewer");
    assert.match(payload.launchPlan[1].command, /--name claude-1 --role reviewer$/);
    assert.match(String(payload.dashboardUrl || ""), /sentinelayer\.com\/dashboard\/sessions\//);
    assert.match(String(payload.dashboardUrl || ""), new RegExp(`${payload.sessionId}$`));

    const session = await getSession(payload.sessionId, { targetPath: tempRoot });
    assert.equal(session?.template?.id, "code-review");
    assert.equal(session?.template?.daemonModel, "gpt-5.4-mini");
    assert.equal(session?.template?.ttlHours, 8);
    assert.equal(Array.isArray(session?.template?.suggestedAgents), true);
    assert.equal(session?.template?.suggestedAgents.length, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session templates: `session start --template code-review` text output shows launch commands", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-template-start-text-"));
  try {
    await seedWorkspace(tempRoot);
    const output = await runSessionCommand([
      "session",
      "start",
      "--template",
      "code-review",
      "--path",
      tempRoot,
    ]);
    assert.match(output, /Launch your agents:/);
    assert.match(output, /Terminal 1 \(coder\): sl session join .* --name codex-1 --role coder/);
    assert.match(output, /Terminal 2 \(reviewer\): sl session join .* --name claude-1 --role reviewer/);
    assert.match(output, /Dashboard: https:\/\/sentinelayer\.com\/dashboard\/sessions\//);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

