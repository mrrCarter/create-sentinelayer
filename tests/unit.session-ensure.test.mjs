import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { deriveSessionTitle } from "../src/session/senti-naming.js";
import { getSession } from "../src/session/store.js";

process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "1";
process.env.SENTINELAYER_SKIP_SENTI_AUTOSTART = "1";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-ensure-fixture", version: "1.0.0" }, null, 2),
    "utf-8",
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const ok = true;\n", "utf-8");
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
  const originalLog = console.log;
  console.log = (...parts) => logs.push(parts.map((part) => String(part)).join(" "));
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n").trim();
}

async function readMetadata(metadataPath) {
  return JSON.parse(await readFile(metadataPath, "utf-8"));
}

async function writeMetadata(metadataPath, metadata) {
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
}

function fakeJsonResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("Unit session ensure: start without title derives and persists workspace date title", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-title-"));
  try {
    await seedWorkspace(tempRoot);
    const output = await runSessionCommand([
      "session",
      "start",
      "--path",
      tempRoot,
      "--json",
    ]);
    const payload = JSON.parse(output);
    const expectedTitle = deriveSessionTitle(tempRoot);

    assert.equal(payload.command, "session start");
    assert.equal(payload.resumed, false);
    assert.equal(payload.resumeSource, null);
    assert.equal(payload.remoteSync.status, "disabled");
    assert.equal(payload.remoteSync.attempted, false);
    assert.equal(payload.remoteSync.dashboardUrl, payload.dashboardUrl);
    assert.equal(payload.title, expectedTitle);
    assert.equal(payload.titleAuto, true);

    const stored = await getSession(payload.sessionId, { targetPath: tempRoot });
    assert.equal(stored?.title, expectedTitle);
    assert.ok(stored?.lastInteractionAt);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session ensure: repeated ensure within reuse window returns same id", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-ensure-"));
  try {
    await seedWorkspace(tempRoot);
    const first = JSON.parse(
      await runSessionCommand(["session", "ensure", "--path", tempRoot]),
    );
    const second = JSON.parse(
      await runSessionCommand(["session", "ensure", "--path", tempRoot]),
    );

    assert.equal(first.command, "session ensure");
    assert.ok(first.sessionId);
    assert.equal(first.resumed, false);
    assert.equal(first.resumeSource, null);
    assert.equal(first.title, deriveSessionTitle(tempRoot));
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.title, first.title);
    assert.equal(second.resumed, true);
    assert.equal(second.resumeSource, "local");
    assert.equal(second.resumeContext.source, "local");
    assert.equal(second.resumeContext.reuseWindowSeconds, 3600);
    assert.equal(second.resumeContext.reason, "recent_local_session");
    assert.equal(second.remoteSync.status, "disabled");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session ensure: outside reuse window mints a new dated session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-window-"));
  try {
    await seedWorkspace(tempRoot);
    const first = JSON.parse(
      await runSessionCommand([
        "session",
        "ensure",
        "--path",
        tempRoot,
        "--reuse-window-seconds",
        "1",
      ]),
    );
    const stored = await getSession(first.sessionId, { targetPath: tempRoot });
    const oldIso = new Date(Date.now() - 10_000).toISOString();
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const metadata = await readMetadata(stored.metadataPath);
    await writeMetadata(stored.metadataPath, {
      ...metadata,
      createdAt: oldIso,
      updatedAt: oldIso,
      lastInteractionAt: oldIso,
      expiresAt: futureIso,
    });

    const second = JSON.parse(
      await runSessionCommand([
        "session",
        "ensure",
        "--path",
        tempRoot,
        "--reuse-window-seconds",
        "1",
      ]),
    );

    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.resumed, false);
    assert.equal(second.title, deriveSessionTitle(tempRoot));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session ensure: recent local activity resumes even when creation is old", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-activity-"));
  try {
    await seedWorkspace(tempRoot);
    const first = JSON.parse(
      await runSessionCommand([
        "session",
        "ensure",
        "--path",
        tempRoot,
        "--reuse-window-seconds",
        "60",
      ]),
    );
    const stored = await getSession(first.sessionId, { targetPath: tempRoot });
    const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 5_000).toISOString();
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const metadata = await readMetadata(stored.metadataPath);
    await writeMetadata(stored.metadataPath, {
      ...metadata,
      createdAt: oldIso,
      updatedAt: recentIso,
      lastInteractionAt: recentIso,
      expiresAt: futureIso,
    });

    const second = JSON.parse(
      await runSessionCommand([
        "session",
        "ensure",
        "--path",
        tempRoot,
        "--reuse-window-seconds",
        "60",
      ]),
    );

    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.resumed, true);
    assert.equal(second.resumeSource, "local");
    assert.equal(second.resumeContext.lastActivityAt, recentIso);
    assert.equal(second.title, first.title);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session ensure: server-missing local resume is expired and a fresh session is created", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-remote-dead-"));
  const originalFetch = global.fetch;
  const previousEnv = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
    SENTINELAYER_DISABLE_KEYRING: process.env.SENTINELAYER_DISABLE_KEYRING,
  };
  try {
    await seedWorkspace(tempRoot);
    const first = JSON.parse(
      await runSessionCommand(["session", "start", "--path", tempRoot, "--json"]),
    );
    const calls = [];
    delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    process.env.SENTINELAYER_TOKEN = "tok_session_start_reconcile";
    process.env.SENTINELAYER_API_URL = "https://api.sentinelayer.test";
    process.env.SENTINELAYER_DISABLE_KEYRING = "1";
    global.fetch = async (url, init = {}) => {
      const endpoint = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      calls.push({ endpoint, method });
      if (method === "GET" && endpoint.includes(`/api/v1/sessions/${first.sessionId}`)) {
        return fakeJsonResponse(404, { error: "session_not_found" });
      }
      if (method === "GET" && endpoint.includes("/api/v1/sessions?")) {
        return fakeJsonResponse(200, { sessions: [], has_more: false });
      }
      return fakeJsonResponse(200, { ok: true });
    };

    const second = JSON.parse(
      await runSessionCommand(["session", "start", "--path", tempRoot, "--json"]),
    );

    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.resumed, false);
    assert.equal(second.resumeSource, null);
    assert.equal(second.staleResume.sessionId, first.sessionId);
    assert.equal(second.staleResume.reason, "not_found");
    assert.equal(second.staleResume.action, "expired_local_and_created_new");
    assert.equal(second.remoteSync.status, "background_sync_queued");
    assert.equal(calls.some((call) => call.endpoint.includes(`/api/v1/sessions/${first.sessionId}`)), true);

    const oldStored = await getSession(first.sessionId, { targetPath: tempRoot });
    assert.equal(oldStored?.status, "expired");
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session ensure: --no-resume forces a fresh session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-no-resume-"));
  try {
    await seedWorkspace(tempRoot);
    const first = JSON.parse(
      await runSessionCommand(["session", "start", "--path", tempRoot, "--json"]),
    );
    const second = JSON.parse(
      await runSessionCommand([
        "session",
        "start",
        "--path",
        tempRoot,
        "--no-resume",
        "--json",
      ]),
    );

    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.resumed, false);
    assert.equal(second.title, deriveSessionTitle(tempRoot));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
