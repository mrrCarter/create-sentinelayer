import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  SESSION_INVITATION_ACCEPT_ROUTE_ID,
  acceptSessionInvitation,
  createSessionMutationHeaders,
  normalizeSessionOnboarding,
  writeSessionOnboardingBrief,
} from "../src/session/invitations.js";

function jsonResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : ""),
    },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

test("Unit session invitations: session mutation headers match API CSRF contract", () => {
  const headers = createSessionMutationHeaders({
    bearerToken: "test-token",
    sessionId: "sess-members",
    routeId: SESSION_INVITATION_ACCEPT_ROUTE_ID,
    idempotencyKey: "invite-accept-1",
  });

  assert.equal(headers.Authorization, "Bearer test-token");
  assert.equal(headers.Origin, "https://sentinelayer.com");
  assert.equal(headers["Sec-Fetch-Site"], "same-site");
  assert.equal(headers["X-Sentinelayer-Session-Mutation"], "session-mutation");
  assert.equal(
    headers["X-CSRF-Token"],
    "f1dea86970dec3875f70e858bc01d09f1683021a740a8afe73d51e5dc6116a0a",
  );
});

test("Unit session invitations: accept posts token, seat, agent, idempotency, and CSRF headers", async () => {
  const calls = [];
  const result = await acceptSessionInvitation("sess-members", {
    targetPath: process.cwd(),
    invitationToken: "invite-token-1234567890",
    seatKey: "codex-seat",
    agentId: "codex",
    idempotencyKey: "invite-accept-1",
    resolveAuthSession: async () => ({
      token: "test-token",
      apiUrl: "https://api.sentinelayer.com",
    }),
    requestMutation: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        claimedSeat: { seatKey: "codex-seat", seatType: "agent" },
        onboarding: { agentId: "codex", role: "coder", instructions: "Use todo and lessons." },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.sentinelayer.com/api/v1/sessions/sess-members/invitations/accept",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.operationName, "session.invitation_accept");
  assert.equal(calls[0].init.idempotencyKey, "invite-accept-1");
  assert.deepEqual(calls[0].init.body, {
    token: "invite-token-1234567890",
    seatKey: "codex-seat",
    agentId: "codex",
  });
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
  assert.equal(calls[0].init.headers["X-Sentinelayer-Session-Mutation"], "session-mutation");
  assert.equal(calls[0].init.headers["X-CSRF-Token"].length, 64);
  assert.equal(result.idempotencyKey, "invite-accept-1");
  assert.equal(result.result.onboarding.agentId, "codex");
});

test("Unit session invitations: onboarding normalizer falls back to claimed seat payload", () => {
  const normalized = normalizeSessionOnboarding(null, {
    seatKey: "codex-seat",
    seatType: "agent",
    displayName: "Codex",
    role: "reviewer",
    agentId: "codex-reserved",
    claimedAgentId: "codex",
    instructions: "Use the reserved seat instructions.",
  });

  assert.deepEqual(normalized, {
    seatKey: "codex-seat",
    agentId: "codex",
    displayName: "Codex",
    role: "reviewer",
    instructions: "Use the reserved seat instructions.",
  });
});

test("Unit session invitations: onboarding brief persists SOUL instructions without invite token", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-onboarding-"));
  try {
    const written = await writeSessionOnboardingBrief("sess-onboarding", {
      targetPath: tempRoot,
      agentId: "codex",
      claimedSeat: { seatKey: "codex-seat", seatType: "agent" },
      onboarding: {
        seatKey: "codex-seat",
        agentId: "codex",
        displayName: "Codex",
        role: "coder",
        instructions: "Use todo and lessons.",
      },
    });

    assert.ok(written.markdownPath.endsWith(path.join("onboarding", "codex.md")));
    const markdown = await readFile(written.markdownPath, "utf-8");
    const json = JSON.parse(await readFile(written.jsonPath, "utf-8"));
    assert.match(markdown, /SOUL Instructions/);
    assert.match(markdown, /Use todo and lessons\./);
    assert.match(markdown, /Session Etiquette/);
    assert.match(markdown, /sl session reply/);
    assert.match(markdown, /sl session react <id> ack/);
    assert.match(markdown, /tasks\/todo\.md/);
    assert.match(markdown, /tasks\/lessons\.md/);
    assert.doesNotMatch(markdown, /invite-token/);
    assert.equal(json.onboarding.agentId, "codex");
    assert.equal(json.claimedSeat.seatKey, "codex-seat");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session invitations: json response helper remains strict enough for requestJson-style mocks", async () => {
  const response = jsonResponse(200, { ok: true });
  assert.equal(response.ok, true);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
});
