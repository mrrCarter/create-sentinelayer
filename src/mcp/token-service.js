import process from "node:process";

import { DEFAULT_REQUEST_TIMEOUT_MS, requestJsonMutation } from "../auth/http.js";
import {
  DEFAULT_API_TOKEN_TTL_DAYS,
  DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS,
  resolveActiveAuthSession,
} from "../auth/service.js";
import { authLoginHint } from "../ui/command-hints.js";

function normalizePositiveNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    if (fallbackValue !== undefined) {
      return fallbackValue;
    }
    throw new Error(`${field} must be a positive number.`);
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(rawValue, field) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0 || !Number.isInteger(normalized)) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return normalized;
}

function buildApiPath(apiUrl, pathSuffix) {
  const base = String(apiUrl || "").replace(/\/+$/, "");
  const suffix = String(pathSuffix || "").replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

function toAuthHeader(token) {
  return {
    Authorization: `Bearer ${String(token || "").trim()}`,
  };
}

function applyScope(body, { scope = "", scopes } = {}) {
  const normalizedScope = String(scope || "").trim();
  const normalizedScopes = Array.isArray(scopes)
    ? scopes.map((item) => String(item || "").trim()).filter(Boolean)
    : String(scopes || "").trim();
  if (normalizedScope && normalizedScopes && (!Array.isArray(normalizedScopes) || normalizedScopes.length > 0)) {
    throw new Error("Use either scope or scopes, not both.");
  }
  if (normalizedScope) {
    body.scope = normalizedScope;
  } else if (Array.isArray(normalizedScopes) && normalizedScopes.length > 0) {
    body.scopes = normalizedScopes;
  } else if (typeof normalizedScopes === "string" && normalizedScopes) {
    body.scope = normalizedScopes;
  }
}

/**
 * Request a short-lived hosted MCP bearer credential.
 * The CLI authenticates with its existing Sentinelayer API token; the API
 * performs all credential minting server-side and returns the secret in-memory.
 *
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   explicitApiUrl?: string,
 *   autoRotate?: boolean,
 *   rotateThresholdDays?: number,
 *   tokenLabel?: string,
 *   tokenTtlDays?: number,
 *   homeDir?: string,
 *   scope?: string,
 *   scopes?: string[] | string,
 *   ttlSeconds?: number | string | null,
 *   timeoutMs?: number | string | null
 * }} [options]
 * @returns {Promise<{
 *   apiUrl: string,
 *   authSource: string,
 *   rotated: boolean,
 *   accessToken: string,
 *   tokenType: string,
 *   expiresIn: number,
 *   expiresAt: string,
 *   issuer: string,
 *   audience: string,
 *   scope: string
 * }>}
 */
export async function requestHostedMcpAccessToken({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  autoRotate = true,
  rotateThresholdDays = DEFAULT_TOKEN_ROTATE_THRESHOLD_DAYS,
  tokenLabel = "",
  tokenTtlDays = DEFAULT_API_TOKEN_TTL_DAYS,
  homeDir,
  scope = "",
  scopes,
  ttlSeconds = null,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
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
  if (!session || !session.token) {
    throw new Error(`Not authenticated. Run \`${authLoginHint()}\` first.`);
  }

  const body = {};
  applyScope(body, { scope, scopes });
  const normalizedTtlSeconds = normalizeOptionalPositiveInteger(ttlSeconds, "ttlSeconds");
  if (normalizedTtlSeconds !== null) {
    body.ttl_seconds = normalizedTtlSeconds;
  }
  const normalizedTimeoutMs = normalizePositiveNumber(timeoutMs, "timeoutMs", DEFAULT_REQUEST_TIMEOUT_MS);

  const response = await requestJsonMutation(
    buildApiPath(session.apiUrl, "/api/v1/auth/mcp-token"),
    {
      method: "POST",
      operationName: "mcp-token-mint",
      headers: toAuthHeader(session.token),
      body,
      timeoutMs: normalizedTimeoutMs,
    }
  );

  return {
    apiUrl: session.apiUrl,
    authSource: session.source,
    rotated: Boolean(session.rotated),
    accessToken: String(response.access_token || ""),
    tokenType: String(response.token_type || "Bearer"),
    expiresIn: Number(response.expires_in || 0),
    expiresAt: String(response.expires_at || ""),
    issuer: String(response.issuer || ""),
    audience: String(response.audience || ""),
    scope: String(response.scope || ""),
  };
}
