import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

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
import { readStoredSession, resolveCredentialsFilePath } from "../src/auth/session-store.js";

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

async function startAuthRuntimeMockApi({ pollResponses = null } = {}) {
  const state = {
    pollCalls: 0,
    tokenIssueCalls: 0,
    tokenDeleteIds: [],
    statusCalls: 0,
  };
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
        if (Array.isArray(pollResponses) && pollResponses.length > 0) {
          const pollResponse = pollResponses[Math.min(state.pollCalls - 1, pollResponses.length - 1)];
          return jsonResponse(res, Number(pollResponse.httpStatus || 200), pollResponse.payload || {});
        }
        if (state.pollCalls === 1) {
          return jsonResponse(res, 200, { status: "pending" });
        }
        return jsonResponse(res, 200, {
          status: "approved",
          auth_token: "auth_token_web_1",
          aidenid_credentials: {
            provisioned: true,
            org_id: "org_1",
            project_id: "proj_1",
            api_key_prefix: "aid_",
            provisioned_at: "2026-04-01T00:00:00.000Z",
          },
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
          },
        });
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
        await readJsonBody(req);
        state.tokenIssueCalls += 1;
        return jsonResponse(res, 200, {
          id: `token_${state.tokenIssueCalls}`,
          token: `api_token_${state.tokenIssueCalls}`,
          token_prefix: "api_token_",
          expires_at: "2027-04-01T00:00:00.000Z",
        });
      }

      if (req.method === "DELETE" && pathname.startsWith("/api/v1/auth/api-tokens/")) {
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
    assert.equal(Object.prototype.hasOwnProperty.call(activeSession || {}, "aidenid"), true);

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
    assert.equal(Object.prototype.hasOwnProperty.call(authStatus, "aidenid"), true);

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

test("Unit auth service: login poll tolerates transient transport failures", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [
      {
        httpStatus: 503,
        payload: {
          error: {
            code: "TEMPORARY_UNAVAILABLE",
            message: "Retry shortly",
          },
        },
      },
      {
        httpStatus: 200,
        payload: { status: "pending" },
      },
      {
        httpStatus: 200,
        payload: {
          status: "approved",
          auth_token: "auth_token_web_1",
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
          },
        },
      },
    ],
  });

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
    assert.equal(loginResult.user.githubUsername, "demo-user");
    assert.equal(mock.state.pollCalls, 3);
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

test("Unit auth service: login fails fast when poll status is rejected", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-unit-"));
  const mock = await startAuthRuntimeMockApi({
    pollResponses: [{ httpStatus: 200, payload: { status: "rejected" } }],
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
      /CLI authentication was not approved/
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

test("Unit auth service: env and project config token precedence is deterministic", async () => {
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

    const projectSession = await resolveActiveAuthSession({
      cwd: tempRoot,
      env: {},
      explicitApiUrl: "https://api.example.com",
      autoRotate: false,
      homeDir: tempRoot,
    });
    assert.equal(projectSession?.source, "config");
    assert.equal(projectSession?.token, "project_token");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
