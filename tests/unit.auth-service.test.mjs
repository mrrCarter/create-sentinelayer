import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  getAuthStatus,
  getRuntimeRunStatus,
  listStoredAuthSessions,
  listRuntimeRunEvents,
  loginAndPersistSession,
  logoutSession,
  revokeAuthToken,
  resolveActiveAuthSession,
} from "../src/auth/service.js";
import { SentinelayerApiError } from "../src/auth/http.js";
import {
  readStoredSession,
  resolveCredentialsFilePath,
  writeStoredSession,
} from "../src/auth/session-store.js";

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

async function startAuthRuntimeMockApi({ pollResponses = null, rejectDeleteAuthToken = "" } = {}) {
  const state = {
    pollCalls: 0,
    tokenIssueCalls: 0,
    tokenIssueBodies: [],
    tokenDeleteIds: [],
    tokenDeleteAuthHeaders: [],
    statusCalls: 0,
  };
  const defaultPollResponses = [
    { status: "pending" },
    {
      status: "approved",
      auth_token: "auth_token_web_1",
      user: {
        id: "user_1",
        github_username: "demo-user",
        email: "demo@example.com",
      },
    },
  ];
  const resolvedPollResponses =
    Array.isArray(pollResponses) && pollResponses.length > 0 ? pollResponses : defaultPollResponses;
  const runtimeEvents = [
    {
      event_id: "evt_1",
      run_id: "run-1",
      ts: "2026-04-01T00:00:00.000Z",
      type: "run_started",
      actor: "orchestrator",
      payload: { summary: "runtime started" },
      duration_ms: 0,
      token_usage: 0,
      cost_usd: 0,
    },
    {
      event_id: "evt_2",
      run_id: "run-1",
      ts: "2026-04-01T00:00:01.000Z",
      type: "reasoning_summary",
      actor: "orchestrator",
      payload: { summary: "running checks" },
      duration_ms: 25,
      token_usage: 120,
      cost_usd: 0.0008,
    },
  ];

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = parsedUrl.pathname;

      if (req.method === "POST" && pathname === "/api/v1/auth/cli/sessions/start") {
        await readJsonBody(req);
        return jsonResponse(res, 200, {
          session_id: "sess_1",
          authorize_url: "http://127.0.0.1/cli-auth?session_id=sess_1",
          poll_interval_seconds: 0,
        });
      }

      if (req.method === "POST" && pathname === "/api/v1/auth/cli/sessions/poll") {
        await readJsonBody(req);
        state.pollCalls += 1;
        const pollIndex = Math.min(state.pollCalls - 1, resolvedPollResponses.length - 1);
        return jsonResponse(res, 200, resolvedPollResponses[pollIndex]);
      }

      if (req.method === "GET" && pathname === "/api/v1/auth/me") {
        const authHeader = String(req.headers.authorization || "");
        if (!authHeader.startsWith("Bearer ")) {
          return jsonResponse(res, 401, {
            error: { code: "AUTH_REQUIRED", message: "Missing bearer token" },
          });
        }
        return jsonResponse(res, 200, {
          id: "user_1",
          github_username: "demo-user",
          email: "demo@example.com",
        });
      }

      if (req.method === "POST" && pathname === "/api/v1/auth/api-tokens") {
        const body = await readJsonBody(req);
        state.tokenIssueCalls += 1;
        state.tokenIssueBodies.push(body);
        return jsonResponse(res, 200, {
          id: `token_${state.tokenIssueCalls}`,
          token: `api_token_${state.tokenIssueCalls}`,
          token_prefix: "api_token_",
          expires_at: "2027-04-01T00:00:00.000Z",
        });
      }

      if (req.method === "DELETE" && pathname.startsWith("/api/v1/auth/api-tokens/")) {
        const authHeader = String(req.headers.authorization || "");
        state.tokenDeleteAuthHeaders.push(authHeader);
        if (String(rejectDeleteAuthToken || "").trim() && authHeader === `Bearer ${rejectDeleteAuthToken}`) {
          return jsonResponse(res, 401, {
            error: { code: "AUTH_REQUIRED", message: "Token rejected for revoke endpoint" },
          });
        }
        state.tokenDeleteIds.push(pathname.split("/").pop() || "");
        return jsonResponse(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/v1/runtime/runs/run-1/events/list") {
        const afterEventId = String(parsedUrl.searchParams.get("after_event_id") || "").trim();
        if (!afterEventId) {
          return jsonResponse(res, 200, { run_id: "run-1", events: runtimeEvents });
        }
        const index = runtimeEvents.findIndex((event) => event.event_id === afterEventId);
        const nextEvents = index >= 0 ? runtimeEvents.slice(index + 1) : runtimeEvents;
        return jsonResponse(res, 200, { run_id: "run-1", events: nextEvents });
      }

      if (req.method === "GET" && pathname === "/api/v1/runtime/runs/run-1/status") {
        state.statusCalls += 1;
        return jsonResponse(res, 200, {
          run_id: "run-1",
          status: state.statusCalls >= 2 ? "completed" : "running",
          mode: "audit_readonly",
          runtime_profile: "container_readonly",
          repo: "acme/demo",
          ref: "main",
          orchestrator_model: "gpt-5.3-codex",
          subagent_model: "gpt-4o-mini",
          created_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
          max_iterations: 8,
          current_iteration: 1,
          current_stage: "RUNNING",
          total_events: runtimeEvents.length,
        });
      }

      return jsonResponse(res, 404, {
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    } catch (error) {
      return jsonResponse(res, 500, {
        error: {
          code: "TEST_SERVER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve mock API address.");
  }

  return {
    state,
    apiUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

test("Unit auth service: login/status/runtime/list/logout flow remains deterministic", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    const loginResult = await loginAndPersistSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });
    assert.equal(loginResult.apiUrl, mock.apiUrl);
    assert.equal(loginResult.storage, "file");
    assert.equal(loginResult.user.githubUsername, "demo-user");
    assert.equal(mock.state.tokenIssueBodies.length, 1);
    assert.equal(mock.state.tokenIssueBodies[0].scope, "cli_session");

    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    assert.match(credentialsPath, /[\\/]\.sentinelayer[\\/]credentials\.json$/);

    const storedSession = await readStoredSession({ homeDir: tempRoot });
    assert.equal(storedSession?.token, "api_token_1");
    assert.equal(storedSession?.tokenId, "token_1");
    assert.equal(storedSession?.storage, "file");

    const activeSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      autoRotate: false,
    });
    assert.equal(activeSession?.source, "session");
    assert.equal(activeSession?.token, "api_token_1");

    const authStatus = await getAuthStatus({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      checkRemote: true,
      autoRotate: false,
    });
    assert.equal(authStatus.authenticated, true);
    assert.equal(authStatus.remoteUser?.email, "demo@example.com");

    const eventsResponse = await listRuntimeRunEvents({
      apiUrl: mock.apiUrl,
      authToken: activeSession?.token,
      runId: "run-1",
    });
    assert.equal(Array.isArray(eventsResponse.events), true);
    assert.equal(eventsResponse.events.length, 2);

    const statusResponse = await getRuntimeRunStatus({
      apiUrl: mock.apiUrl,
      authToken: activeSession?.token,
      runId: "run-1",
    });
    assert.equal(statusResponse.status, "running");

    const logoutResult = await logoutSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      revokeRemote: true,
    });
    assert.equal(logoutResult.hadStoredSession, true);
    assert.equal(logoutResult.clearedLocal, true);
    assert.equal(logoutResult.revokedRemote, true);
    assert.equal(mock.state.tokenDeleteIds.includes("token_1"), true);

    const clearedSession = await readStoredSession({ homeDir: tempRoot });
    assert.equal(clearedSession, null);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: session metadata listing and explicit revoke are deterministic", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await loginAndPersistSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });

    const listed = await listStoredAuthSessions({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
    });
    assert.equal(listed.apiUrl, mock.apiUrl);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].tokenId, "token_1");
    assert.equal(listed.sessions[0].user.email, "demo@example.com");

    const revoked = await revokeAuthToken({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
    });
    assert.equal(revoked.revokedRemote, true);
    assert.equal(revoked.tokenId, "token_1");
    assert.equal(revoked.matchedStoredSession, true);
    assert.equal(revoked.clearedLocal, true);
    assert.equal(mock.state.tokenDeleteIds.includes("token_1"), true);

    const clearedSession = await readStoredSession({ homeDir: tempRoot });
    assert.equal(clearedSession, null);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: env token bypasses legacy config and legacy plaintext config is rejected", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  try {
    await writeFile(path.join(tempRoot, ".sentinelayer.yml"), "sentinelayerToken: project_token\n", "utf-8");

    const envSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {
        SENTINELAYER_TOKEN: "env_token",
      },
      explicitApiUrl: "https://api.example.com",
      autoRotate: false,
      homeDir: tempRoot,
    });
    assert.equal(envSession?.source, "env");
    assert.equal(envSession?.token, "env_token");
    await assert.rejects(
      () =>
        resolveActiveAuthSession({
          cwd: tempRoot,
          env: {},
          explicitApiUrl: "https://api.example.com",
          autoRotate: false,
          homeDir: tempRoot,
        }),
      /plaintext secrets .* blocked/i
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: keyring-backed metadata without keyring fails closed and logout clears local state", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  try {
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(
      credentialsPath,
      `${JSON.stringify(
        {
          version: 1,
          apiUrl: "https://api.sentinelayer.dev",
          storage: "keyring",
          keyringService: "sentinelayer-cli",
          keyringAccount: "default-simulated",
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
            is_admin: false,
          },
          createdAt: "2026-04-02T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    await assert.rejects(
      () =>
        resolveActiveAuthSession({
          cwd: tempRoot,
          env: {},
          homeDir: tempRoot,
          explicitApiUrl: "https://api.sentinelayer.dev",
          autoRotate: false,
        }),
      (error) => {
        assert.ok(error instanceof SentinelayerApiError);
        assert.equal(error.code, "KEYRING_UNAVAILABLE");
        assert.equal(error.status, 401);
        return true;
      }
    );

    const logoutResult = await logoutSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: "https://api.sentinelayer.dev",
      revokeRemote: true,
    });
    assert.equal(logoutResult.hadStoredSession, true);
    assert.equal(logoutResult.revokedRemote, false);
    assert.equal(logoutResult.clearedLocal, true);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: login fails fast for denied polling status", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        status: "denied",
        message: "Operator denied CLI login.",
        request_id: "req-denied-123",
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: {},
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 5000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          ide: "unit-test",
          cliVersion: "0.0.0-test",
        }),
      (error) => {
        assert.ok(error instanceof SentinelayerApiError);
        assert.equal(error.code, "CLI_AUTH_DENIED");
        assert.equal(error.status, 403);
        assert.equal(error.requestId, "req-denied-123");
        return true;
      }
    );
    assert.equal(mock.state.pollCalls, 1);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: token rotation revoke falls back when new token cannot revoke old token", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({ rejectDeleteAuthToken: "api_token_2" });

  try {
    await loginAndPersistSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });

    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored?.token, "api_token_1");
    await writeStoredSession(
      {
        apiUrl: mock.apiUrl,
        token: stored.token,
        tokenId: stored.tokenId,
        tokenPrefix: stored.tokenPrefix,
        tokenExpiresAt: "2026-04-08T00:00:00.000Z",
        user: stored.user,
      },
      { homeDir: tempRoot }
    );

    const resolved = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      autoRotate: true,
      rotateThresholdDays: 30,
      tokenLabel: "unit-test-rotated",
      tokenTtlDays: 30,
    });

    assert.equal(resolved?.token, "api_token_2");
    assert.equal(resolved?.rotated, true);
    assert.equal(mock.state.tokenDeleteIds.includes("token_1"), true);
    assert.deepEqual(mock.state.tokenDeleteAuthHeaders.slice(0, 2), [
      "Bearer api_token_2",
      "Bearer api_token_1",
    ]);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: login supports explicit privileged token scope override", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await loginAndPersistSession({
      cwd: tempRoot,
      env: {},
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      tokenScope: "github_app_bridge",
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });
    assert.equal(mock.state.tokenIssueBodies.length, 1);
    assert.equal(mock.state.tokenIssueBodies[0].scope, "github_app_bridge");
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: login rejects unknown token scope overrides", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: {},
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 5000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          tokenScope: "global_admin",
          ide: "unit-test",
          cliVersion: "0.0.0-test",
        }),
      /tokenScope must be one of:/
    );
    assert.equal(mock.state.tokenIssueCalls, 0);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
