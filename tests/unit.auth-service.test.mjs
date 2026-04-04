import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  __pollCliAuthSessionForTests,
  __readAuthPollResumeStateForTests,
  __resolveAuthPollBackendCooldownForTests,
  __writeAuthPollResumeStateForTests,
  getAuthStatus,
  getRuntimeRunStatus,
  listStoredAuthSessions,
  listRuntimeRunEvents,
  loginAndPersistSession,
  logoutSession,
  revokeAuthToken,
  resolveApiUrl,
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

async function withMockTty(isInteractive, callback) {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: Boolean(isInteractive), configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: Boolean(isInteractive), configurable: true });
    return await callback();
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

async function startAuthRuntimeMockApi({ pollResponses = null, rejectDeleteAuthToken = "" } = {}) {
  const state = {
    pollCalls: 0,
    pollBodies: [],
    pollHeaders: [],
    pollIdempotencyKeys: [],
    tokenIssueCalls: 0,
    tokenIssueBodies: [],
    tokenIssueAuthHeaders: [],
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
        const body = await readJsonBody(req);
        state.pollCalls += 1;
        state.pollBodies.push(body);
        state.pollHeaders.push({
          pollClientId: String(req.headers["x-poll-client-id"] || "").trim(),
          pollWindow: String(req.headers["x-poll-window"] || "").trim(),
          pollCorrelationId: String(req.headers["x-poll-correlation-id"] || "").trim(),
          pollAttempt: String(req.headers["x-poll-attempt"] || "").trim(),
        });
        state.pollIdempotencyKeys.push(String(req.headers["idempotency-key"] || "").trim());
        const pollIndex = Math.min(state.pollCalls - 1, resolvedPollResponses.length - 1);
        const pollPayload = resolvedPollResponses[pollIndex] || {};
        const pollHttpStatus = Number(pollPayload.__httpStatus || 200);
        if (pollHttpStatus >= 400) {
          const errorBody = pollPayload.error || {
            code: String(pollPayload.code || "UPSTREAM_UNAVAILABLE"),
            message: String(pollPayload.message || "Authentication polling backend unavailable."),
            request_id: String(pollPayload.request_id || "").trim() || null,
          };
          return jsonResponse(res, pollHttpStatus, { error: errorBody });
        }
        const responsePayload = { ...pollPayload };
        if (responsePayload.poll_client_id === undefined && responsePayload.pollClientId === undefined) {
          responsePayload.poll_client_id = String(body.poll_client_id || "").trim() || null;
        }
        if (responsePayload.poll_window === undefined && responsePayload.pollWindow === undefined) {
          const normalizedPollWindow = Number(body.poll_window);
          responsePayload.poll_window = Number.isFinite(normalizedPollWindow) ? Math.floor(normalizedPollWindow) : null;
        }
        if (
          responsePayload.poll_correlation_id === undefined &&
          responsePayload.pollCorrelationId === undefined
        ) {
          responsePayload.poll_correlation_id = String(body.poll_correlation_id || "").trim() || null;
        }
        return jsonResponse(res, 200, responsePayload);
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
        state.tokenIssueAuthHeaders.push(String(req.headers.authorization || ""));
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
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      allowFileStorageFallback: true,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });
    assert.equal(loginResult.apiUrl, mock.apiUrl);
    assert.equal(loginResult.storage, "file");
    assert.equal(loginResult.storageDowngraded, true);
    assert.equal(loginResult.user.githubUsername, "demo-user");
    assert.equal(mock.state.tokenIssueBodies.length, 1);
    assert.equal(mock.state.tokenIssueBodies[0].scope, "cli_session");
    assert.equal(mock.state.pollCalls, 2);
    assert.equal(mock.state.pollIdempotencyKeys.length, 2);
    assert.match(mock.state.pollIdempotencyKeys[0], /^[a-f0-9]{64}$/);
    assert.match(mock.state.pollIdempotencyKeys[1], /^[a-f0-9]{64}$/);
    assert.equal(mock.state.pollIdempotencyKeys[0], mock.state.pollIdempotencyKeys[1]);
    assert.equal(mock.state.pollBodies[0].poll_attempt, 0);
    assert.equal(mock.state.pollBodies[1].poll_attempt, 1);
    assert.match(String(mock.state.pollBodies[0].poll_client_id || ""), /^[0-9a-f-]{16,}$/i);
    assert.equal(mock.state.pollBodies[0].poll_client_id, mock.state.pollBodies[1].poll_client_id);
    assert.match(String(mock.state.pollBodies[0].poll_correlation_id || ""), /^[a-f0-9]{64}$/);
    assert.match(String(mock.state.pollBodies[1].poll_correlation_id || ""), /^[a-f0-9]{64}$/);
    assert.notEqual(mock.state.pollBodies[0].poll_correlation_id, mock.state.pollBodies[1].poll_correlation_id);
    assert.equal(
      mock.state.pollHeaders[0].pollClientId,
      String(mock.state.pollBodies[0].poll_client_id || "").trim()
    );
    assert.equal(
      mock.state.pollHeaders[0].pollCorrelationId,
      String(mock.state.pollBodies[0].poll_correlation_id || "").trim()
    );
    assert.equal(mock.state.pollHeaders[0].pollAttempt, "0");
    assert.equal(mock.state.pollHeaders[1].pollAttempt, "1");
    assert.equal(mock.state.tokenIssueAuthHeaders[0], "Bearer auth_token_web_1");
    assert.deepEqual(
      mock.state.pollBodies.map((entry) => entry.session_id),
      ["sess_1", "sess_1"]
    );

    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    assert.match(credentialsPath, /[\\/]\.sentinelayer[\\/]credentials\.json$/);

    const storedSession = await readStoredSession({ homeDir: tempRoot });
    assert.equal(storedSession?.token, "api_token_1");
    assert.equal(storedSession?.tokenId, "token_1");
    assert.equal(storedSession?.storage, "file");

    const activeSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      autoRotate: false,
    });
    assert.equal(activeSession?.source, "session");
    assert.equal(activeSession?.token, "api_token_1");

    const authStatus = await getAuthStatus({
      cwd: tempRoot,
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
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
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
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
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      allowFileStorageFallback: true,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });

    const listed = await listStoredAuthSessions({
      cwd: tempRoot,
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
    });
    assert.equal(listed.apiUrl, mock.apiUrl);
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].tokenId, "token_1");
    assert.equal(listed.sessions[0].user.email, "demo@example.com");

    const revoked = await revokeAuthToken({
      cwd: tempRoot,
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
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
    await writeFile(
      path.join(tempRoot, ".sentinelayer.yml"),
      "sentinelayerToken: sl_project_0123456789abcdef0123456789\n",
      "utf-8"
    );
    const envToken = "sl_env_0123456789abcdef0123456789";

    const envSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {
        SENTINELAYER_TOKEN: envToken,
      },
      explicitApiUrl: "https://api.example.com",
      autoRotate: false,
      homeDir: tempRoot,
    });
    assert.equal(envSession?.source, "env");
    assert.equal(envSession?.token, envToken);
    await assert.rejects(
      () =>
        resolveActiveAuthSession({
          cwd: tempRoot,
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
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

test("Unit auth service: env token rejects leading/trailing whitespace before session resolution", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  try {
    await assert.rejects(
      () =>
        resolveActiveAuthSession({
          cwd: tempRoot,
          env: {
            SENTINELAYER_TOKEN: " sl_env_0123456789abcdef0123456789",
          },
          explicitApiUrl: "https://api.example.com",
          autoRotate: false,
          homeDir: tempRoot,
        }),
      /SL-CONFIG-SECRET-WHITESPACE/i
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: reject insecure non-local HTTP API URL overrides", async () => {
  await assert.rejects(
    () =>
      resolveApiUrl({
        explicitApiUrl: "http://api.example.com",
        env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      }),
    /HTTPS is required/i
  );
});

test("Unit auth service: localhost HTTP API URL requires explicit opt-in flag", async () => {
  await assert.rejects(
    () =>
      resolveApiUrl({
        explicitApiUrl: "http://127.0.0.1:9443",
        env: {},
      }),
    /SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP/i
  );
});

test("Unit auth service: localhost HTTP API URL is allowed only outside CI", async () => {
  const resolved = await resolveApiUrl({
    explicitApiUrl: "http://127.0.0.1:9443",
    env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "true" },
  });
  assert.equal(resolved, "http://127.0.0.1:9443");

  await assert.rejects(
    () =>
      resolveApiUrl({
        explicitApiUrl: "http://127.0.0.1:9443",
        env: {
          SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "true",
          CI: "true",
        },
      }),
    /blocked when CI=true/i
  );
});

test("Unit auth service: poll jitter seed differentiates cooldowns for identical attempts", () => {
  const baseline = __resolveAuthPollBackendCooldownForTests({
    sessionId: "sess_1",
    pollJitterSeed: "seed_alpha",
    attempt: 3,
    consecutiveFailures: 2,
    pollIntervalMs: 800,
  });
  assert.ok(Number.isFinite(baseline));
  const comparisons = ["seed_bravo", "seed_charlie", "seed_delta", "seed_echo"].map((seed) =>
    __resolveAuthPollBackendCooldownForTests({
      sessionId: "sess_1",
      pollJitterSeed: seed,
      attempt: 3,
      consecutiveFailures: 2,
      pollIntervalMs: 800,
    })
  );
  for (const comparison of comparisons) {
    assert.ok(Number.isFinite(comparison));
  }
  assert.ok(
    comparisons.some((comparison) => comparison !== baseline),
    "Expected at least one distinct cooldown across jitter seeds."
  );
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
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
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
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
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
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 5000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          allowFileStorageFallback: true,
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
    assert.ok(mock.state.pollCalls >= 1);
    assert.ok(mock.state.pollCalls <= 2);
    assert.equal(mock.state.pollIdempotencyKeys.length, mock.state.pollCalls);
    assert.ok(mock.state.pollIdempotencyKeys.every((entry) => /^[a-f0-9]{64}$/.test(entry)));
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

test("Unit auth service: login rejects mismatched poll session id", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        status: "pending",
        session_id: "sess_mismatch",
        request_id: "req-mismatch-123",
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 5000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          allowFileStorageFallback: true,
          ide: "unit-test",
          cliVersion: "0.0.0-test",
        }),
      (error) => {
        assert.ok(error instanceof SentinelayerApiError);
        assert.equal(error.code, "CLI_AUTH_SESSION_MISMATCH");
        assert.equal(error.status, 502);
        assert.equal(error.requestId, "req-mismatch-123");
        return true;
      }
    );
    assert.equal(mock.state.pollCalls, 1);
    assert.equal(mock.state.pollIdempotencyKeys.length, 1);
    assert.match(mock.state.pollIdempotencyKeys[0], /^[a-f0-9]{64}$/);
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

test("Unit auth service: login ignores stale poll correlation mismatches before approval", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        status: "approved",
        auth_token: "stale_token",
        user: {
          id: "user_1",
          github_username: "demo-user",
          email: "demo@example.com",
        },
        poll_correlation_id: "mismatched-correlation",
        request_id: "req-stale-approval-1",
      },
      {
        status: "approved",
        auth_token: "auth_token_web_1",
        user: {
          id: "user_1",
          github_username: "demo-user",
          email: "demo@example.com",
        },
        request_id: "req-valid-approval-1",
      },
    ],
  });

  try {
    const loginResult = await loginAndPersistSession({
      cwd: tempRoot,
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      allowFileStorageFallback: true,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });
    assert.equal(loginResult.user.githubUsername, "demo-user");
    assert.equal(mock.state.pollCalls, 2);
    assert.equal(mock.state.tokenIssueCalls, 1);
    assert.equal(mock.state.tokenIssueAuthHeaders[0], "Bearer auth_token_web_1");
    assert.equal(mock.state.pollIdempotencyKeys.length, 2);
    assert.notEqual(mock.state.pollIdempotencyKeys[0], "");
    assert.notEqual(mock.state.pollIdempotencyKeys[1], "");
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

test("Unit auth service: login ignores non-increasing poll sequence values", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        status: "pending",
        poll_sequence: 4,
        request_id: "req-seq-4",
      },
      {
        status: "approved",
        auth_token: "stale_token",
        poll_sequence: 4,
        request_id: "req-seq-4-duplicate",
      },
      {
        status: "approved",
        auth_token: "auth_token_web_1",
        poll_sequence: 5,
        request_id: "req-seq-5",
        user: {
          id: "user_1",
          github_username: "demo-user",
          email: "demo@example.com",
        },
      },
    ],
  });

  try {
    const loginResult = await loginAndPersistSession({
      cwd: tempRoot,
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      allowFileStorageFallback: true,
      ide: "unit-test",
      cliVersion: "0.0.0-test",
    });
    assert.equal(loginResult.user.githubUsername, "demo-user");
    assert.equal(mock.state.pollCalls, 3);
    assert.equal(mock.state.tokenIssueCalls, 1);
    assert.equal(mock.state.tokenIssueAuthHeaders[0], "Bearer auth_token_web_1");
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

test("Unit auth service: login maps aborted polling waits to CLI_AUTH_ABORTED", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      { status: "pending" },
      { status: "pending" },
      { status: "pending" },
    ],
  });

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 10_000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          allowFileStorageFallback: true,
          ide: "unit-test",
          cliVersion: "0.0.0-test",
          signal: controller.signal,
        }),
      (error) => {
        assert.ok(error instanceof SentinelayerApiError);
        assert.equal(error.code, "CLI_AUTH_ABORTED");
        assert.equal(error.status, 499);
        return true;
      }
    );
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

test("Unit auth service: login fails closed after repeated polling backend outages", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        __httpStatus: 503,
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "Service unavailable during poll.",
          request_id: "req-backend-down-123",
        },
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 10_000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          allowFileStorageFallback: true,
          ide: "unit-test",
          cliVersion: "0.0.0-test",
        }),
      (error) => {
        assert.ok(error instanceof SentinelayerApiError);
        assert.ok(["CLI_AUTH_BACKEND_UNAVAILABLE", "CLI_AUTH_TIMEOUT"].includes(error.code));
        assert.ok([503, 408].includes(Number(error.status || 0)));
        if (error.code === "CLI_AUTH_BACKEND_UNAVAILABLE") {
          if (error.requestId) {
            assert.equal(error.requestId, "req-backend-down-123");
          }
        }
        return true;
      }
    );
    assert.ok(mock.state.pollCalls >= 3);
    assert.ok(mock.state.pollCalls <= 20);
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

test("Unit auth service: login enforces deterministic polling attempt ceiling", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [{ status: "pending" }],
  });

  try {
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 300,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          allowFileStorageFallback: true,
          ide: "unit-test",
          cliVersion: "0.0.0-test",
        }),
      (error) => {
        assert.ok(error instanceof SentinelayerApiError);
        assert.equal(error.code, "CLI_AUTH_TIMEOUT");
        assert.equal(error.status, 408);
        return true;
      }
    );
    assert.ok(mock.state.pollCalls >= 1);
    assert.ok(mock.state.pollCalls <= 2);
    assert.equal(mock.state.pollIdempotencyKeys.length, mock.state.pollCalls);
    assert.ok(mock.state.pollIdempotencyKeys.every((entry) => /^[a-f0-9]{64}$/.test(entry)));
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

test("Unit auth service: poll resume state persists seen request ids across restarts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const sessionId = "sess_resume_state";
  const pollClientId = "poll_client_resume_state";
  const challenge = "resume-challenge";

  const firstMock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        status: "pending",
        request_id: "req-resume-1",
        poll_sequence: 1,
      },
    ],
  });

  try {
    await assert.rejects(
      () =>
        __pollCliAuthSessionForTests({
          apiUrl: firstMock.apiUrl,
          sessionId,
          pollClientId,
          challenge,
          timeoutMs: 300,
          pollIntervalSeconds: 0.1,
          homeDir: tempRoot,
        }),
      (error) => {
        assert.ok(error instanceof SentinelayerApiError);
        assert.equal(error.code, "CLI_AUTH_TIMEOUT");
        assert.equal(error.status, 408);
        return true;
      }
    );
    assert.ok(firstMock.state.pollCalls >= 1);
  } finally {
    await firstMock.close();
  }

  const secondMock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        status: "denied",
        request_id: "req-resume-1",
        poll_sequence: 1,
        message: "stale denial replay",
      },
      {
        status: "approved",
        auth_token: "auth_token_resume_1",
        request_id: "req-resume-2",
        poll_sequence: 2,
        user: {
          id: "user_1",
          github_username: "demo-user",
          email: "demo@example.com",
        },
      },
    ],
  });

  try {
    const approval = await __pollCliAuthSessionForTests({
      apiUrl: secondMock.apiUrl,
      sessionId,
      pollClientId,
      challenge,
      timeoutMs: 5000,
      pollIntervalSeconds: 0.1,
      homeDir: tempRoot,
    });
    assert.equal(approval.auth_token, "auth_token_resume_1");
    assert.equal(secondMock.state.pollCalls, 2);
  } finally {
    await secondMock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth service: poll resume state merges monotonic fields under concurrent writes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const sessionId = "sess_resume_merge";
  const pollClientId = "poll_client_resume_merge";
  try {
    await Promise.all([
      __writeAuthPollResumeStateForTests({
        sessionId,
        pollClientId,
        highestSeenPollSequence: 2,
        nextAttempt: 2,
        seenRequestIds: ["req-1", "req-2"],
        homeDir: tempRoot,
      }),
      __writeAuthPollResumeStateForTests({
        sessionId,
        pollClientId,
        highestSeenPollSequence: 7,
        nextAttempt: 4,
        seenRequestIds: ["req-3"],
        homeDir: tempRoot,
      }),
      __writeAuthPollResumeStateForTests({
        sessionId,
        pollClientId,
        highestSeenPollSequence: 4,
        nextAttempt: 9,
        seenRequestIds: ["req-4", "req-2"],
        homeDir: tempRoot,
      }),
    ]);
    const persisted = await __readAuthPollResumeStateForTests({
      sessionId,
      homeDir: tempRoot,
    });
    assert.ok(persisted);
    assert.equal(persisted.highestSeenPollSequence, 7);
    assert.equal(persisted.nextAttempt, 9);
    assert.deepEqual([...persisted.seenRequestIds].sort(), ["req-1", "req-2", "req-3", "req-4"]);
  } finally {
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
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
      homeDir: tempRoot,
      explicitApiUrl: mock.apiUrl,
      skipBrowserOpen: true,
      timeoutMs: 5000,
      tokenLabel: "unit-test-token",
      tokenTtlDays: 30,
      allowFileStorageFallback: true,
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
      { homeDir: tempRoot, allowFileStorageFallback: true }
    );

    const resolved = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
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

test("Unit auth service: privileged token scope requires explicit opt-in flag", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await assert.rejects(
      () =>
        loginAndPersistSession({
          cwd: tempRoot,
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 5000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          tokenScope: "github_app_bridge",
          allowFileStorageFallback: true,
          ide: "unit-test",
          cliVersion: "0.0.0-test",
        }),
      /requires explicit privileged approval/i
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

test("Unit auth service: login supports explicit privileged token scope override", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await withMockTty(true, async () => {
      await loginAndPersistSession({
        cwd: tempRoot,
        env: {
          SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1",
          SENTINELAYER_PRIVILEGED_SCOPE_CONFIRM: "I_ACKNOWLEDGE_GITHUB_APP_BRIDGE_SCOPE",
        },
        homeDir: tempRoot,
        explicitApiUrl: mock.apiUrl,
        skipBrowserOpen: true,
        timeoutMs: 5000,
        tokenLabel: "unit-test-token",
        tokenTtlDays: 30,
        tokenScope: "github_app_bridge",
        allowPrivilegedScope: true,
        allowFileStorageFallback: true,
        ide: "unit-test",
        cliVersion: "0.0.0-test",
      });
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

test("Unit auth service: privileged token scope rejects non-interactive sessions", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await withMockTty(false, async () => {
      await assert.rejects(
        () =>
          loginAndPersistSession({
            cwd: tempRoot,
            env: {
              SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1",
              SENTINELAYER_PRIVILEGED_SCOPE_CONFIRM: "I_ACKNOWLEDGE_GITHUB_APP_BRIDGE_SCOPE",
            },
            homeDir: tempRoot,
            explicitApiUrl: mock.apiUrl,
            skipBrowserOpen: true,
            timeoutMs: 5000,
            tokenLabel: "unit-test-token",
            tokenTtlDays: 30,
            tokenScope: "github_app_bridge",
            allowPrivilegedScope: true,
            allowFileStorageFallback: true,
            ide: "unit-test",
            cliVersion: "0.0.0-test",
          }),
        /requires interactive tty consent/i
      );
    });
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

test("Unit auth service: privileged token scope requires policy confirmation token", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi();

  try {
    await withMockTty(true, async () => {
      await assert.rejects(
        () =>
          loginAndPersistSession({
            cwd: tempRoot,
            env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
            homeDir: tempRoot,
            explicitApiUrl: mock.apiUrl,
            skipBrowserOpen: true,
            timeoutMs: 5000,
            tokenLabel: "unit-test-token",
            tokenTtlDays: 30,
            tokenScope: "github_app_bridge",
            allowPrivilegedScope: true,
            allowFileStorageFallback: true,
            ide: "unit-test",
            cliVersion: "0.0.0-test",
          }),
        /requires policy confirmation/i
      );
    });
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
          env: { SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP: "1" },
          homeDir: tempRoot,
          explicitApiUrl: mock.apiUrl,
          skipBrowserOpen: true,
          timeoutMs: 5000,
          tokenLabel: "unit-test-token",
          tokenTtlDays: 30,
          tokenScope: "global_admin",
          allowFileStorageFallback: true,
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
