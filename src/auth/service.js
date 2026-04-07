import crypto from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import open from "open";

import { loadConfig } from "../config/service.js";
import { SentinelayerApiError, requestJson } from "./http.js";
import {
  clearStoredSession,
  readStoredSession,
  readStoredSessionMetadata,
  writeStoredSession,
} from "./session-store.js";

const DEFAULT_API_URL = "https://api.sentinelayer.com";
/** Default maximum wall-clock wait for browser-based CLI auth approval (ms). */
export const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
/** Default lifetime for issued API tokens used by CLI sessions (days). */
export const DEFAULT_API_TOKEN_TTL_DAYS = 365;
/** Default threshold at which stored tokens are rotated before expiry (days). */
export const DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS = 7;
const DEFAULT_IDE_NAME = "sl-cli";

function normalizeApiUrl(rawValue) {
  const candidate = String(rawValue || "").trim() || DEFAULT_API_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid API URL '${candidate}'.`);
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizePositiveNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function toAuthHeader(token) {
  return {
    Authorization: `Bearer ${String(token || "").trim()}`,
  };
}

function normalizeUser(user = {}) {
  return {
    id: String(user.id || "").trim(),
    githubUsername: String(user.githubUsername || user.github_username || "").trim(),
    email: String(user.email || "").trim(),
    avatarUrl: String(user.avatarUrl || user.avatar_url || "").trim(),
    isAdmin: Boolean(user.isAdmin || user.is_admin),
  };
}

function buildApiPath(apiUrl, pathSuffix) {
  return `${normalizeApiUrl(apiUrl)}${String(pathSuffix || "")}`;
}

function generateChallenge() {
  return crypto.randomBytes(48).toString("base64url");
}

function defaultTokenLabel() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `sl-cli-session-${stamp}`;
}

function isNearExpiry(tokenExpiresAt, thresholdDays) {
  const normalized = String(tokenExpiresAt || "").trim();
  if (!normalized) {
    return false;
  }
  const expiryEpoch = Date.parse(normalized);
  if (!Number.isFinite(expiryEpoch)) {
    return false;
  }
  const thresholdMs = Number(thresholdDays || DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS) * 24 * 60 * 60 * 1000;
  return expiryEpoch - Date.now() <= thresholdMs;
}

/**
 * Resolve API URL precedence for auth operations: explicit -> env -> config -> default.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<string>}
 */
export async function resolveApiUrl({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  homeDir,
} = {}) {
  const overrideUrl = String(explicitApiUrl || "").trim();
  if (overrideUrl) {
    return normalizeApiUrl(overrideUrl);
  }

  const envUrl = String(env.SENTINELAYER_API_URL || "").trim();
  if (envUrl) {
    return normalizeApiUrl(envUrl);
  }

  const config = await loadConfig({ cwd, env, homeDir });
  const configuredApiUrl = String(config.resolved.apiUrl || "").trim();
  if (configuredApiUrl) {
    return normalizeApiUrl(configuredApiUrl);
  }

  return normalizeApiUrl(DEFAULT_API_URL);
}

async function startCliAuthSession({ apiUrl, challenge, ide, cliVersion }) {
  return requestJson(buildApiPath(apiUrl, "/api/v1/auth/cli/sessions/start"), {
    method: "POST",
    body: {
      challenge,
      ide: String(ide || DEFAULT_IDE_NAME),
      cli_version: String(cliVersion || "").trim() || null,
    },
  });
}

async function pollCliAuthSession({
  apiUrl,
  sessionId,
  challenge,
  timeoutMs,
  pollIntervalSeconds,
}) {
  const timeout = normalizePositiveNumber(timeoutMs, "timeoutMs", DEFAULT_AUTH_TIMEOUT_MS);
  const pollIntervalMs = Math.max(250, Math.round(Number(pollIntervalSeconds || 2) * 1000));
  const deadline = Date.now() + timeout;
  const isTransientPollError = (error) =>
    error instanceof SentinelayerApiError &&
    (error.code === "NETWORK_ERROR" ||
      error.code === "TIMEOUT" ||
      error.status === 429 ||
      error.status >= 500);

  while (Date.now() < deadline) {
    let payload;
    try {
      payload = await requestJson(buildApiPath(apiUrl, "/api/v1/auth/cli/sessions/poll"), {
        method: "POST",
        body: {
          session_id: sessionId,
          challenge,
        },
      });
    } catch (error) {
      if (isTransientPollError(error)) {
        await sleep(pollIntervalMs);
        continue;
      }
      throw error;
    }

    const status = String(payload.status || "pending").trim().toLowerCase();
    if (status === "approved" && payload.auth_token) {
      return payload;
    }
    if (status === "rejected" || status === "denied" || status === "cancelled") {
      throw new SentinelayerApiError("CLI authentication was not approved.", {
        status: 401,
        code: "CLI_AUTH_REJECTED",
      });
    }
    if (status === "expired") {
      throw new SentinelayerApiError("CLI authentication session expired.", {
        status: 401,
        code: "CLI_AUTH_EXPIRED",
      });
    }

    await sleep(pollIntervalMs);
  }

  throw new SentinelayerApiError("CLI authentication timed out. Restart and try again.", {
    status: 408,
    code: "CLI_AUTH_TIMEOUT",
  });
}

async function fetchCurrentUser({ apiUrl, token }) {
  return requestJson(buildApiPath(apiUrl, "/api/v1/auth/me"), {
    method: "GET",
    headers: toAuthHeader(token),
  });
}

async function issueApiToken({
  apiUrl,
  authToken,
  tokenLabel,
  tokenTtlDays,
}) {
  const expiresInDays = Math.round(
    normalizePositiveNumber(tokenTtlDays, "apiTokenTtlDays", DEFAULT_API_TOKEN_TTL_DAYS)
  );
  return requestJson(buildApiPath(apiUrl, "/api/v1/auth/api-tokens"), {
    method: "POST",
    headers: toAuthHeader(authToken),
    body: {
      label: String(tokenLabel || "").trim() || defaultTokenLabel(),
      scope: "github_app_bridge",
      llm_credential_mode: "managed",
      expires_in_days: expiresInDays,
    },
  });
}

async function revokeApiToken({ apiUrl, authToken, tokenId }) {
  const normalizedTokenId = String(tokenId || "").trim();
  if (!normalizedTokenId) {
    return false;
  }
  await requestJson(buildApiPath(apiUrl, `/api/v1/auth/api-tokens/${encodeURIComponent(normalizedTokenId)}`), {
    method: "DELETE",
    headers: toAuthHeader(authToken),
  });
  return true;
}

async function rotateStoredApiTokenIfNeeded({
  session,
  thresholdDays,
  tokenLabel,
  tokenTtlDays,
  homeDir,
}) {
  if (!session || !session.token || !session.tokenExpiresAt) {
    return { session, rotated: false };
  }
  if (!isNearExpiry(session.tokenExpiresAt, thresholdDays)) {
    return { session, rotated: false };
  }

  const issued = await issueApiToken({
    apiUrl: session.apiUrl,
    authToken: session.token,
    tokenLabel,
    tokenTtlDays,
  });

  const nextSession = await writeStoredSession(
    {
      apiUrl: session.apiUrl,
      token: String(issued.token || ""),
      tokenId: issued.id || null,
      tokenPrefix: issued.token_prefix || null,
      tokenExpiresAt: issued.expires_at || null,
      user: session.user,
    },
    { homeDir }
  );

  if (session.tokenId) {
    try {
      await revokeApiToken({
        apiUrl: session.apiUrl,
        authToken: nextSession.token,
        tokenId: session.tokenId,
      });
    } catch {
      // Ignore revoke failures; new token is already active.
    }
  }

  return {
    session: nextSession,
    rotated: true,
  };
}

/**
 * Perform browser-based CLI login flow and persist an API token session locally.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   skipBrowserOpen?: boolean,
 *   timeoutMs?: number,
 *   tokenLabel?: string,
 *   tokenTtlDays?: number,
 *   ide?: string,
 *   cliVersion?: string,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<{
 *   apiUrl: string,
 *   authorizeUrl: string,
 *   browserOpened: boolean,
 *   user: {
 *     id: string,
 *     githubUsername: string,
 *     email: string,
 *     avatarUrl: string,
 *     isAdmin: boolean
 *   },
 *   tokenId: string | null,
 *   tokenPrefix: string | null,
 *   tokenExpiresAt: string | null,
 *   storage: string,
 *   filePath: string
 * }>}
 */
export async function loginAndPersistSession({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  skipBrowserOpen = false,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  tokenLabel = "",
  tokenTtlDays = DEFAULT_API_TOKEN_TTL_DAYS,
  ide = DEFAULT_IDE_NAME,
  cliVersion = "",
  homeDir,
} = {}) {
  const apiUrl = await resolveApiUrl({ cwd, env, explicitApiUrl, homeDir });
  const challenge = generateChallenge();
  const session = await startCliAuthSession({
    apiUrl,
    challenge,
    ide,
    cliVersion,
  });

  const authorizeUrl = String(session.authorize_url || "").trim();
  let browserOpened = false;
  if (!skipBrowserOpen && authorizeUrl) {
    try {
      await open(authorizeUrl);
      browserOpened = true;
    } catch {
      browserOpened = false;
    }
  }

  const approval = await pollCliAuthSession({
    apiUrl,
    sessionId: String(session.session_id || "").trim(),
    challenge,
    timeoutMs,
    pollIntervalSeconds: Number(session.poll_interval_seconds || 2),
  });

  const approvalToken = String(approval.auth_token || "").trim();
  if (!approvalToken) {
    throw new SentinelayerApiError("Authentication completed but no auth token was returned.", {
      status: 503,
      code: "CLI_AUTH_MISSING_TOKEN",
    });
  }

  const user = normalizeUser(approval.user || (await fetchCurrentUser({ apiUrl, token: approvalToken })));
  const issuedApiToken = await issueApiToken({
    apiUrl,
    authToken: approvalToken,
    tokenLabel,
    tokenTtlDays,
  });

  // Extract AIdenID metadata from approval (no secret stored locally)
  const rawAidenId = approval.aidenidCredentials || approval.aidenid_credentials || null;
  const aidenid =
    rawAidenId && rawAidenId.provisioned
      ? {
          orgId: String(rawAidenId.orgId || rawAidenId.org_id || "").trim() || null,
          projectId: String(rawAidenId.projectId || rawAidenId.project_id || "").trim() || null,
          apiKeyPrefix: String(rawAidenId.apiKeyPrefix || rawAidenId.api_key_prefix || "").trim() || null,
          provisionedAt: new Date().toISOString(),
        }
      : null;

  const stored = await writeStoredSession(
    {
      apiUrl,
      token: String(issuedApiToken.token || ""),
      tokenId: issuedApiToken.id || null,
      tokenPrefix: issuedApiToken.token_prefix || null,
      tokenExpiresAt: issuedApiToken.expires_at || null,
      user,
      aidenid,
    },
    { homeDir }
  );

  return {
    apiUrl,
    authorizeUrl,
    browserOpened,
    user,
    tokenId: stored.tokenId,
    tokenPrefix: stored.tokenPrefix,
    tokenExpiresAt: stored.tokenExpiresAt,
    storage: stored.storage,
    filePath: stored.filePath,
    aidenid: stored.aidenid || null,
  };
}

/**
 * Resolve active auth credentials used by CLI commands, optionally rotating near-expiry session tokens.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   autoRotate?: boolean,
 *   rotateThresholdDays?: number,
 *   tokenLabel?: string,
 *   tokenTtlDays?: number,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<null | {
 *   apiUrl: string,
 *   token: string,
 *   source: "env" | "config" | "session",
 *   user: {
 *     id: string,
 *     githubUsername: string,
 *     email: string,
 *     avatarUrl: string,
 *     isAdmin: boolean
 *   } | null,
 *   storage: string,
 *   tokenId: string | null,
 *   tokenPrefix: string | null,
 *   tokenExpiresAt: string | null,
 *   rotated: boolean,
 *   filePath: string | null
 * }>}
 */
export async function resolveActiveAuthSession({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  autoRotate = true,
  rotateThresholdDays = DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS,
  tokenLabel = "",
  tokenTtlDays = DEFAULT_API_TOKEN_TTL_DAYS,
  homeDir,
} = {}) {
  const apiUrl = await resolveApiUrl({ cwd, env, explicitApiUrl, homeDir });

  const envToken = String(env.SENTINELAYER_TOKEN || "").trim();
  if (envToken) {
    return {
      apiUrl,
      token: envToken,
      source: "env",
      user: null,
      storage: "env",
      tokenId: null,
      tokenPrefix: null,
      tokenExpiresAt: null,
      rotated: false,
      filePath: null,
    };
  }

  const config = await loadConfig({ cwd, env, homeDir });
  const configuredToken = String(config.resolved.sentinelayerToken || "").trim();
  if (configuredToken) {
    return {
      apiUrl,
      token: configuredToken,
      source: "config",
      user: null,
      storage: "config",
      tokenId: null,
      tokenPrefix: null,
      tokenExpiresAt: null,
      rotated: false,
      filePath: null,
    };
  }

  const stored = await readStoredSession({ homeDir });
  if (!stored) {
    return null;
  }

  let active = stored;
  let rotated = false;
  if (autoRotate) {
    try {
      const rotateResult = await rotateStoredApiTokenIfNeeded({
        session: stored,
        thresholdDays: rotateThresholdDays,
        tokenLabel,
        tokenTtlDays,
        homeDir,
      });
      active = rotateResult.session;
      rotated = rotateResult.rotated;
    } catch {
      // Keep existing token if rotation fails.
      active = stored;
      rotated = false;
    }
  }

  return {
    apiUrl,
    token: active.token,
    source: "session",
    user: normalizeUser(active.user || {}),
    storage: active.storage,
    tokenId: active.tokenId || null,
    tokenPrefix: active.tokenPrefix || null,
    tokenExpiresAt: active.tokenExpiresAt || null,
    rotated,
    filePath: active.filePath,
  };
}

/**
 * Return current authentication state, with optional remote `/auth/me` verification.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   checkRemote?: boolean,
 *   autoRotate?: boolean,
 *   rotateThresholdDays?: number,
 *   tokenLabel?: string,
 *   tokenTtlDays?: number,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<{
 *   authenticated: boolean,
 *   apiUrl: string,
 *   source: string | null,
 *   storage: string | null,
 *   user: any,
 *   remoteUser: any,
 *   remoteError: null | { code: string, message: string, status: number, requestId: string | null },
 *   rotated: boolean,
 *   tokenExpiresAt: string | null,
 *   tokenPrefix: string | null,
 *   tokenId: string | null,
 *   filePath: string | null
 * }>}
 */
export async function getAuthStatus({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  checkRemote = true,
  autoRotate = true,
  rotateThresholdDays = DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS,
  tokenLabel = "",
  tokenTtlDays = DEFAULT_API_TOKEN_TTL_DAYS,
  homeDir,
} = {}) {
  const session = await resolveActiveAuthSession({
    cwd,
    env,
    explicitApiUrl,
    autoRotate,
    rotateThresholdDays,
    tokenLabel,
    tokenTtlDays,
    homeDir,
  });

  if (!session) {
    return {
      authenticated: false,
      apiUrl: await resolveApiUrl({ cwd, env, explicitApiUrl, homeDir }),
      source: null,
      storage: null,
      user: null,
      remoteUser: null,
      remoteError: null,
      rotated: false,
      tokenExpiresAt: null,
      tokenPrefix: null,
      tokenId: null,
      filePath: null,
    };
  }

  let remoteUser = null;
  let remoteError = null;
  if (checkRemote) {
    try {
      remoteUser = normalizeUser(await fetchCurrentUser({ apiUrl: session.apiUrl, token: session.token }));
    } catch (error) {
      remoteError =
        error instanceof SentinelayerApiError
          ? {
              code: error.code,
              message: error.message,
              status: error.status,
              requestId: error.requestId,
            }
          : {
              code: "UNKNOWN",
              message: error instanceof Error ? error.message : String(error || "Unknown error"),
              status: 500,
              requestId: null,
            };
    }
  }

  return {
    authenticated: !remoteError,
    apiUrl: session.apiUrl,
    source: session.source,
    storage: session.storage,
    user: session.user,
    remoteUser,
    remoteError,
    rotated: session.rotated,
    tokenExpiresAt: session.tokenExpiresAt,
    tokenPrefix: session.tokenPrefix,
    tokenId: session.tokenId,
    filePath: session.filePath,
  };
}

/**
 * List persisted local session metadata for CLI operators/HITL dashboards.
 *
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, explicitApiUrl?: string, homeDir?: string }} [options]
 * @returns {Promise<{ apiUrl: string, sessions: Array<any> }>}
 */
export async function listStoredAuthSessions({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  homeDir,
} = {}) {
  const apiUrl = await resolveApiUrl({ cwd, env, explicitApiUrl, homeDir });
  const stored = await readStoredSessionMetadata({ homeDir });
  if (!stored) {
    return {
      apiUrl,
      sessions: [],
    };
  }

  return {
    apiUrl,
    sessions: [
      {
        source: "session",
        storage: stored.storage || null,
        tokenId: stored.tokenId || null,
        tokenPrefix: stored.tokenPrefix || null,
        tokenExpiresAt: stored.tokenExpiresAt || null,
        createdAt: stored.createdAt || null,
        updatedAt: stored.updatedAt || null,
        user: normalizeUser(stored.user || {}),
        filePath: stored.filePath || null,
      },
    ],
  };
}

/**
 * Revoke an API token remotely and clear matching local stored session metadata when applicable.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   tokenId?: string,
 *   homeDir?: string
 * }} [options]
 * @returns {Promise<{
 *   apiUrl: string,
 *   source: string,
 *   tokenId: string,
 *   revokedRemote: boolean,
 *   matchedStoredSession: boolean,
 *   clearedLocal: boolean,
 *   filePath: string | null
 * }>}
 */
export async function revokeAuthToken({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  tokenId = "",
  homeDir,
} = {}) {
  const active = await resolveActiveAuthSession({
    cwd,
    env,
    explicitApiUrl,
    autoRotate: false,
    homeDir,
  });
  if (!active || !active.token) {
    throw new SentinelayerApiError("No active auth token found. Run `sl auth login` first.", {
      status: 401,
      code: "AUTH_REQUIRED",
    });
  }

  const targetTokenId = String(tokenId || "").trim() || String(active.tokenId || "").trim();
  if (!targetTokenId) {
    throw new Error(
      "tokenId is required. Provide --token-id or use a stored session that includes token metadata."
    );
  }

  await revokeApiToken({
    apiUrl: active.apiUrl,
    authToken: active.token,
    tokenId: targetTokenId,
  });

  let matchedStoredSession = false;
  let clearedLocal = false;
  let filePath = null;
  const stored = await readStoredSession({ homeDir });
  if (stored && String(stored.tokenId || "").trim() === targetTokenId) {
    matchedStoredSession = true;
    const cleared = await clearStoredSession({ homeDir });
    clearedLocal = Boolean(cleared.hadSession);
    filePath = cleared.filePath || null;
  }

  return {
    apiUrl: active.apiUrl,
    source: active.source,
    tokenId: targetTokenId,
    revokedRemote: true,
    matchedStoredSession,
    clearedLocal,
    filePath,
  };
}

/**
 * Clear local CLI session state and optionally revoke the remote token first.
 *
 * @param {{
 *   homeDir?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   revokeRemote?: boolean
 * }} [options]
 * @returns {Promise<{
 *   hadStoredSession: boolean,
 *   revokedRemote: boolean,
 *   clearedLocal: boolean,
 *   apiUrl?: string,
 *   filePath?: string
 * }>}
 */
export async function logoutSession({
  homeDir,
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  revokeRemote = true,
} = {}) {
  const stored = await readStoredSession({ homeDir });
  if (!stored) {
    return {
      hadStoredSession: false,
      revokedRemote: false,
      clearedLocal: false,
      apiUrl: await resolveApiUrl({ cwd, env, explicitApiUrl, homeDir }),
    };
  }

  let revokedRemote = false;
  if (revokeRemote && stored.tokenId && stored.token) {
    try {
      await revokeApiToken({
        apiUrl: await resolveApiUrl({ cwd, env, explicitApiUrl, homeDir }),
        authToken: stored.token,
        tokenId: stored.tokenId,
      });
      revokedRemote = true;
    } catch {
      revokedRemote = false;
    }
  }

  const cleared = await clearStoredSession({ homeDir });
  return {
    hadStoredSession: true,
    revokedRemote,
    clearedLocal: cleared.hadSession,
    filePath: cleared.filePath,
  };
}

/**
 * Fetch runtime run event stream slices used by `sl watch` and reproducibility artifacts.
 *
 * @param {{
 *   apiUrl: string,
 *   authToken: string,
 *   runId: string,
 *   afterEventId?: string | null
 * }} [options]
 * @returns {Promise<any>}
 */
export async function listRuntimeRunEvents({
  apiUrl,
  authToken,
  runId,
  afterEventId = null,
} = {}) {
  const query = afterEventId
    ? `?after_event_id=${encodeURIComponent(String(afterEventId))}`
    : "";
  return requestJson(
    buildApiPath(apiUrl, `/api/v1/runtime/runs/${encodeURIComponent(String(runId || ""))}/events/list${query}`),
    {
      method: "GET",
      headers: toAuthHeader(authToken),
    }
  );
}

/**
 * Fetch runtime run status snapshot from the Sentinelayer API.
 *
 * @param {{ apiUrl: string, authToken: string, runId: string }} [options]
 * @returns {Promise<any>}
 */
/**
 * Fetch AIdenID credentials from the SentinelLayer API (lazy-provisioning).
 * The secret is returned in-memory only, never persisted to disk.
 */
export async function fetchAidenIdCredentials({
  apiUrl = DEFAULT_API_URL,
  token = "",
} = {}) {
  const response = await requestJson(
    buildApiPath(apiUrl, "/api/v1/aidenid/credentials"),
    {
      method: "GET",
      headers: toAuthHeader(token),
    }
  );
  return {
    orgId: String(response.orgId || response.org_id || "").trim(),
    projectId: String(response.projectId || response.project_id || "").trim(),
    apiKeyPrefix: String(response.apiKeyPrefix || response.api_key_prefix || "").trim(),
    apiKey: String(response.apiKey || response.api_key || "").trim(),
    provisioned: Boolean(response.provisioned),
  };
}

export async function getRuntimeRunStatus({
  apiUrl,
  authToken,
  runId,
} = {}) {
  return requestJson(
    buildApiPath(apiUrl, `/api/v1/runtime/runs/${encodeURIComponent(String(runId || ""))}/status`),
    {
      method: "GET",
      headers: toAuthHeader(authToken),
    }
  );
}
