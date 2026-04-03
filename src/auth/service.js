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
  StoredSessionError,
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

function deterministicJitterFactor(sessionId, attempt) {
  const seed = `${String(sessionId || "").trim()}:${Number(attempt || 0)}`;
  const digest = crypto.createHash("sha256").update(seed).digest();
  const bucket = digest[0] / 255;
  return 0.8 + bucket * 0.4;
}

function throwIfAbortRequested(signal) {
  if (!signal || typeof signal !== "object" || !signal.aborted) {
    return;
  }
  throw new SentinelayerApiError("CLI authentication polling canceled by caller.", {
    status: 499,
    code: "CLI_AUTH_ABORTED",
  });
}

async function sleepWithAbortSignal(delayMs, signal) {
  throwIfAbortRequested(signal);
  if (!signal || typeof signal !== "object") {
    await sleep(delayMs);
    return;
  }
  await new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", onAbort);
      reject(
        new SentinelayerApiError("CLI authentication polling canceled by caller.", {
          status: 499,
          code: "CLI_AUTH_ABORTED",
        })
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, Number(delayMs) || 0));
  });
}

const TERMINAL_CLI_AUTH_POLL_STATUSES = new Map([
  ["denied", { httpStatus: 403, code: "CLI_AUTH_DENIED", message: "CLI authentication was denied." }],
  ["rejected", { httpStatus: 403, code: "CLI_AUTH_REJECTED", message: "CLI authentication was rejected." }],
  ["declined", { httpStatus: 403, code: "CLI_AUTH_DECLINED", message: "CLI authentication was declined." }],
  ["expired", { httpStatus: 410, code: "CLI_AUTH_EXPIRED", message: "CLI authentication request expired." }],
  ["cancelled", { httpStatus: 409, code: "CLI_AUTH_CANCELLED", message: "CLI authentication was cancelled." }],
  ["canceled", { httpStatus: 409, code: "CLI_AUTH_CANCELLED", message: "CLI authentication was cancelled." }],
  ["failed", { httpStatus: 502, code: "CLI_AUTH_FAILED", message: "CLI authentication failed." }],
  ["error", { httpStatus: 502, code: "CLI_AUTH_ERROR", message: "CLI authentication failed." }],
]);

function getAuthPollRequestId(payload = {}) {
  const candidate = payload.request_id ?? payload.requestId;
  const normalized = String(candidate || "").trim();
  return normalized || null;
}

function describePollStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  return normalized;
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
  signal = null,
}) {
  const timeout = normalizePositiveNumber(timeoutMs, "timeoutMs", DEFAULT_AUTH_TIMEOUT_MS);
  const deadline = Date.now() + timeout;
  let attempt = 0;

  while (Date.now() < deadline) {
    throwIfAbortRequested(signal);
    const payload = await requestJson(buildApiPath(apiUrl, "/api/v1/auth/cli/sessions/poll"), {
      method: "POST",
      body: {
        session_id: sessionId,
        challenge,
      },
      signal,
    });

    const status = String(payload.status || "pending").trim().toLowerCase();
    if (status === "approved" && payload.auth_token) {
      return payload;
    }
    if (TERMINAL_CLI_AUTH_POLL_STATUSES.has(status)) {
      const terminalConfig = TERMINAL_CLI_AUTH_POLL_STATUSES.get(status);
      const reason = String(payload.message || payload.error || payload.reason || "").trim();
      const message = reason ? `${terminalConfig.message} ${reason}` : terminalConfig.message;
      throw new SentinelayerApiError(message, {
        status: terminalConfig.httpStatus,
        code: terminalConfig.code,
        requestId: getAuthPollRequestId(payload),
      });
    }
    if (status !== "pending") {
      throw new SentinelayerApiError(
        `Unexpected CLI authentication session status '${describePollStatus(status)}'.`,
        {
          status: 502,
          code: "CLI_AUTH_UNEXPECTED_STATUS",
          requestId: getAuthPollRequestId(payload),
        }
      );
    }

    const serverPollIntervalMs = Math.max(
      250,
      Math.round(Number(payload.poll_interval_seconds || pollIntervalSeconds || 2) * 1000)
    );
    const backoffMultiplier = 2 ** Math.min(attempt, 5);
    const baseDelayMs = Math.min(serverPollIntervalMs * backoffMultiplier, 8_000);
    const jitterFactor = deterministicJitterFactor(sessionId, attempt);
    const remainingMs = Math.max(0, deadline - Date.now());
    const nextDelayMs = Math.max(250, Math.min(Math.round(baseDelayMs * jitterFactor), remainingMs));
    await sleepWithAbortSignal(nextDelayMs, signal);
    attempt += 1;
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

function isAuthorizationFailure(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return false;
  }
  const status = Number(error.status || 0);
  if (status === 401 || status === 403) {
    return true;
  }
  const code = String(error.code || "").trim().toUpperCase();
  return code === "AUTH_REQUIRED" || code === "FORBIDDEN" || code === "INVALID_TOKEN";
}

function resolveRevocationAuthCandidates(primaryToken, fallbackToken = "") {
  const candidates = [];
  for (const rawToken of [primaryToken, fallbackToken]) {
    const normalized = String(rawToken || "").trim();
    if (!normalized || candidates.includes(normalized)) {
      continue;
    }
    candidates.push(normalized);
  }
  return candidates;
}

async function revokeApiToken({ apiUrl, authToken, tokenId, fallbackAuthToken = "" }) {
  const normalizedTokenId = String(tokenId || "").trim();
  if (!normalizedTokenId) {
    return false;
  }
  const authCandidates = resolveRevocationAuthCandidates(authToken, fallbackAuthToken);
  if (authCandidates.length === 0) {
    throw new SentinelayerApiError("No revocation auth token available.", {
      status: 401,
      code: "AUTH_REQUIRED",
    });
  }

  const knownNotFoundCodes = new Set(["NOT_FOUND", "TOKEN_NOT_FOUND", "TOKEN_ALREADY_REVOKED"]);
  let lastError = null;
  for (let index = 0; index < authCandidates.length; index += 1) {
    const candidateToken = authCandidates[index];
    try {
      await requestJson(buildApiPath(apiUrl, `/api/v1/auth/api-tokens/${encodeURIComponent(normalizedTokenId)}`), {
        method: "DELETE",
        headers: toAuthHeader(candidateToken),
      });
      return true;
    } catch (error) {
      lastError = error;
      if (error instanceof SentinelayerApiError) {
        const status = Number(error.status || 0);
        const normalizedCode = String(error.code || "").trim().toUpperCase();
        const alreadyRevoked = status === 404 || status === 410;
        if (alreadyRevoked || knownNotFoundCodes.has(normalizedCode)) {
          return true;
        }
        const hasFallback = index < authCandidates.length - 1;
        if (hasFallback && isAuthorizationFailure(error)) {
          continue;
        }
      }
      throw error;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new SentinelayerApiError("Unable to revoke API token.", {
    status: 500,
    code: "TOKEN_REVOKE_FAILED",
  });
}

function isRetryableRevokeError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return false;
  }
  const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  return retryableStatuses.has(Number(error.status || 0));
}

function toRotationWarning(tokenId, error) {
  if (error instanceof SentinelayerApiError) {
    return {
      tokenId: normalizeString(tokenId) || null,
      code: error.code,
      status: error.status,
      message: error.message,
    };
  }
  return {
    tokenId: normalizeString(tokenId) || null,
    code: "UNKNOWN",
    status: 500,
    message: error instanceof Error ? error.message : String(error || "Unknown rotation error"),
  };
}

function toStoredSessionApiError(error) {
  if (error instanceof SentinelayerApiError) {
    return error;
  }
  if (error instanceof StoredSessionError) {
    return new SentinelayerApiError(error.message, {
      status: 401,
      code: error.code || "STORED_SESSION_INVALID",
    });
  }
  return error;
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
    let revokeWarning = null;
    const maxRevokeAttempts = 3;
    for (let attempt = 0; attempt < maxRevokeAttempts; attempt += 1) {
      try {
        await revokeApiToken({
          apiUrl: session.apiUrl,
          authToken: nextSession.token,
          fallbackAuthToken: session.token,
          tokenId: session.tokenId,
        });
        revokeWarning = null;
        break;
      } catch (error) {
        if (!isRetryableRevokeError(error)) {
          throw error;
        }
        revokeWarning = toRotationWarning(session.tokenId, error);
        if (attempt < maxRevokeAttempts - 1) {
          const delayMs = Math.min(200 * 2 ** attempt, 2000);
          await sleep(delayMs);
        }
      }
    }
    if (revokeWarning) {
      return {
        session: nextSession,
        rotated: true,
        rotationWarning: revokeWarning,
      };
    }
  }

  return {
    session: nextSession,
    rotated: true,
    rotationWarning: null,
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
 *   signal?: AbortSignal | null,
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
  signal = null,
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
    signal,
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

  const stored = await writeStoredSession(
    {
      apiUrl,
      token: String(issuedApiToken.token || ""),
      tokenId: issuedApiToken.id || null,
      tokenPrefix: issuedApiToken.token_prefix || null,
      tokenExpiresAt: issuedApiToken.expires_at || null,
      user,
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
 *   rotationWarning: null | { tokenId: string | null, code: string, status: number, message: string },
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
      rotationWarning: null,
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
      rotationWarning: null,
      filePath: null,
    };
  }

  let stored = null;
  try {
    stored = await readStoredSession({ homeDir });
  } catch (error) {
    throw toStoredSessionApiError(error);
  }
  if (!stored) {
    return null;
  }

  let active = stored;
  let rotated = false;
  let rotationWarning = null;
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
      rotationWarning = rotateResult.rotationWarning || null;
    } catch (error) {
      // Keep existing token if rotation fails.
      active = stored;
      rotated = false;
      rotationWarning = toRotationWarning(stored.tokenId, error);
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
    rotationWarning,
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
 *   rotationWarning: null | { tokenId: string | null, code: string, status: number, message: string },
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
      rotationWarning: null,
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
    rotationWarning: session.rotationWarning || null,
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
  let stored = null;
  try {
    stored = await readStoredSession({ homeDir });
  } catch (error) {
    throw toStoredSessionApiError(error);
  }
  if (stored && String(stored.tokenId || "").trim() === targetTokenId) {
    matchedStoredSession = true;
    const cleared = await clearStoredSession({ homeDir });
    clearedLocal = Boolean(cleared.clearedMetadata);
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
  let stored = null;
  try {
    stored = await readStoredSession({ homeDir });
  } catch (error) {
    if (error instanceof StoredSessionError) {
      const cleared = await clearStoredSession({ homeDir });
      return {
        hadStoredSession: Boolean(cleared.hadSession),
        revokedRemote: false,
        clearedLocal: Boolean(cleared.clearedMetadata),
        filePath: cleared.filePath,
      };
    }
    throw error;
  }
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
    clearedLocal: cleared.clearedMetadata,
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
