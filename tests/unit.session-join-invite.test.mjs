import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-join-invite-fixture", version: "1.0.0" }, null, 2),
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

function fakeJsonResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : ""),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("Unit session join invite: accepts reserved seat before verifying membership", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-join-invite-"));
  const originalFetch = global.fetch;
  const previousEnv = {
    SENTINELAYER_SKIP_REMOTE_SYNC: process.env.SENTINELAYER_SKIP_REMOTE_SYNC,
    SENTINELAYER_TOKEN: process.env.SENTINELAYER_TOKEN,
    SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL,
    SENTINELAYER_DISABLE_KEYRING: process.env.SENTINELAYER_DISABLE_KEYRING,
  };
  try {
    await seedWorkspace(tempRoot);
    delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
    process.env.SENTINELAYER_TOKEN = "test-token";
    process.env.SENTINELAYER_API_URL = "https://api.sentinelayer.com";
    process.env.SENTINELAYER_DISABLE_KEYRING = "1";

    const calls = [];
    global.fetch = async (url, init = {}) => {
      const endpoint = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ endpoint, method, headers: init?.headers || {}, body });
      if (method === "POST" && endpoint.endsWith("/api/v1/sessions/sess-web/invitations/accept")) {
        return fakeJsonResponse(200, {
          ok: true,
          sessionId: "sess-web",
          member: { role: "viewer", userId: "user-1" },
          claimedSeat: {
            seatKey: "codex-seat",
            seatType: "agent",
            status: "claimed",
            claimedAgentId: "codex",
          },
          onboarding: {
            seatKey: "codex-seat",
            agentId: "codex",
            displayName: "Codex",
            role: "reviewer",
            instructions: "Read the room, then review the API diff.",
          },
          capacity: { used: 2, maxMembers: 4, remaining: 2 },
        });
      }
      if (method === "GET" && endpoint.endsWith("/api/v1/sessions/sess-web")) {
        return fakeJsonResponse(200, {
          session: {
            sessionId: "sess-web",
            title: "Web Created Room",
            status: "active",
            eventCount: 7,
            agentCount: 1,
            lastActivityAt: "2026-06-22T04:00:00.000Z",
          },
        });
      }
      if (method === "GET" && endpoint.includes("/api/v1/sessions/sess-web/events/before?")) {
        return fakeJsonResponse(200, { events: [], beforeSequence: null });
      }
      if (method === "POST" && endpoint.endsWith("/api/v1/sessions/sess-web/events")) {
        return fakeJsonResponse(200, { ok: true });
      }
      return fakeJsonResponse(404, { error: { code: "NOT_FOUND" } });
    };

    const output = await runSessionCommand([
      "session",
      "join",
      "sess-web",
      "--invite-token",
      "invite-token-1234567890",
      "--seat-key",
      "codex-seat",
      "--path",
      tempRoot,
      "--json",
    ]);
    const payload = JSON.parse(output);

    const acceptIndex = calls.findIndex((call) => call.endpoint.includes("/invitations/accept"));
    const verifyIndex = calls.findIndex(
      (call) => call.method === "GET" && call.endpoint.endsWith("/api/v1/sessions/sess-web"),
    );
    const joinEventIndex = calls.findIndex(
      (call) => call.method === "POST" && call.endpoint.endsWith("/api/v1/sessions/sess-web/events"),
    );
    assert.ok(acceptIndex >= 0, "invite accept call should be made");
    assert.ok(verifyIndex >= 0, "session verification call should be made");
    assert.ok(joinEventIndex >= 0, "accepted onboarding agent id should relay agent_join");
    assert.ok(acceptIndex < verifyIndex, "invite accept must happen before membership verification");
    assert.ok(verifyIndex < joinEventIndex, "agent_join should relay only after membership verification");

    const acceptCall = calls[acceptIndex];
    assert.equal(acceptCall.body.token, "invite-token-1234567890");
    assert.equal(acceptCall.body.seatKey, "codex-seat");
    assert.equal("agentId" in acceptCall.body, false);
    assert.equal(acceptCall.headers.Origin, "https://sentinelayer.com");
    assert.equal(acceptCall.headers["Sec-Fetch-Site"], "same-site");
    assert.equal(acceptCall.headers["X-Sentinelayer-Session-Mutation"], "session-mutation");
    assert.equal(String(acceptCall.headers["X-CSRF-Token"] || "").length, 64);
    assert.match(String(acceptCall.headers["Idempotency-Key"] || ""), /^sl-cli-session-invite-accept-/);

    assert.equal(payload.command, "session join");
    assert.equal(payload.invitationAccepted, true);
    assert.equal(payload.agentId, "codex");
    assert.equal(payload.role, "reviewer");
    assert.equal(payload.agentJoinRelayed, true);
    assert.equal(payload.invitationAccept.claimedSeat.seatKey, "codex-seat");
    assert.equal(payload.invitationAccept.onboarding.instructions, "Read the room, then review the API diff.");
    assert.ok(payload.onboardingGuide.markdownPath.endsWith(path.join("onboarding", "codex.md")));

    const onboardingMarkdown = await readFile(payload.onboardingGuide.markdownPath, "utf-8");
    assert.match(onboardingMarkdown, /Read the room, then review the API diff\./);
    assert.doesNotMatch(onboardingMarkdown, /invite-token-1234567890/);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
